"""
GolfSense - sensor.py
COM port auto-discovery + WitMotion BWT901CL binary protocol parser/driver.

Protocol reference: WitMotion "0x55" active-push frame format, used across the
JY901/WT901/BWT901 product family. Frame = 11 bytes:
    [0x55] [flag] [d0L d0H d1L d1H d2L d2H d3L d3H] [checksum]
checksum = sum(bytes[0:10]) & 0xFF

Config/command frames are 5 bytes: [0xFF] [0xAA] [register] [dataL] [dataH]

NOTE: Packet *parsing* below (0x51/0x52/0x53/0x54/0x59/0x50) is the stable,
widely-documented part of the protocol and should work against any BWT901CL.
The *config register addresses* (rate/bandwidth/algorithm/direction/output
content/calibration) follow the commonly published WitMotion command set,
but firmware revisions occasionally shift a register address. If a specific
config command doesn't visibly change sensor behavior on your unit, cross
check the register address against the official WitMotion serial protocol
document for BWT901CL - this module has no way to verify those against real
firmware without the physical device in hand.
"""

import math
import random
import struct
import threading
import time

import serial
from serial.tools import list_ports

HEADER = 0x55

FLAG_TIME = 0x50
FLAG_ACC = 0x51
FLAG_GYRO = 0x52
FLAG_ANGLE = 0x53
FLAG_MAG = 0x54
FLAG_QUATERNION = 0x59

ACC_SCALE = 16.0 / 32768.0          # g
GYRO_SCALE = 2000.0 / 32768.0       # deg/s
ANGLE_SCALE = 180.0 / 32768.0       # deg
QUAT_SCALE = 1.0 / 32768.0          # unitless (-1..1)
TEMP_SCALE = 1.0 / 100.0            # deg C

# Known USB-serial bridge chips commonly used in WitMotion HID dongles.
KNOWN_VID_PID = {
    (0x1A86, 0x7523): "CH340 (WitMotion dongle likely)",
    (0x10C4, 0xEA60): "CP210x (WitMotion dongle likely)",
    (0x0403, 0x6001): "FTDI (WitMotion dongle likely)",
}

BAUD = 115200

# --- config command registers (see module docstring caveat) ---
REG_SAVE = 0x00
REG_CALSW = 0x01
REG_OUTPUT_CONTENT = 0x02
REG_RATE = 0x03
REG_DIRECTION = 0x23
REG_ALGORITHM = 0x24
REG_BANDWIDTH = 0x1F

UNLOCK_FRAME = bytes([0xFF, 0xAA, 0x69, 0x88, 0xB5])

RATE_CODES = {
    0.2: 0x01, 0.5: 0x02, 1: 0x03, 2: 0x04, 5: 0x05, 10: 0x06,
    20: 0x07, 50: 0x08, 100: 0x09, 125: 0x0A, 200: 0x0B,
}

BANDWIDTH_CODES = {256: 0x00, 188: 0x01, 98: 0x02, 42: 0x03, 20: 0x04, 10: 0x05, 5: 0x06}

# Output content bitmask (bit position -> field), best-effort per common FW.
CONTENT_BITS = {
    "time": 0, "acc": 1, "gyro": 2, "angle": 3,
    "mag": 4, "quaternion": 6,
}


def _checksum_ok(frame):
    return (sum(frame[0:10]) & 0xFF) == frame[10]


def _s16(lo, hi):
    return struct.unpack("<h", bytes([lo, hi]))[0]


