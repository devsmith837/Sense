"""
GolfSense - app.py
Flask + Flask-SocketIO server. Owns the active sensor connection (real
WitMotionSensor or DemoSensor), merges incoming frames into unified samples,
and streams them to the browser over WebSocket at 60fps while this module's
callers (later steps) can also access the full 200Hz stream for recording.
"""

import csv
import glob
import json
import os
import statistics
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime

from flask import Flask, send_from_directory
from flask_socketio import SocketIO

import sensor as sensor_mod
from swing_analyzer import SwingDetector
from ball_flight import predict_ball_flight
from diagnosis import diagnose_swing

HOST = "127.0.0.1"
PORT = 5000
DISPLAY_FPS = 60
SESSIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sessions")

app = Flask(__name__, static_folder="static", static_url_path="/static")
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")


class SensorManager:
    """Holds the single active sensor instance and the latest merged sample."""

    def __init__(self):
        self.lock = threading.Lock()
        self.active = None          # WitMotionSensor | DemoSensor | None
        self.active_port = None
        self.connected = False
        self.merged = {}            # latest value per field, flattened
        self.frame_count = 0
        # Locally-tracked config, since the BWT901CL register read-back
        # protocol isn't verified against real hardware here (see sensor.py
        # docstring). This reflects the last command WE sent, not a
        # confirmed hardware readback.
        self.config = {
            "rate": None, "bandwidth": None, "algorithm": None,
            "direction": None, "content": None,
        }
        self.swings = []
        self.session_face_angles = []
        self.swing_detector = SwingDetector(on_swing_complete=self._on_swing_complete)
        self.address_reference = None  # {"quat": (q0,q1,q2,q3), "roll","pitch","yaw"} once calibrated

    def on_frame(self, frame):
        with self.lock:
            ftype = frame.pop("type")
            self.merged["t"] = frame.get("t", time.time())
            for k, v in frame.items():
                if k != "t":
                    self.merged[f"{ftype}_{k}"] = v
            self.frame_count += 1

    def _on_swing_complete(self, swing):
        with self.lock:
            self.swings.append(swing)
        start_t = swing["start_t"]
        impact_idx = swing["arc_bottom_index"]
        key_moments = swing["key_moments"]

        ball_flight = None
        diagnosis_tips = []
        if impact_idx is not None and self.address_reference:
            samples = swing["samples"]
            impact_sample = samples[impact_idx]
            ref = self.address_reference
            face_angle_deg = (impact_sample.get("angle_roll") or 0.0) - ref["roll"]
            path_deg = (impact_sample.get("angle_yaw") or 0.0) - ref["yaw"]
            attack_angle_deg = (impact_sample.get("angle_pitch") or 0.0) - ref["pitch"]

            resultants = [
                (s.get("acc_ax", 0.0) ** 2 + s.get("acc_ay", 0.0) ** 2 + s.get("acc_az", 0.0) ** 2) ** 0.5
                for s in samples
            ]
            peak_resultant_g = max(resultants)
            peak_idx = max(range(impact_idx + 1), key=lambda i: resultants[i])
            decelerating = impact_idx > 0 and (impact_idx - peak_idx) / impact_idx > 0.15

            arc_bottom_early = bool(key_moments) and impact_idx <= key_moments["transition"]

            tempo_ratio = None
            if key_moments:
                backswing_s = samples[key_moments["top_backswing"]]["t"] - samples[key_moments["address"]]["t"]
                downswing_s = samples[impact_idx]["t"] - samples[key_moments["top_backswing"]]["t"]
                if downswing_s > 0:
                    tempo_ratio = backswing_s / downswing_s

            with self.lock:
                self.session_face_angles.append(face_angle_deg)
                session_std = (
                    statistics.stdev(self.session_face_angles)
                    if len(self.session_face_angles) >= 3 else None
                )

            ball_flight = predict_ball_flight(
                face_angle_deg, path_deg, attack_angle_deg,
                heel_toe_deg=face_angle_deg, high_low_deg=attack_angle_deg,
                peak_resultant_g=peak_resultant_g,
            )
            diagnosis_tips = diagnose_swing({
                "face_angle_deg": face_angle_deg, "path_deg": path_deg,
                "heel_toe_deg": face_angle_deg, "attack_angle_deg": attack_angle_deg,
                "decelerating": decelerating, "arc_bottom_early": arc_bottom_early,
                "tempo_ratio": tempo_ratio, "session_face_std": session_std,
            })

        payload = {
            "index": swing["index"],
            "duration": swing["duration"],
            "sample_count": len(swing["samples"]),
            "arc_bottom_found": swing["arc_bottom_index"] is not None,
            "arc_bottom_index": swing["arc_bottom_index"],
            "key_moments": swing["key_moments"],
            "address_reference": self.address_reference,
            "ball_flight": ball_flight,
            "diagnosis": diagnosis_tips,
            "samples": [
                {
                    "t": s["t"] - start_t,
                    "roll": s.get("angle_roll"), "pitch": s.get("angle_pitch"), "yaw": s.get("angle_yaw"),
                    "q0": s.get("quat_q0"), "q1": s.get("quat_q1"), "q2": s.get("quat_q2"), "q3": s.get("quat_q3"),
                    "ax": s.get("acc_ax"), "ay": s.get("acc_ay"), "az": s.get("acc_az"),
                }
                for s in swing["samples"]
            ],
        }
        print(f"[swing_captured] index={payload['index']} duration={payload['duration']:.2f} "
              f"samples={payload['sample_count']} arc_bottom_found={payload['arc_bottom_found']}")
        socketio.emit("swing_captured", payload)

    def on_status(self, status):
        with self.lock:
            self.connected = status.get("connected", False)
            if self.connected:
                self.active_port = status.get("port", self.active_port)
            else:
                self.active_port = None
        socketio.emit("connection_status", {
            "connected": self.connected,
            "port": self.active_port,
        })

    def connect(self, port):
        self.disconnect()
        if port == "DEMO":
            s = sensor_mod.DemoSensor(on_frame=self.on_frame, on_status=self.on_status)
        else:
            s = sensor_mod.WitMotionSensor(on_frame=self.on_frame, on_status=self.on_status)
        with self.lock:
            self.active = s
            self.active_port = port
            self.merged = {}
            self.frame_count = 0
            self.address_reference = None
            self.swings = []
            self.session_face_angles = []
        socketio.emit("calibration_status", {"calibrated": False})
        s.connect(port)
        if port != "DEMO":
            s.configure_for_golf()
        with self.lock:
            self.config = {
                "rate": 200, "bandwidth": 256, "algorithm": "6-axis",
                "direction": "horizontal",
                "content": ["time", "acc", "gyro", "angle", "mag", "quaternion"],
            }
        socketio.emit("config_state", self.config)
        threading.Thread(target=self._auto_calibrate_after_connect, args=(s,), daemon=True).start()

    def _auto_calibrate_after_connect(self, connecting_sensor):
        """
        Calibrates immediately once the first full sample is available,
        with no manual button press - the user is expected to already be
        holding the club at address when they hit Connect. Grabs whatever
        orientation is present at that instant rather than waiting for the
        club to settle; the Calibrate button remains available afterward
        to manually re-zero mid-session if drift occurs or address wasn't
        held yet when this fired.
        """
        deadline = time.time() + 3.0
        required = ("quat_q0", "quat_q1", "quat_q2", "quat_q3", "angle_roll", "angle_pitch", "angle_yaw")
        while time.time() < deadline:
            if self.active is not connecting_sensor:
                return  # disconnected/reconnected before this sensor produced data
            sample = self.snapshot()
            if all(k in sample for k in required):
                reference = self.calibrate_address()
                socketio.emit("calibration_status", {
                    "calibrated": reference is not None, "reference": reference, "auto": True,
                })
                return
            time.sleep(0.05)

    def disconnect(self):
        with self.lock:
            s = self.active
            self.active = None
        if s:
            s.disconnect()

    def snapshot(self):
        with self.lock:
            return dict(self.merged)

    def calibrate_address(self):
        """
        "Calibrate / Set Zero": sends the sensor's Set Angle Reference
        command and records the current quaternion/angles as the address
        reference. All subsequent golf-view angle measurements are relative
        deltas from this reference.
        """
        sample = self.snapshot()
        required = ("quat_q0", "quat_q1", "quat_q2", "quat_q3", "angle_roll", "angle_pitch", "angle_yaw")
        if not all(k in sample for k in required):
            return None
        reference = {
            "quat": (sample["quat_q0"], sample["quat_q1"], sample["quat_q2"], sample["quat_q3"]),
            "roll": sample["angle_roll"], "pitch": sample["angle_pitch"], "yaw": sample["angle_yaw"],
        }
        with self.lock:
            self.address_reference = reference
        self.swing_detector.set_address_reference(reference["pitch"])
        s = self.active
        if s:
            s.set_angle_reference()
        return reference


