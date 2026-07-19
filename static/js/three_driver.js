// GolfSense - three_driver.js
// Panel 1: live 3D driver head, driven by quaternion deltas relative to the
// address calibration reference, with face-angle color coding and a
// speed-gradient ghost trail during live swings.

function faceAngleColor(absAngleDeg) {
  if (absAngleDeg <= 1) return 0x2ecc71;
  if (absAngleDeg <= 3) return 0xf1c40f;
  if (absAngleDeg <= 7) return 0xe67e22;
  return 0xe74c3c;
}

function speedToColor(speedNorm) {
  const c = new THREE.Color();
  c.setHSL(0.66 * (1 - Math.min(1, Math.max(0, speedNorm))), 0.85, 0.55);
  return c;
}

// Sensor mounting convention (confirmed 2026-07-18): the hosel-mounted
// BWT901CL's local +X axis points up the shaft toward the grip, +Y points
// heel-to-toe, +Z points out through the face toward the target.
//
// Real driver specs (standard reference numbers, not this specific club):
//   shaft length   ~45 in          loft            ~10.5 deg
//   head width     ~5.0 in (heel-toe)   head depth ~4.7 in (face-to-back)
//   head height    ~2.3 in (crown-sole) face height ~2.3 in
//   face width     ~4.0 in         hosel length     ~1.5 in
//   grip length    ~10 in
// One scale factor converts all of them into scene units, so every
// dimension is proportionally correct relative to the others rather than
// each being eyeballed independently.
const IN_TO_UNIT = 0.45;
const SPEC_IN = {
  shaftLength: 45, loftDeg: 10.5,
  headWidth: 5.0, headDepth: 4.7, headHeight: 2.3,
  faceWidth: 4.0, faceHeight: 2.3,
  hoselLength: 1.5, gripLength: 10,
};
const SHAFT_LENGTH = SPEC_IN.shaftLength * IN_TO_UNIT;

// Lie angle (how flat/upright the shaft sits relative to the ground at
// address, ~58deg for a driver) is deliberately NOT baked in as a static
// offset here: the sensor's own physical X-axis already IS the shaft, so
// the live calibrated orientation data expresses lie angle on its own.
// Baking in a second static tilt would double-count it. Loft, by contrast,
// is a fixed property of the clubhead itself (independent of how it's
// held), so it's applied below as a real rotation of the face mesh.
const LOFT_RAD = THREE.MathUtils.degToRad(SPEC_IN.loftDeg);

// A real swing pivots near the hands, not at the clubhead - the golfer's
// hands pull the grip back and the head sweeps through a wide arc as a
// result. The sensor sits at the hosel/head end, but the group's local
// origin (where all rotation happens) is placed at the GRIP end instead,
// so the head - offset far along -X - sweeps a realistic arc when the
// group rotates, rather than the head staying still while the grip
// (wrongly) whips around it.
const HEAD_CENTER_X = -SHAFT_LENGTH;

function buildDriverHeadGroup() {
  const group = new THREE.Group();

  const headHalfW = (SPEC_IN.headWidth * IN_TO_UNIT) / 2;   // heel-toe -> Y
  const headHalfD = (SPEC_IN.headDepth * IN_TO_UNIT) / 2;   // face-to-back -> Z
  const headHalfH = (SPEC_IN.headHeight * IN_TO_UNIT) / 2;  // crown-sole -> X (shallow, local to the head)

  const bodyGeo = new THREE.SphereGeometry(1, 24, 16);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.7, roughness: 0.3 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.scale.set(headHalfH, headHalfW, headHalfD);
  body.position.set(HEAD_CENTER_X, 0, 0);
  group.add(body);

  const faceW = SPEC_IN.faceWidth * IN_TO_UNIT;   // heel-toe -> Y
  const faceH = SPEC_IN.faceHeight * IN_TO_UNIT;  // crown-sole -> X
  const faceGeo = new THREE.BoxGeometry(faceH, faceW, 0.1);
  const faceMat = new THREE.MeshStandardMaterial({ color: 0x2ecc71, metalness: 0.1, roughness: 0.45 });
  const face = new THREE.Mesh(faceGeo, faceMat);
  face.position.set(HEAD_CENTER_X, 0, headHalfD);
  // Loft tilts the face's normal upward (toward the shaft direction) by
  // rotating about Y (heel-toe) - the one rotation that mixes X/Z without
  // touching heel-toe alignment.
  face.rotation.y = LOFT_RAD;
  group.add(face);

  // Cylinders default to a long-axis along local Y; rotate -90 deg about Z
  // so the long axis runs along local X (the shaft direction) instead.
  const AXIS_TO_X = -Math.PI / 2;
  const shaftY = 0.4, shaftZ = 0.3; // slight offset toward heel/crown, matching a real hosel entry point

  const hoselLen = SPEC_IN.hoselLength * IN_TO_UNIT;
  const hoselGeo = new THREE.CylinderGeometry(0.13, 0.16, hoselLen, 12);
  const hoselMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, metalness: 0.8, roughness: 0.3 });
  const hosel = new THREE.Mesh(hoselGeo, hoselMat);
  hosel.rotation.z = AXIS_TO_X;
  hosel.position.set(HEAD_CENTER_X + hoselLen / 2, shaftY, shaftZ);
  group.add(hosel);

  const gripLen = SPEC_IN.gripLength * IN_TO_UNIT;
  const bareShaftLen = SHAFT_LENGTH - hoselLen - gripLen;
  const shaftGeo = new THREE.CylinderGeometry(0.1, 0.13, bareShaftLen, 12);
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0xd8dadf, metalness: 0.5, roughness: 0.4 });
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.rotation.z = AXIS_TO_X;
  shaft.position.set(HEAD_CENTER_X + hoselLen + bareShaftLen / 2, shaftY, shaftZ);
  group.add(shaft);

  const gripGeo = new THREE.CylinderGeometry(0.2, 0.17, gripLen, 12);
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
  const grip = new THREE.Mesh(gripGeo, gripMat);
  grip.rotation.z = AXIS_TO_X;
  grip.position.set(-gripLen / 2, shaftY, shaftZ);
  group.add(grip);

  return { group, face };
}

