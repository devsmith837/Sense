"""
GolfSense - swing_analyzer.py
Swing start/end detection from the full-rate (up to 200Hz) merged sensor
stream, plus retrospective arc-bottom ("virtual impact") detection on the
completed swing buffer. Golf metric calculations (face angle, speed curves,
strike location, etc.) are added on top of this in later build steps.
"""

import numpy as np
from scipy.signal import butter, filtfilt

START_ACCEL_G = 1.5          # swing start: resultant accel above this...
START_HOLD_S = 0.05          # ...for at least this long
END_ACCEL_G = 0.3            # swing end: resultant accel below this...
END_GYRO_DPS = 10.0          # ...and gyro magnitude below this...
END_HOLD_S = 0.2             # ...for at least this long
MIN_SWING_S = 0.3
MAX_SWING_S = 3.0
ARC_BOTTOM_PITCH_TOL_DEG = 8.0

REQUIRED_FIELDS = ("acc_ax", "acc_ay", "acc_az")


def _resultant(ax, ay, az):
    return (ax * ax + ay * ay + az * az) ** 0.5


def _quat_rotate_body_to_world(q0, q1, q2, q3, v):
    """Rotate body-frame vector v into the world frame with quaternion (q0 scalar)."""
    qv = np.array([q1, q2, q3], dtype=float)
    vvec = np.array(v, dtype=float)
    t = 2.0 * np.cross(qv, vvec)
    return vvec + q0 * t + np.cross(qv, t)


def find_arc_bottom(samples, address_pitch_deg=0.0):
    """
    Retrospective arc-bottom detection on a completed swing's sample buffer.
    Returns the index into `samples` of the arc bottom, or None if not found.

    Method: rotate each sample's body-frame acceleration into the world frame
    using its quaternion and subtract 1g of gravity to get world-vertical
    linear acceleration, Butterworth low-pass filter it, then find where that
    filtered acceleration crosses from negative to positive while pitch is
    within tolerance of the address reference.

    A negative-to-positive acceleration crossing is exactly a local minimum
    of vertical velocity - the club stops accelerating further downward and
    starts decelerating/reversing - i.e. the bottom of the swing arc. This
    is deliberately checked on the acceleration signal itself rather than on
    an integrated velocity curve: integrating from an arbitrary "v=0 at
    buffer start" baseline is sensitive to whatever acceleration happened
    right at the start of the buffer, and even a small early bias shifts the
    entire integrated curve enough to hide or move a genuine crossing. The
    acceleration crossing has no such baseline dependency.
    """
    n = len(samples)
    if n < 5:
        return None

    have_quat = all(s.get("quat_q0") is not None for s in samples)
    t = np.array([s["t"] for s in samples])
    world_vert_acc_g = np.zeros(n)

    for i, s in enumerate(samples):
        ax, ay, az = s.get("acc_ax", 0.0), s.get("acc_ay", 0.0), s.get("acc_az", 0.0)
        if have_quat:
            world = _quat_rotate_body_to_world(
                s["quat_q0"], s["quat_q1"], s["quat_q2"], s["quat_q3"], (ax, ay, az))
            world_vert_acc_g[i] = world[2] - 1.0
        else:
            world_vert_acc_g[i] = az - 1.0

    dt = np.diff(t)
    fs = 1.0 / np.median(dt) if len(dt) and np.median(dt) > 0 else 200.0
    if not np.isfinite(fs) or fs <= 0:
        fs = 200.0

    filtered = world_vert_acc_g
    try:
        nyq = fs / 2.0
        cutoff = min(20.0, nyq * 0.9)
        b, a = butter(4, cutoff / nyq, btype="low")
        if n > 3 * max(len(a), len(b)):
            filtered = filtfilt(b, a, world_vert_acc_g)
    except Exception:
        pass

    pitch = np.array([s.get("angle_pitch", address_pitch_deg) for s in samples])

    # A rotating sensor's gravity projection alone crosses zero repeatedly
    # through a swing, so several samples can satisfy "acceleration crosses
    # negative to positive" without being the real impact. Physically, the
    # true arc bottom happens near peak club head speed, so among candidate
    # crossings that also have pitch near the address reference (within a
    # small time window, since pitch and the crossing can lead/lag by a few
    # tens of ms), pick the one closest to where resultant acceleration
    # magnitude peaks.
    resultant = np.array([
        (s.get("acc_ax", 0.0) ** 2 + s.get("acc_ay", 0.0) ** 2 + s.get("acc_az", 0.0) ** 2) ** 0.5
        for s in samples
    ])
    peak_idx = int(np.argmax(resultant))

    window = max(1, int(round(0.15 * fs)))
    candidates = []
    for i in range(1, n):
        crosses_up = filtered[i - 1] < 0 <= filtered[i]
        if not crosses_up:
            continue
        lo, hi = max(0, i - window), min(n, i + window + 1)
        if np.any(np.abs(pitch[lo:hi] - address_pitch_deg) <= ARC_BOTTOM_PITCH_TOL_DEG):
            candidates.append(i)

    if not candidates:
        return None
    return min(candidates, key=lambda i: abs(i - peak_idx))