class Recorder:
    """
    Captures the full 200Hz sample stream to a timestamped .gsw file while
    active. .gsw here is a simple newline-delimited-JSON format (one merged
    sample per line) - not a real WitMotion binary layout (that format isn't
    published/available to build against), but it's self-describing, easy
    to replay or convert to CSV, and structurally serves the same purpose:
    a complete per-sample record of one recording session.
    """

    def __init__(self):
        self.recording = False
        self.buffer = []
        self.start_time = None

    def start(self):
        self.recording = True
        self.buffer = []
        self.start_time = time.time()

    def add_sample(self, sample):
        if self.recording:
            self.buffer.append(dict(sample))

    def status(self):
        duration = (self.buffer[-1]["t"] - self.buffer[0]["t"]) if len(self.buffer) > 1 else 0.0
        return {"recording": self.recording, "sample_count": len(self.buffer), "duration": duration}

    def stop(self):
        self.recording = False
        if not self.buffer:
            return None
        os.makedirs(SESSIONS_DIR, exist_ok=True)
        ts = datetime.fromtimestamp(self.start_time).strftime("%Y%m%d_%H%M%S")
        filename = f"session_{ts}.gsw"
        filepath = os.path.join(SESSIONS_DIR, filename)
        with open(filepath, "w") as f:
            for s in self.buffer:
                f.write(json.dumps(s) + "\n")
        duration = self.buffer[-1]["t"] - self.buffer[0]["t"] if len(self.buffer) > 1 else 0.0
        result = {
            "filename": filename, "duration": duration,
            "sample_count": len(self.buffer), "size_bytes": os.path.getsize(filepath),
        }
        self.buffer = []
        return result


