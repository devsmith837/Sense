"""
GolfSense - ball_flight.py
Rule-based ball flight prediction from impact-moment orientation deltas.

Inputs are all simple angle deltas at the impact sample relative to the
address reference (already available from the sensor stream, no additional
position/velocity tracking needed):
  - face_angle_deg: roll delta - open (+) / closed (-) relative to address
  - path_deg: yaw delta - a proxy for swing path direction. A true swing
    path would come from the club head's horizontal velocity vector, but
    that requires reconstructing 3D position from orientation-only data
    (no GPS/optical tracking here). Yaw captures the club's heading change
    through impact, which correlates with in-to-out / out-to-in path in
    this sensor's own axis convention (see sensor setup notes), so it's
    used as the practical stand-in.
  - attack_angle_deg: pitch delta - ascending (+) / descending (-)
  - heel_toe_deg / high_low_deg: same as face_angle_deg / attack_angle_deg,
    reused here since the spec ties strike location to those same axes.
"""

STRIKE_TENDENCY_THRESHOLD_DEG = 2.0
START_STRAIGHT_TOL_DEG = 3.0
CURVE_STRAIGHT_TOL_DEG = 1.0
CURVE_STRONG_DEG = 7.0

FACE_WEIGHT = 0.8
PATH_WEIGHT = 0.2


def classify_shot_shape(start_direction_deg, curve_deg):
    pushed = start_direction_deg > START_STRAIGHT_TOL_DEG
    pulled = start_direction_deg < -START_STRAIGHT_TOL_DEG
    curve_mag = abs(curve_deg)
    is_fade = curve_deg > CURVE_STRAIGHT_TOL_DEG
    is_draw = curve_deg < -CURVE_STRAIGHT_TOL_DEG

    if curve_mag <= CURVE_STRAIGHT_TOL_DEG:
        if pushed:
            return "PUSH"
        if pulled:
            return "PULL"
        return "STRAIGHT"

    base = ("SLICE" if curve_mag >= CURVE_STRONG_DEG else "FADE") if is_fade else \
           ("HOOK" if curve_mag >= CURVE_STRONG_DEG else "DRAW")

    if pushed and base == "SLICE":
        return "PUSH-SLICE"
    if pulled and base == "HOOK":
        return "PULL-HOOK"
    return base


def estimate_carry_yards(peak_resultant_g, attack_angle_deg):
    """
    Rough carry estimate for demo purposes. The synthetic/real sensor gives
    us a resultant-acceleration peak, not a calibrated ball speed, so this
    maps that peak onto a plausible driver carry range (70-115 mph swing
    equivalent) rather than deriving a physically precise number - there's
    no ground-truth launch monitor here to calibrate against.
    """
    speed_index = max(0.0, min(1.0, (peak_resultant_g - 1.0) / 4.0))
    speed_mph = 70 + speed_index * 45
    base_yards = speed_mph * 2.2
    if attack_angle_deg >= 0:
        bonus = min(15.0, attack_angle_deg * 3.0)
    else:
        bonus = max(-25.0, attack_angle_deg * 2.5)
    return max(50.0, base_yards + bonus), speed_mph


def predict_ball_flight(face_angle_deg, path_deg, attack_angle_deg,
                         heel_toe_deg, high_low_deg, peak_resultant_g):
    start_direction_deg = FACE_WEIGHT * face_angle_deg + PATH_WEIGHT * path_deg
    face_to_path_deg = face_angle_deg - path_deg

    gear_adjust = 0.0
    spin_multiplier = 1.0
    if heel_toe_deg > STRIKE_TENDENCY_THRESHOLD_DEG:
        gear_adjust += 2.0       # heel strike adds fade spin
    elif heel_toe_deg < -STRIKE_TENDENCY_THRESHOLD_DEG:
        gear_adjust -= 2.0       # toe strike adds draw spin

    if high_low_deg > STRIKE_TENDENCY_THRESHOLD_DEG:
        spin_multiplier *= 0.7   # high strike: lower spin, more roll
    elif high_low_deg < -STRIKE_TENDENCY_THRESHOLD_DEG:
        spin_multiplier *= 1.3   # low strike: higher spin, less distance

    effective_curve_deg = (face_to_path_deg + gear_adjust) * spin_multiplier
    shot_shape = classify_shot_shape(start_direction_deg, effective_curve_deg)
    carry_yards, speed_mph = estimate_carry_yards(peak_resultant_g, attack_angle_deg)

    return {
        "start_direction_deg": start_direction_deg,
        "face_to_path_deg": face_to_path_deg,
        "curve_deg": effective_curve_deg,
        "shot_shape": shot_shape,
        "carry_yards": carry_yards,
        "speed_mph": speed_mph,
    }