class BWT901Parser:
    """Stateful byte-stream parser. Feed raw bytes, get back decoded frames."""

    def __init__(self):
        self._buf = bytearray()

    def feed(self, data: bytes):
        """Append incoming bytes and return a list of decoded frame dicts."""
        self._buf.extend(data)
        out = []
        while True:
            # resync: drop bytes until buffer starts with header
            while self._buf and self._buf[0] != HEADER:
                self._buf.pop(0)
            if len(self._buf) < 11:
                break
            frame = bytes(self._buf[0:11])
            if not _checksum_ok(frame):
                # bad checksum - drop just the header byte and resync
                self._buf.pop(0)
                continue
            del self._buf[0:11]
            decoded = self._decode(frame)
            if decoded:
                out.append(decoded)
        return out

    @staticmethod
    def _decode(frame):
        flag = frame[1]
        d = frame[2:10]
        v0 = _s16(d[0], d[1])
        v1 = _s16(d[2], d[3])
        v2 = _s16(d[4], d[5])
        v3 = _s16(d[6], d[7])
        now = time.time()

        if flag == FLAG_ACC:
            return {"type": "acc", "t": now,
                    "ax": v0 * ACC_SCALE, "ay": v1 * ACC_SCALE, "az": v2 * ACC_SCALE,
                    "temp": v3 * TEMP_SCALE}
        if flag == FLAG_GYRO:
            return {"type": "gyro", "t": now,
                    "wx": v0 * GYRO_SCALE, "wy": v1 * GYRO_SCALE, "wz": v2 * GYRO_SCALE,
                    "temp": v3 * TEMP_SCALE}
        if flag == FLAG_ANGLE:
            return {"type": "angle", "t": now,
                    "roll": v0 * ANGLE_SCALE, "pitch": v1 * ANGLE_SCALE, "yaw": v2 * ANGLE_SCALE,
                    "temp": v3 * TEMP_SCALE}
        if flag == FLAG_MAG:
            return {"type": "mag", "t": now, "hx": v0, "hy": v1, "hz": v2, "temp": v3 * TEMP_SCALE}
        if flag == FLAG_QUATERNION:
            return {"type": "quat", "t": now,
                    "q0": v0 * QUAT_SCALE, "q1": v1 * QUAT_SCALE,
                    "q2": v2 * QUAT_SCALE, "q3": v3 * QUAT_SCALE}
        if flag == FLAG_TIME:
            yy, mm, dd, hh, mi, ss = d[0], d[1], d[2], d[3], d[4], d[5]
            ms = _s16(d[6], d[7]) & 0xFFFF
            return {"type": "time", "t": now,
                    "year": yy, "month": mm, "day": dd,
                    "hour": hh, "minute": mi, "second": ss, "ms": ms}
        return None


def scan_ports(probe_seconds=1.2):
    """
    Enumerate all COM ports and probe each at 115200 baud for valid WitMotion
    0x55-header frames. Returns a list of dicts describing each port, sorted
    with confirmed WitMotion devices first.
    """
    results = []
    for p in list_ports.comports():
        vid_pid_hint = None
        if p.vid is not None and p.pid is not None:
            vid_pid_hint = KNOWN_VID_PID.get((p.vid, p.pid))

        confirmed = False
        frame_count = 0
        bytes_seen = 0
        try:
            with serial.Serial(p.device, BAUD, timeout=0.2) as ser:
                parser = BWT901Parser()
                deadline = time.time() + probe_seconds
                while time.time() < deadline:
                    chunk = ser.read(256)
                    if chunk:
                        bytes_seen += len(chunk)
                        frames = parser.feed(chunk)
                        frame_count += len(frames)
                        if frame_count >= 3:
                            confirmed = True
                            break
        except (serial.SerialException, OSError):
            pass

        # crude signal-strength proxy: how much of the probe window produced
        # valid decoded frames vs. silence/garbage
        if confirmed:
            strength = "strong" if frame_count >= 10 else "ok"
        elif bytes_seen > 0:
            strength = "weak"
        else:
            strength = "none"

        results.append({
            "port": p.device,
            "description": p.description or "Unknown device",
            "vid": p.vid, "pid": p.pid,
            "vid_pid_hint": vid_pid_hint,
            "witmotion_confirmed": confirmed,
            "signal_strength": strength,
        })

    results.sort(key=lambda r: (not r["witmotion_confirmed"], r["signal_strength"] != "strong"))
    return results