class PlaybackController:
    """
    Replays a recorded .gsw file back through the same sensor_data broadcast
    and swing detector the live pipeline uses, so every view - including the
    GolfSense golf panels - works during playback exactly as it would live.
    """

    def __init__(self):
        self.samples = []
        self.filename = None
        self.index = 0
        self.playing = False
        self.paused = False
        self.speed = 1.0
        self._thread = None

    def load(self, filename):
        filepath = os.path.join(SESSIONS_DIR, filename)
        samples = []
        with open(filepath) as f:
            for line in f:
                line = line.strip()
                if line:
                    samples.append(json.loads(line))
        self.samples = samples
        self.filename = filename
        self.index = 0
        return len(samples)

    def play(self):
        if self._thread and self._thread.is_alive():
            self.paused = False
            return
        self.playing = True
        self.paused = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def pause(self):
        self.paused = True

    def stop(self):
        self.playing = False
        self.index = 0

    def set_speed(self, speed):
        self.speed = speed

    def _run(self):
        manager.swing_detector._reset()
        last_t = None
        start_idx = self.index
        for i in range(start_idx, len(self.samples)):
            if not self.playing:
                break
            while self.paused and self.playing:
                time.sleep(0.05)
            if not self.playing:
                break
            sample = self.samples[i]
            self.index = i
            if last_t is not None:
                dt = (sample["t"] - last_t) / max(0.1, self.speed)
                if dt > 0:
                    time.sleep(min(dt, 0.5))
            last_t = sample["t"]
            sample_copy = dict(sample)
            sample_copy["swinging"] = manager.swing_detector.state == "swinging"
            socketio.emit("sensor_data", sample_copy)
            socketio.emit("playback_progress", {"index": i, "total": len(self.samples)})
            manager.swing_detector.feed(dict(sample))
        self.playing = False
        socketio.emit("playback_status", {"playing": False, "index": self.index, "total": len(self.samples)})


manager = SensorManager()
recorder = Recorder()
playback = PlaybackController()


def list_ports_with_demo():
    ports = sensor_mod.scan_ports()
    ports.append({
        "port": "DEMO",
        "description": "GolfSense Demo Sensor (simulated, no hardware required)",
        "vid": None, "pid": None, "vid_pid_hint": "demo",
        "witmotion_confirmed": True,
        "signal_strength": "strong",
    })
    return ports


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/sessions/<path:filename>")
def download_session_file(filename):
    return send_from_directory(SESSIONS_DIR, filename, as_attachment=True)