def detect_key_moments(samples, arc_bottom_index):
    """
    Heuristic detection of the named moments Panel 2 marks on the swing arc:
    address, end of takeaway, top of backswing, transition, impact (arc
    bottom), and follow-through. There's no ground truth to fit these
    against, so each is a reasonable approximation from the angular-velocity
    profile rather than a precise biomechanical detector:

    - address: first sample of the buffer.
    - top of backswing: the swing's natural pause - a local minimum of gyro
      magnitude before impact, since rotation direction reverses there.
    - end of takeaway: partway between address and top of backswing.
    - transition: partway between top of backswing and impact.
    - impact: the arc-bottom index (or ~60% through the swing if arc-bottom
      detection didn't find one).
    - follow-through: partway between impact and the end of the buffer.
    """
    n = len(samples)
    if n < 6:
        return None

    impact_idx = arc_bottom_index if arc_bottom_index is not None else int(n * 0.6)
    impact_idx = max(2, min(n - 2, impact_idx))

    gyro_mag = np.array([
        _resultant(s.get("gyro_wx", 0.0), s.get("gyro_wy", 0.0), s.get("gyro_wz", 0.0))
        for s in samples
    ])
    search_end = max(2, int(impact_idx * 0.85))
    pre_impact = gyro_mag[1:search_end]
    top_backswing_idx = 1 + int(np.argmin(pre_impact)) if len(pre_impact) else max(1, impact_idx // 2)

    address_idx = 0
    end_takeaway_idx = max(1, top_backswing_idx // 2)
    transition_idx = min(impact_idx - 1, top_backswing_idx + max(1, (impact_idx - top_backswing_idx) // 3))
    follow_through_idx = min(n - 1, impact_idx + max(1, (n - 1 - impact_idx) // 2))

    # keep them strictly increasing in case a heuristic collapses two moments
    idxs = [address_idx, end_takeaway_idx, top_backswing_idx, transition_idx, impact_idx, follow_through_idx]
    for i in range(1, len(idxs)):
        idxs[i] = max(idxs[i], idxs[i - 1] + 1)
    idxs = [min(i, n - 1) for i in idxs]

    return {
        "address": idxs[0], "end_takeaway": idxs[1], "top_backswing": idxs[2],
        "transition": idxs[3], "impact": idxs[4], "follow_through": idxs[5],
    }


class SwingDetector:
    """Streaming swing start/end detector fed one merged sample at a time."""

    def __init__(self, on_swing_complete=None):
        self.on_swing_complete = on_swing_complete or (lambda swing: None)
        self.address_pitch_deg = 0.0
        self.state = "idle"
        self.buffer = []
        self._above_since = None
        self._below_since = None
        self.swing_index = 0

    def set_address_reference(self, pitch_deg):
        self.address_pitch_deg = pitch_deg

    def feed(self, sample):
        if any(sample.get(k) is None for k in REQUIRED_FIELDS):
            return
        t = sample.get("t")
        if t is None:
            return
        amag = _resultant(sample["acc_ax"], sample["acc_ay"], sample["acc_az"])

        if self.state == "idle":
            if amag > START_ACCEL_G:
                if self._above_since is None:
                    self._above_since = t
                elif t - self._above_since >= START_HOLD_S:
                    self.state = "swinging"
                    self.buffer = [dict(sample)]
                    self._below_since = None
            else:
                self._above_since = None
            return

        # state == "swinging"
        self.buffer.append(dict(sample))
        duration = t - self.buffer[0]["t"]

        gyro_mag = None
        if all(sample.get(k) is not None for k in ("gyro_wx", "gyro_wy", "gyro_wz")):
            gyro_mag = _resultant(sample["gyro_wx"], sample["gyro_wy"], sample["gyro_wz"])

        # A stationary accelerometer always reads ~1g from gravity, so "end"
        # means the dynamic (gravity-excluded) component has settled below
        # END_ACCEL_G, not that the raw resultant itself is near zero.
        below = abs(amag - 1.0) < END_ACCEL_G and (gyro_mag is None or gyro_mag < END_GYRO_DPS)
        if below:
            if self._below_since is None:
                self._below_since = t
            elif t - self._below_since >= END_HOLD_S:
                self._finish_swing(duration)
                return
        else:
            self._below_since = None

        if duration > MAX_SWING_S:
            self._reset()

    def _finish_swing(self, duration):
        samples = self.buffer
        if MIN_SWING_S <= duration <= MAX_SWING_S:
            arc_bottom_index = find_arc_bottom(samples, self.address_pitch_deg)
            swing = {
                "index": self.swing_index,
                "start_t": samples[0]["t"],
                "end_t": samples[-1]["t"],
                "duration": duration,
                "samples": samples,
                "arc_bottom_index": arc_bottom_index,
                "arc_bottom_t": samples[arc_bottom_index]["t"] if arc_bottom_index is not None else None,
                "key_moments": detect_key_moments(samples, arc_bottom_index),
            }
            self.swing_index += 1
            self.on_swing_complete(swing)
        self._reset()

    def _reset(self):
        self.state = "idle"
        self.buffer = []
        self._above_since = None
        self._below_since = None