class WitMotionSensor:
    """
    Manages one BWT901CL connection: background read thread decodes frames
    and dispatches them to a callback; public methods send config/calibration
    commands.
    """

    def __init__(self, on_frame=None, on_status=None):
        self.on_frame = on_frame or (lambda frame: None)
        self.on_status = on_status or (lambda status: None)
        self._ser = None
        self._parser = BWT901Parser()
        self._thread = None
        self._running = False
        self.port = None
        self.connected = False

    # --- connection lifecycle ---

    def connect(self, port, baud=BAUD):
        self.disconnect()
        self._ser = serial.Serial(port, baud, timeout=0.05)
        self.port = port
        self.connected = True
        self._running = True
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()
        self.on_status({"connected": True, "port": port})

    def disconnect(self):
        was_connected = self.connected
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        if self._ser and self._ser.is_open:
            self._ser.close()
        self._ser = None
        self.connected = False
        if was_connected:
            self.on_status({"connected": False, "port": self.port})

    def _read_loop(self):
        while self._running and self._ser and self._ser.is_open:
            try:
                chunk = self._ser.read(256)
            except (serial.SerialException, OSError):
                break
            if chunk:
                for frame in self._parser.feed(chunk):
                    self.on_frame(frame)
        self.connected = False

    # --- command helpers ---

    def _send(self, register, value):
        if not self._ser or not self._ser.is_open:
            return
        lo = value & 0xFF
        hi = (value >> 8) & 0xFF
        self._ser.write(UNLOCK_FRAME)
        time.sleep(0.02)
        self._ser.write(bytes([0xFF, 0xAA, register, lo, hi]))
        time.sleep(0.02)

    def save_config(self):
        self._send(REG_SAVE, 0x0000)

    def set_output_rate(self, hz):
        code = RATE_CODES.get(hz)
        if code is not None:
            self._send(REG_RATE, code)

    def set_bandwidth(self, hz):
        code = BANDWIDTH_CODES.get(hz)
        if code is not None:
            self._send(REG_BANDWIDTH, code)

    def set_algorithm(self, axis6=True):
        self._send(REG_ALGORITHM, 0x0000 if axis6 else 0x0001)

    def set_install_direction(self, vertical=False):
        self._send(REG_DIRECTION, 0x0001 if vertical else 0x0000)

    def set_output_content(self, fields):
        mask = 0
        for name in fields:
            bit = CONTENT_BITS.get(name)
            if bit is not None:
                mask |= (1 << bit)
        self._send(REG_OUTPUT_CONTENT, mask)

    def reset_z_axis(self):
        self._send(REG_CALSW, 0x0004)
        time.sleep(0.1)
        self._send(REG_CALSW, 0x0000)

    def set_angle_reference(self):
        self.reset_z_axis()

    def start_accel_calibration(self):
        self._send(REG_CALSW, 0x0001)

    def stop_accel_calibration(self):
        self._send(REG_CALSW, 0x0000)
        self.save_config()

    def start_mag_calibration(self):
        self._send(REG_CALSW, 0x0002)

    def stop_mag_calibration(self):
        self._send(REG_CALSW, 0x0000)
        self.save_config()

    def factory_reset(self):
        self._send(0x0001, 0x0001)
        self.save_config()

    def configure_for_golf(self):
        """Apply the standard GolfSense startup configuration."""
        self.set_output_rate(200)
        self.set_bandwidth(256)
        self.set_algorithm(axis6=True)
        self.set_output_content(["time", "acc", "gyro", "angle", "mag", "quaternion"])
        self.reset_z_axis()
        self.save_config()


def euler_to_quaternion(roll_deg, pitch_deg, yaw_deg):
    """ZYX Euler (deg) -> quaternion (q0 scalar, q1, q2, q3), for synthetic data only."""
    r = math.radians(roll_deg) * 0.5
    p = math.radians(pitch_deg) * 0.5
    y = math.radians(yaw_deg) * 0.5
    cr, sr = math.cos(r), math.sin(r)
    cp, sp = math.cos(p), math.sin(p)
    cy, sy = math.cos(y), math.sin(y)
    q0 = cr * cp * cy + sr * sp * sy
    q1 = sr * cp * cy - cr * sp * sy
    q2 = cr * sp * cy + sr * cp * sy
    q3 = cr * cp * sy - sr * sp * cy
    return q0, q1, q2, q3


# A scripted synthetic swing: (t_seconds, roll, pitch, yaw, accel_g) keyframes
# covering address -> takeaway -> top -> transition -> impact -> follow-through.
# Roll models face angle (open/closed), pitch models attack-angle-relevant tilt,
# yaw models the swing-plane heading component. Purely for demo/testing use
# without physical hardware - not derived from any real swing capture.
_DEMO_SWING_KEYFRAMES = [
    (0.00, 0.0, 0.0, 0.0, 1.0),
    (0.15, 2.0, 5.0, 8.0, 1.6),
    (0.45, 4.0, 20.0, 45.0, 1.45),
    (0.70, 3.0, 35.0, 95.0, 1.45),
    (0.85, -1.0, 25.0, 60.0, 1.8),
    (0.95, 0.5, 5.0, 15.0, 4.2),
    (1.00, 1.0, 0.0, 2.0, 3.5),
    (1.05, 1.5, -5.0, -10.0, 2.0),
    (1.30, 3.0, -20.0, -40.0, 1.4),
    (1.60, 0.5, -8.0, -15.0, 1.05),
    (1.90, 0.0, 0.0, 0.0, 1.0),
]