@socketio.on("connect")
def handle_client_connect():
    socketio.emit("connection_status", {
        "connected": manager.connected,
        "port": manager.active_port,
    })
    socketio.emit("calibration_status", {"calibrated": manager.address_reference is not None})
    socketio.emit("recording_list", {"files": list_recordings()})


@socketio.on("calibrate_address")
def handle_calibrate_address():
    def worker():
        reference = manager.calibrate_address()
        socketio.emit("calibration_status", {
            "calibrated": reference is not None,
            "reference": reference,
        })
    threading.Thread(target=worker, daemon=True).start()


@socketio.on("scan_ports")
def handle_scan_ports():
    def worker():
        ports = list_ports_with_demo()
        socketio.emit("port_list", {"ports": ports})
    threading.Thread(target=worker, daemon=True).start()


@socketio.on("connect_port")
def handle_connect_port(data):
    port = (data or {}).get("port")
    if not port:
        return
    threading.Thread(target=manager.connect, args=(port,), daemon=True).start()


@socketio.on("disconnect_port")
def handle_disconnect_port():
    threading.Thread(target=manager.disconnect, daemon=True).start()


def _with_sensor(fn):
    """Run fn(sensor) in a background thread if a sensor is connected."""
    s = manager.active
    if not s:
        return
    threading.Thread(target=fn, args=(s,), daemon=True).start()


def _update_config(**kwargs):
    with manager.lock:
        manager.config.update(kwargs)
    socketio.emit("config_state", manager.config)


@socketio.on("config_set_rate")
def handle_set_rate(data):
    hz = (data or {}).get("hz")
    _with_sensor(lambda s: s.set_output_rate(hz))
    _update_config(rate=hz)


@socketio.on("config_set_bandwidth")
def handle_set_bandwidth(data):
    hz = (data or {}).get("hz")
    _with_sensor(lambda s: s.set_bandwidth(hz))
    _update_config(bandwidth=hz)


@socketio.on("config_set_algorithm")
def handle_set_algorithm(data):
    axis6 = bool((data or {}).get("axis6", True))
    _with_sensor(lambda s: s.set_algorithm(axis6=axis6))
    _update_config(algorithm="6-axis" if axis6 else "9-axis")


@socketio.on("config_set_direction")
def handle_set_direction(data):
    vertical = bool((data or {}).get("vertical", False))
    _with_sensor(lambda s: s.set_install_direction(vertical=vertical))
    _update_config(direction="vertical" if vertical else "horizontal")


@socketio.on("config_set_content")
def handle_set_content(data):
    fields = (data or {}).get("fields", [])
    _with_sensor(lambda s: s.set_output_content(fields))
    _update_config(content=fields)


@socketio.on("config_reset_z")
def handle_reset_z():
    _with_sensor(lambda s: s.reset_z_axis())


@socketio.on("config_set_angle_ref")
def handle_set_angle_ref():
    _with_sensor(lambda s: s.set_angle_reference())


@socketio.on("config_start_accel_cal")
def handle_start_accel_cal():
    _with_sensor(lambda s: s.start_accel_calibration())


@socketio.on("config_stop_accel_cal")
def handle_stop_accel_cal():
    _with_sensor(lambda s: s.stop_accel_calibration())


@socketio.on("config_start_mag_cal")
def handle_start_mag_cal():
    _with_sensor(lambda s: s.start_mag_calibration())


@socketio.on("config_stop_mag_cal")
def handle_stop_mag_cal():
    _with_sensor(lambda s: s.stop_mag_calibration())


@socketio.on("config_save")
def handle_config_save():
    _with_sensor(lambda s: s.save_config())


@socketio.on("config_factory_reset")
def handle_config_factory_reset():
    _with_sensor(lambda s: s.factory_reset())


@socketio.on("config_read")
def handle_config_read():
    socketio.emit("config_state", manager.config)


