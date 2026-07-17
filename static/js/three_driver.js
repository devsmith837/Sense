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

function buildDriverHeadGroup() {
  const group = new THREE.Group();

  const bodyGeo = new THREE.SphereGeometry(1, 24, 16);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.7, roughness: 0.3 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.scale.set(2.2, 1.05, 1.7);
  group.add(body);

  const faceGeo = new THREE.BoxGeometry(1.9, 1.6, 0.12);
  const faceMat = new THREE.MeshStandardMaterial({ color: 0x2ecc71, metalness: 0.1, roughness: 0.45 });
  const face = new THREE.Mesh(faceGeo, faceMat);
  face.position.set(0, 0, 1.75);
  group.add(face);

  const hoselGeo = new THREE.CylinderGeometry(0.11, 0.13, 1.3, 12);
  const hoselMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, metalness: 0.8, roughness: 0.3 });
  const hosel = new THREE.Mesh(hoselGeo, hoselMat);
  hosel.position.set(-1.75, 0.55, 0.7);
  hosel.rotation.z = 0.18;
  group.add(hosel);

  return { group, face };
}

function initDriverPanel() {
  const canvas = document.getElementById("panel1-canvas");
  const wrap = document.getElementById("panel1-canvas-wrap");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(4.5, 3.2, 5.5);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.3));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(5, 8, 5);
  scene.add(dirLight);
  scene.add(new THREE.GridHelper(14, 14, 0x3a3f4a, 0x24272e));

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
  document.getElementById("panel1-uncalibrated-note").style.display = cal.calibrated ? "none" : "block";

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