def _interp_keyframes(t, keyframes):
    if t <= keyframes[0][0]:
        return keyframes[0][1:]
    if t >= keyframes[-1][0]:
        return keyframes[-1][1:]
    for (t0, *v0), (t1, *v1) in zip(keyframes, keyframes[1:]):
        if t0 <= t <= t1:
            f = 0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(a + (b - a) * f for a, b in zip(v0, v1))
    return keyframes[-1][1:]


# World-frame vertical velocity profile (m/s) layered on top of the
# orientation-driven acceleration above: ~0 through address/backswing, dips
# during the downswing (descending), crosses back through 0 around t=1.00s
# (arc bottom - matches pitch also returning near 0 in _DEMO_SWING_KEYFRAMES
# at that same instant), then rises during the follow-through. Its
# derivative is added to the body acceleration so arc-bottom detection
# (which looks for world-vertical acceleration crossing negative to
# positive) has a genuine, well-timed crossing - the orientation-only
# acceleration above has no consistent vertical-velocity signature of its
# own to detect.
_DEMO_VERT_VEL_KEYFRAMES = [
    (0.00, 0.0),
    (0.80, 0.0),
    (0.90, -2.0),
    (1.00, 0.0),
    (1.10, 1.5),
    (1.30, 0.5),
    (1.60, 0.0),
    (1.90, 0.0),
]


def _demo_vertical_accel_g(st, h=0.01):
    """Central-difference derivative of _DEMO_VERT_VEL_KEYFRAMES, in g."""
    v_plus = _interp_keyframes(st + h, _DEMO_VERT_VEL_KEYFRAMES)[0]
    v_minus = _interp_keyframes(max(0.0, st - h), _DEMO_VERT_VEL_KEYFRAMES)[0]
    return (v_plus - v_minus) / (2 * h) / 9.80665


def _demo_angular_velocity_dps(st, h=0.01):
    """Central-difference derivative of the roll/pitch/yaw keyframes, in
    deg/s - genuine angular velocity, not a value proportional to the angle
    itself. This matters for anything that reads the swing's rotation rate
    (e.g. detecting the top of the backswing as a local minimum of gyro
    magnitude, where the club momentarily pauses before the downswing)."""
    r0, p0, y0, _ = _interp_keyframes(max(0.0, st - h), _DEMO_SWING_KEYFRAMES)
    r1, p1, y1, _ = _interp_keyframes(st + h, _DEMO_SWING_KEYFRAMES)
    return (r1 - r0) / (2 * h), (p1 - p0) / (2 * h), (y1 - y0) / (2 * h)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _quat_rotate_vector(q0, q1, q2, q3, v):
    """Rotate vector v by quaternion (q0 scalar). Pass -q1,-q2,-q3 for the
    inverse (conjugate) rotation - e.g. world-frame vector into body frame."""
    qv = (q1, q2, q3)
    t = tuple(2 * x for x in _cross(qv, v))
    ct = _cross(qv, t)
    return (v[0] + q0 * t[0] + ct[0], v[1] + q0 * t[1] + ct[1], v[2] + q0 * t[2] + ct[2])