def swing_feed_loop():
    """
    Feed the swing detector from a controlled, evenly-paced 200Hz sampler
    rather than on every raw frame arrival. The five WitMotion packet types
    (acc/gyro/angle/quat/mag) land within the same merged sample at
    microsecond spacing followed by a millisecond-scale gap to the next
    update - that bursty timing breaks the median-dt sample-rate estimate
    used for the arc-bottom Butterworth filter. Sampling on our own clock
    keeps timestamps uniform regardless of upstream packet timing.
    """
    interval = 1.0 / 200.0
    last_status_emit = 0.0
    while True:
        start = time.time()
        sample = manager.snapshot()
        if sample:
            sample["t"] = start
            manager.swing_detector.feed(sample)
            recorder.add_sample(sample)
        if recorder.recording and start - last_status_emit >= 0.25:
            last_status_emit = start
            socketio.emit("recording_status", recorder.status())
        elapsed = time.time() - start
        time.sleep(max(0.0, interval - elapsed))


def list_recordings():
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    files = []
    for path in sorted(glob.glob(os.path.join(SESSIONS_DIR, "*.gsw")), reverse=True):
        stat = os.stat(path)
        line_count = sum(1 for _ in open(path))
        files.append({
            "filename": os.path.basename(path),
            "size_bytes": stat.st_size,
            "mtime": stat.st_mtime,
            "sample_count": line_count,
        })
    return files


@socketio.on("recording_start")
def handle_recording_start():
    recorder.start()
    socketio.emit("recording_status", recorder.status())


@socketio.on("recording_stop")
def handle_recording_stop():
    result = recorder.stop()
    socketio.emit("recording_status", {"recording": False, "sample_count": 0, "duration": 0})
    socketio.emit("recording_saved", result)
    socketio.emit("recording_list", {"files": list_recordings()})


@socketio.on("list_recordings")
def handle_list_recordings():
    socketio.emit("recording_list", {"files": list_recordings()})


@socketio.on("load_recording")
def handle_load_recording(data):
    filename = (data or {}).get("filename")
    if not filename:
        return
    count = playback.load(filename)
    socketio.emit("playback_loaded", {"filename": filename, "total": count})


@socketio.on("playback_play")
def handle_playback_play():
    threading.Thread(target=playback.play, daemon=True).start()


@socketio.on("playback_pause")
def handle_playback_pause():
    playback.pause()


@socketio.on("playback_stop")
def handle_playback_stop():
    playback.stop()


@socketio.on("playback_set_speed")
def handle_playback_set_speed(data):
    speed = (data or {}).get("speed", 1.0)
    playback.set_speed(float(speed))


@socketio.on("export_csv")
def handle_export_csv(data):
    filename = (data or {}).get("filename")
    if not filename:
        return
    src_path = os.path.join(SESSIONS_DIR, filename)
    csv_filename = filename.rsplit(".", 1)[0] + ".csv"
    csv_path = os.path.join(SESSIONS_DIR, csv_filename)
    fieldnames = [
        "t", "acc_ax", "acc_ay", "acc_az", "gyro_wx", "gyro_wy", "gyro_wz",
        "angle_roll", "angle_pitch", "angle_yaw", "mag_hx", "mag_hy", "mag_hz",
        "quat_q0", "quat_q1", "quat_q2", "quat_q3",
    ]
    with open(src_path) as src, open(csv_path, "w", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for line in src:
            line = line.strip()
            if line:
                writer.writerow(json.loads(line))
    socketio.emit("csv_exported", {"filename": csv_filename})


def broadcast_loop():
    interval = 1.0 / DISPLAY_FPS
    last_count = 0
    last_fps_t = time.time()
    while True:
        start = time.time()
        sample = manager.snapshot()
        if sample:
            sample["swinging"] = manager.swing_detector.state == "swinging"
            socketio.emit("sensor_data", sample)
        if start - last_fps_t >= 1.0:
            fps = manager.frame_count - last_count
            last_count = manager.frame_count
            last_fps_t = start
            socketio.emit("frame_rate", {"hz": fps})
        elapsed = time.time() - start
        time.sleep(max(0.0, interval - elapsed))


def launch_chrome(url):
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            subprocess.Popen([path, "--new-window", "--start-fullscreen", url])
            return
    webbrowser.open(url)


if __name__ == "__main__":
    url = f"http://{HOST}:{PORT}"
    threading.Thread(target=broadcast_loop, daemon=True).start()
    threading.Thread(target=swing_feed_loop, daemon=True).start()

    if "--no-browser" not in sys.argv:
        threading.Timer(1.2, launch_chrome, args=(url,)).start()

    print(f"GolfSense server starting at {url}")
    socketio.run(app, host=HOST, port=PORT, debug=False, use_reloader=False,
                 allow_unsafe_werkzeug=True)
