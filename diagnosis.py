"""
GolfSense - diagnosis.py
Rule engine mapping swing metric combinations to plain-English swing fault
diagnoses and coaching tips. Pure function of a metrics dict so it's easy to
test independent of the sensor/session state that produces those metrics.
"""

FACE_OPEN_CLOSED_THRESHOLD_DEG = 3.0
STRIKE_TENDENCY_THRESHOLD_DEG = 2.0
STEEP_ATTACK_THRESHOLD_DEG = -5.0
FACE_CONSISTENCY_STD_THRESHOLD_DEG = 3.0
TEMPO_RATIO_MIN = 2.5
TEMPO_RATIO_MAX = 3.5


def diagnose_swing(metrics):
    """
    metrics keys (all optional - missing/None values skip the rules that need them):
      face_angle_deg   - roll delta at impact vs address; + open, - closed
      path_deg         - swing path proxy at impact; + in-to-out, - out-to-in
      heel_toe_deg     - same axis as face_angle_deg, reused for strike location
      attack_angle_deg - pitch delta at impact vs address; + ascending, - descending
      decelerating     - bool, resultant accel peaked well before impact
      arc_bottom_early - bool, arc bottom landed at/before the transition moment
      tempo_ratio       - backswing_duration / downswing_duration, or None
      session_face_std - std deviation of face_angle_deg across the session's
                         swings so far, or None if too few swings yet
    Returns a list of diagnosis strings, most-relevant-seeming first.
    """
    tips = []
    face = metrics.get("face_angle_deg")
    path = metrics.get("path_deg")
    heel_toe = metrics.get("heel_toe_deg")
    attack = metrics.get("attack_angle_deg")

    if face is not None and path is not None:
        face_open = face > FACE_OPEN_CLOSED_THRESHOLD_DEG
        face_closed = face < -FACE_OPEN_CLOSED_THRESHOLD_DEG
        out_to_in = path < 0
        in_to_out = path > 0

        if face_open and out_to_in:
            tips.append(
                "Classic Slice Setup. Your face is open and cutting across the ball. "
                "Primary cause of the most common beginner miss. Focus: square the "
                "face at address, check your grip isn't too weak, swing more from "
                "the inside."
            )
        elif face_open and in_to_out:
            tips.append(
                "Push-Slice. You're swinging from the inside but the face is open. "
                "The ball will start right and slice further right. Focus: rotate "
                "forearms more aggressively through impact to close the face."
            )
        elif face_closed and in_to_out:
            tips.append(
                "Hook Pattern. Face closing too fast. Check grip isn't too strong, "
                "focus on holding the face square longer through the ball rather "
                "than rotating over it."
            )
        elif face_closed and out_to_in:
            tips.append(
                "Pull-Hook. Both path and face are sending the ball left. Common "
                "when you're trying to fix a slice by swinging harder left — this "
                "makes it worse. Focus on path first, swing more from the inside."
            )

    if heel_toe is not None:
        if heel_toe > STRIKE_TENDENCY_THRESHOLD_DEG:
            tips.append(
                "Heel Contact. The gear effect from a heel hit adds fade/slice "
                "spin regardless of your face angle or path — it can override "
                "your swing entirely. You may be standing too close, or your arc "
                "is swinging too far inside through impact."
            )
        elif heel_toe < -STRIKE_TENDENCY_THRESHOLD_DEG:
            tips.append(
                "Toe Contact. Gear effect adds draw/hook spin. You may be standing "
                "too far from the ball, or your arms are extending too far through "
                "the hitting zone."
            )

    if metrics.get("decelerating"):
        tips.append(
            "Decelerating into Impact. You're slowing down before the bottom "
            "of your arc — a very common beginner fault. This causes thin, "
            "weak, inconsistent contact. Focus on accelerating all the way "
            "through to a full finish, not just to the ball."
        )

    if attack is not None and attack < STEEP_ATTACK_THRESHOLD_DEG:
        tips.append(
            "Too Steep. You're hitting down sharply on the driver, which "
            "increases spin and reduces distance. Try teeing the ball higher "
            "and positioning it further forward in your stance."
        )

    session_std = metrics.get("session_face_std")
    if session_std is not None and session_std > FACE_CONSISTENCY_STD_THRESHOLD_DEG:
        tips.append(
            "Inconsistent Face Control. Your face angle is varying significantly "
            "swing to swing — the single biggest cause of dispersion. This "
            "usually comes from grip pressure or wrist position changing. "
            "Focus on a consistent grip and pre-shot routine."
        )

    if metrics.get("arc_bottom_early"):
        tips.append(
            "Early Arc Bottom. You're hitting the ground before the ball "
            "position. This causes fat shots. Try shifting weight more to "
            "your lead side through the downswing."
        )

    tempo_ratio = metrics.get("tempo_ratio")
    if tempo_ratio is not None and not (TEMPO_RATIO_MIN <= tempo_ratio <= TEMPO_RATIO_MAX):
        speed_note = "Too fast downswing" if tempo_ratio < TEMPO_RATIO_MIN else "Too slow downswing"
        tips.append(
            f"Tempo Issue. Tour players average a 3:1 backswing-to-downswing "
            f"ratio. Yours is {tempo_ratio:.1f}:1. {speed_note} — focus on a "
            f"smooth transition at the top."
        )

    return tips