class DemoSensor:
    """
    Synthetic BWT901CL stand-in with the same public interface as
    WitMotionSensor, so the rest of the app (Flask/WebSocket/frontend) can be
    fully developed and tested without physical hardware. Generates idle
    drift plus a scripted swing motion every ~6 seconds.
    """

    def __init__(self, on_frame=None, on_status=None):
        self.on_frame = on_frame or (lambda frame: None)
        self.on_status = on_status or (lambda status: None)
        self.port = "DEMO"
        self.connected = False
        self._running = False
        self._thread = None
        self._swing_start = None
        self._next_swing_at = 3.0

    def connect(self, port=None, baud=None):
        self.disconnect()
        self.connected = True
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self.on_status({"connected": True, "port": self.port})

    def disconnect(self):
        was_connected = self.connected
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self.connected = False
        if was_connected:
            self.on_status({"connected": False, "port": self.port})

    def _run_loop(self):
        rate_hz = 200.0
        dt = 1.0 / rate_hz
        t0 = time.time()
        elapsed = 0.0
        while self._running:
            loop_start = time.time()
            elapsed = loop_start - t0

            in_swing = self._swing_start is not None
            if not in_swing and elapsed >= self._next_swing_at:
                self._swing_start = elapsed

            if self._swing_start is not None:
                st = elapsed - self._swing_start
                if st > _DEMO_SWING_KEYFRAMES[-1][0]:
                    self._swing_start = None
                    self._next_swing_at = elapsed + 5.0 + random.uniform(0, 3.0)
                    roll, pitch, yaw, amag = _DEMO_SWING_KEYFRAMES[-1][1:]
                else:
                    roll, pitch, yaw, amag = _interp_keyframes(st, _DEMO_SWING_KEYFRAMES)
            else:
                roll = random.uniform(-0.3, 0.3)
                pitch = random.uniform(-0.3, 0.3)
                yaw = random.uniform(-0.3, 0.3)
                amag = 1.0 + random.uniform(-0.02, 0.02)

            # Each frame gets its own time.time() call (not one shared timestamp)
            # so consecutive buffered samples have genuinely distinct times,
            # matching how real BWT901CL packets arrive one at a time on the
            # wire (see BWT901Parser._decode). A shared timestamp here would
            # create runs of duplicate 't' values that break dt-based analysis
            # like the Butterworth filtering in swing_analyzer.find_arc_bottom.
            q0, q1, q2, q3 = euler_to_quaternion(roll, pitch, yaw)

            ax = amag * math.sin(math.radians(pitch))
            ay = amag * math.sin(math.radians(roll))
            az = amag * math.cos(math.radians(pitch)) * math.cos(math.radians(roll))
            if self._swing_start is not None:
                dyn_g = _demo_vertical_accel_g(st)
                dx, dy, dz = _quat_rotate_vector(q0, -q1, -q2, -q3, (0.0, 0.0, dyn_g))
                ax += dx
                ay += dy
                az += dz
            self.on_frame({"type": "acc", "t": time.time(), "ax": ax, "ay": ay, "az": az, "temp": 30.0})

            wx = random.uniform(-2, 2)
            wy = random.uniform(-2, 2)
            wz = random.uniform(-2, 2)
            if self._swing_start is not None:
                dwx, dwy, dwz = _demo_angular_velocity_dps(st)
                wx += dwx
                wy += dwy
                wz += dwz
            self.on_frame({"type": "gyro", "t": time.time(), "wx": wx, "wy": wy, "wz": wz, "temp": 30.0})

            self.on_frame({"type": "angle", "t": time.time(), "roll": roll, "pitch": pitch, "yaw": yaw, "temp": 30.0})

            self.on_frame({"type": "quat", "t": time.time(), "q0": q0, "q1": q1, "q2": q2, "q3": q3})

            self.on_frame({"type": "mag", "t": time.time(),
                           "hx": 20 + random.uniform(-1, 1),
                           "hy": -5 + random.uniform(-1, 1),
                           "hz": 40 + random.uniform(-1, 1), "temp": 30.0})

            sleep_left = dt - (time.time() - loop_start)
            if sleep_left > 0:
                time.sleep(sleep_left)

    # --- command no-ops (kept so UI code can call these unconditionally) ---

    def save_config(self): pass
    def set_output_rate(self, hz): pass
    def set_bandwidth(self, hz): pass
    def set_algorithm(self, axis6=True): pass
    def set_install_direction(self, vertical=False): pass
    def set_output_content(self, fields): pass
    def reset_z_axis(self): pass
    def set_angle_reference(self): pass
    def start_accel_calibration(self): pass
    def stop_accel_calibration(self): pass
    def start_mag_calibration(self): pass
    def stop_mag_calibration(self): pass
    def factory_reset(self): pass
    def configure_for_golf(self): pass


if __name__ == "__main__":
    print("Scanning COM ports for WitMotion BWT901CL ...")
    ports = scan_ports()
    if not ports:
        print("No COM ports found at all.")
    for r in ports:
        print(f"  {r['port']:>8}  {r['description']:<40}  "
              f"confirmed={r['witmotion_confirmed']}  signal={r['signal_strength']}  "
              f"hint={r['vid_pid_hint']}")

    target = next((r for r in ports if r["witmotion_confirmed"]), None)
    if not target:
        print("\nNo confirmed WitMotion device found. Plug in the BWT901CL dongle and re-run.")
    else:
        print(f"\nConnecting to {target['port']} ...")
        sensor = WitMotionSensor(
            on_frame=lambda f: print(f),
            on_status=lambda s: print("STATUS:", s),
        )
        sensor.connect(target["port"])
        sensor.configure_for_golf()
        try:
            time.sleep(10)
        except KeyboardInterrupt:
            pass
        sensor.disconnect()