function initDriverPanel() {
  const canvas = document.getElementById("panel1-canvas");
  const wrap = document.getElementById("panel1-canvas-wrap");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  // The rotation pivot (grip, local origin) sits at world (0,0,0); the head
  // sits ~SHAFT_LENGTH away at rest. Framed to comfortably fit both ends of
  // a real-proportioned ~20-unit club, not just the head.
  camera.position.set(-10, 10, 20);
  camera.lookAt(HEAD_CENTER_X / 2, 0, 3);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.3));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(5, 8, 5);
  scene.add(dirLight);
  scene.add(new THREE.GridHelper(50, 20, 0x3a3f4a, 0x24272e));

  const { group, face } = buildDriverHeadGroup();
  scene.add(group);

  const maxTrailAgeMs = 2000;
  const trailPoints = []; // {pos: THREE.Vector3, time: ms}
  const maxTrailVerts = 600;
  const trailGeo = new THREE.BufferGeometry();
  const trailPositions = new Float32Array(maxTrailVerts * 3);
  const trailColors = new Float32Array(maxTrailVerts * 3);
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));
  const trailLine = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }));
  trailLine.frustumCulled = false;
  scene.add(trailLine);

  let lastW = 0, lastH = 0;
  function maybeResize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (w > 0 && h > 0 && (w !== lastW || h !== lastH)) {
      lastW = w; lastH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function updateTrailGeometry() {
    const now = performance.now();
    while (trailPoints.length && now - trailPoints[0].time > maxTrailAgeMs) trailPoints.shift();
    const n = Math.min(trailPoints.length, maxTrailVerts);
    for (let i = 0; i < n; i++) {
      const p = trailPoints[trailPoints.length - n + i];
      trailPositions[i * 3] = p.pos.x;
      trailPositions[i * 3 + 1] = p.pos.y;
      trailPositions[i * 3 + 2] = p.pos.z;
      const age = (now - p.time) / maxTrailAgeMs;
      const fade = Math.max(0, 1 - age);
      trailColors[i * 3] = p.color.r * fade;
      trailColors[i * 3 + 1] = p.color.g * fade;
      trailColors[i * 3 + 2] = p.color.b * fade;
    }
    trailGeo.setDrawRange(0, n);
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;
  }

  function animate() {
    requestAnimationFrame(animate);
    maybeResize();
    renderer.render(scene, camera);
  }
  animate();

  return { group, face, trailPoints, updateTrailGeometry };
}

const _driverPanel = initDriverPanel();
const _qRef = new THREE.Quaternion();
const _qCur = new THREE.Quaternion();
const _worldPos = new THREE.Vector3();

document.addEventListener("gs:sample", (e) => {
  const view = document.getElementById("view-golfsense");
  if (!view || view.style.display === "none") return;

  const s = e.detail;
  if (s.quat_q0 === undefined) return;

  const cal = window.golfsenseCalibration;
  // Calibration now happens automatically right after connecting (see
  // app.py's _auto_calibrate_after_connect) - this note only shows for the
  // brief window before that completes, not as a "click here" prompt.
  document.getElementById("panel1-uncalibrated-note").style.display = cal.calibrated ? "none" : "block";
  document.getElementById("panel1-uncalibrated-note").textContent = "Calibrating...";

  _qCur.set(s.quat_q1, s.quat_q2, s.quat_q3, s.quat_q0);

  if (cal.calibrated && cal.reference) {
    const r = cal.reference.quat;
    _qRef.set(r[1], r[2], r[3], r[0]);
    const delta = _qRef.clone().invert().multiply(_qCur);
    _driverPanel.group.quaternion.copy(delta);
  } else {
    _driverPanel.group.quaternion.copy(_qCur);
  }

  const refRoll = cal.calibrated && cal.reference ? cal.reference.roll : 0;
  const faceAngle = (s.angle_roll ?? 0) - refRoll;
  const absAngle = Math.abs(faceAngle);
  document.getElementById("panel1-face-angle").textContent = `${faceAngle >= 0 ? "+" : ""}${faceAngle.toFixed(1)}°`;
  document.getElementById("panel1-face-angle").style.color = `#${faceAngleColor(absAngle).toString(16).padStart(6, "0")}`;
  document.getElementById("panel1-face-label").textContent =
    absAngle <= 1 ? "SQUARE" : (faceAngle > 0 ? "OPEN" : "CLOSED");
  _driverPanel.face.material.color.setHex(faceAngleColor(absAngle));

  if (s.swinging) {
    _driverPanel.face.getWorldPosition(_worldPos);
    const amag = Math.sqrt((s.acc_ax ?? 0) ** 2 + (s.acc_ay ?? 0) ** 2 + (s.acc_az ?? 0) ** 2);
    const speedNorm = Math.min(1, Math.max(0, (amag - 1) / 4));
    _driverPanel.trailPoints.push({
      pos: _worldPos.clone(),
      time: performance.now(),
      color: speedToColor(speedNorm),
    });
  }
  _driverPanel.updateTrailGeometry();
});
