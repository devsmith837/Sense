// GolfSense - three_swing.js
// Panel 2: 3D swing arc replay with key-moment markers, a scrubber timeline,
// and a dual-axis speed/face-angle overlay chart.

const KEY_MOMENT_STYLE = {
  address: { color: 0xffffff, label: "Address" },
  end_takeaway: { color: 0xf1c40f, label: "End of takeaway" },
  top_backswing: { color: 0xe67e22, label: "Top of backswing" },
  transition: { color: 0x9b59b6, label: "Transition" },
  impact: { color: 0xe74c3c, label: "Impact" },
  follow_through: { color: 0x3498db, label: "Follow-through" },
};

const CLUB_LOCAL_OFFSET = new THREE.Vector3(0, -2.6, 0); // matches Panel 1's approximate shaft length

function initSwingReplay() {
  const canvas = document.getElementById("panel2-canvas");
  const wrap = document.getElementById("panel2-canvas-wrap");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  const defaultCamPos = new THREE.Vector3(5, 3.5, 6);
  camera.position.copy(defaultCamPos);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, -1, 0);
  controls.update();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.3));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight.position.set(5, 8, 5);
  scene.add(dirLight);
  scene.add(new THREE.GridHelper(14, 14, 0x3a3f4a, 0x24272e));

  const arcGeo = new THREE.BufferGeometry();
  const arcMat = new THREE.LineBasicMaterial({ vertexColors: true });
  const arcLine = new THREE.Line(arcGeo, arcMat);
  arcLine.frustumCulled = false;
  scene.add(arcLine);

  const markerGroup = new THREE.Group();
  scene.add(markerGroup);

  const { group: miniDriver, face: miniFace } = buildDriverHeadGroup();
  miniDriver.scale.set(0.5, 0.5, 0.5);
  scene.add(miniDriver);

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

  function animate() {
    requestAnimationFrame(animate);
    maybeResize();
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  return { scene, arcGeo, arcMat, markerGroup, miniDriver, miniFace, camera, controls, defaultCamPos };
}

function speedToColorHex(speedNorm) {
  const c = new THREE.Color();
  c.setHSL(0.66 * (1 - Math.min(1, Math.max(0, speedNorm))), 0.85, 0.55);
  return c;
}

function quatFromSample(s) {
  return new THREE.Quaternion(s.q1, s.q2, s.q3, s.q0);
}

function computeDeltaQuats(samples, refQuatArr) {
  const qRef = refQuatArr
    ? new THREE.Quaternion(refQuatArr[1], refQuatArr[2], refQuatArr[3], refQuatArr[0]).invert()
    : null;
  return samples.map((s) => {
    const q = quatFromSample(s);
    return qRef ? qRef.clone().multiply(q) : q;
  });
}

function computePositions(deltaQuats) {
  return deltaQuats.map((q) => CLUB_LOCAL_OFFSET.clone().applyQuaternion(q));
}

function computeSpeedCurveMph(samples, deltaQuats) {
  const velocity = new THREE.Vector3(0, 0, 0);
  const speeds = [0];
  for (let i = 1; i < samples.length; i++) {
    const dt = Math.max(0, samples[i].t - samples[i - 1].t);
    const bodyAccel = new THREE.Vector3(samples[i].ax ?? 0, samples[i].ay ?? 0, samples[i].az ?? 0);
    const worldAccel = bodyAccel.applyQuaternion(deltaQuats[i]);
    worldAccel.z -= 1.0;
    worldAccel.multiplyScalar(9.80665);
    velocity.addScaledVector(worldAccel, dt);
    speeds.push(velocity.length() * 2.23694);
  }
  return speeds;
}

const _swingReplay = initSwingReplay();
let _currentSwing = null;
let _playState = { playing: false, speed: 1, lastFrameMs: 0 };
let _replayChart = null;

function buildReplayChart(times, speeds, faceAngles) {
  const ctx = document.getElementById("panel2-chart").getContext("2d");
  if (_replayChart) _replayChart.destroy();
  _replayChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: times,
      datasets: [
        {
          label: "Speed (mph, rough est.)", data: speeds, borderColor: "#3ea6ff",
          yAxisID: "ySpeed", pointRadius: 0, borderWidth: 1.5, tension: 0.2,
        },
        {
          label: "Face angle (°)", data: faceAngles, borderColor: "#f1c40f",
          yAxisID: "yFace", pointRadius: 0, borderWidth: 1.5, tension: 0.2,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false },
      scales: {
        x: { type: "linear", ticks: { display: false }, grid: { color: "#222" } },
        ySpeed: { position: "left", ticks: { color: "#3ea6ff", font: { size: 9 } }, grid: { color: "#222" } },
        yFace: { position: "right", ticks: { color: "#f1c40f", font: { size: 9 } }, grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderKeyMoments(swing) {
  _swingReplay.markerGroup.clear();
  const km = swing.keyMoments;
  if (!km) return;
  for (const [key, idx] of Object.entries(km)) {
    const style = KEY_MOMENT_STYLE[key];
    if (!style || idx >= swing.positions.length) continue;
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 12, 10),
      new THREE.MeshBasicMaterial({ color: style.color })
    );
    sphere.position.copy(swing.positions[idx]);
    sphere.userData.label = style.label;
    _swingReplay.markerGroup.add(sphere);
  }
}

function renderMarkerTicks(swing) {
  const container = document.getElementById("panel2-markers");
  container.innerHTML = "";
  const km = swing.keyMoments;
  if (!km) return;
  for (const [key, idx] of Object.entries(km)) {
    const style = KEY_MOMENT_STYLE[key];
    if (!style || idx >= swing.samples.length) continue;
    const frac = swing.samples[idx].t / swing.duration;
    const el = document.createElement("div");
    el.className = "key-marker";
    el.style.left = `${frac * 100}%`;
    el.style.background = `#${style.color.toString(16).padStart(6, "0")}`;
    el.title = style.label;
    container.appendChild(el);
  }
}

function setScrubberToIndex(swing, idx) {
  idx = Math.max(0, Math.min(swing.samples.length - 1, idx));
  const t = swing.samples[idx].t;
  _swingReplay.miniDriver.position.copy(swing.positions[idx]);
  _swingReplay.miniDriver.quaternion.copy(swing.deltaQuats[idx]);

  const absFace = Math.abs(swing.faceAngles[idx]);
  _swingReplay.miniFace.material.color.setHex(faceAngleColor(absFace));

  document.getElementById("panel2-scrubber").value = String(Math.round((t / swing.duration) * 1000));
  document.getElementById("panel2-time-label").textContent =
    `${t.toFixed(2)}s / ${swing.duration.toFixed(2)}s`;

  const chartWrap = document.getElementById("panel2-chart-wrap");
  const frac = t / swing.duration;
  document.getElementById("panel2-scrub-line").style.left = `${frac * chartWrap.clientWidth}px`;
}

function loadSwingIntoReplay(rawSwing) {
  const samples = rawSwing.samples;
  const refQuat = rawSwing.address_reference ? rawSwing.address_reference.quat : null;
  const refRoll = rawSwing.address_reference ? rawSwing.address_reference.roll : 0;

  const deltaQuats = computeDeltaQuats(samples, refQuat);
  const positions = computePositions(deltaQuats);
  const speeds = computeSpeedCurveMph(samples, deltaQuats);
  const faceAngles = samples.map((s) => (s.roll ?? 0) - refRoll);
  const maxSpeed = Math.max(1, ...speeds);

  const swing = {
    index: rawSwing.index, duration: rawSwing.duration, samples,
    deltaQuats, positions, speeds, faceAngles, keyMoments: rawSwing.key_moments,
  };
  _currentSwing = swing;

  const posArr = new Float32Array(positions.length * 3);
  const colorArr = new Float32Array(positions.length * 3);
  positions.forEach((p, i) => {
    posArr[i * 3] = p.x; posArr[i * 3 + 1] = p.y; posArr[i * 3 + 2] = p.z;
    const c = speedToColorHex(speeds[i] / maxSpeed);
    colorArr[i * 3] = c.r; colorArr[i * 3 + 1] = c.g; colorArr[i * 3 + 2] = c.b;
  });
  _swingReplay.arcGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  _swingReplay.arcGeo.setAttribute("color", new THREE.BufferAttribute(colorArr, 3));
  _swingReplay.arcGeo.attributes.position.needsUpdate = true;
  _swingReplay.arcGeo.attributes.color.needsUpdate = true;

  renderKeyMoments(swing);
  renderMarkerTicks(swing);
  buildReplayChart(samples.map((s) => s.t), speeds, faceAngles);

  document.getElementById("panel2-empty-note").style.display = "none";
  document.getElementById("panel2-chart-wrap").style.display = "block";
  document.getElementById("panel2-scrubber-wrap").style.display = "block";
  document.getElementById("panel2-controls").style.display = "flex";
  document.getElementById("replay-swing-label").textContent = `— Swing ${rawSwing.index + 1}`;

  setScrubberToIndex(swing, 0);
}

document.getElementById("panel2-scrubber").addEventListener("input", (e) => {
  if (!_currentSwing) return;
  _playState.playing = false;
  document.getElementById("panel2-play-btn").textContent = "▶ Play";
  const frac = parseFloat(e.target.value) / 1000;
  const targetT = frac * _currentSwing.duration;
  const idx = _currentSwing.samples.findIndex((s) => s.t >= targetT);
  setScrubberToIndex(_currentSwing, idx === -1 ? _currentSwing.samples.length - 1 : idx);
});

document.getElementById("panel2-play-btn").addEventListener("click", () => {
  if (!_currentSwing) return;
  _playState.playing = !_playState.playing;
  document.getElementById("panel2-play-btn").textContent = _playState.playing ? "⏸ Pause" : "▶ Play";
  _playState.lastFrameMs = performance.now();
  if (_playState.playing) requestAnimationFrame(advancePlayback);
});

document.getElementById("panel2-speed-select").addEventListener("change", (e) => {
  _playState.speed = parseFloat(e.target.value);
});

function advancePlayback(nowMs) {
  if (!_playState.playing || !_currentSwing) return;
  const dt = ((nowMs - _playState.lastFrameMs) / 1000) * _playState.speed;
  _playState.lastFrameMs = nowMs;
  const curT = parseFloat(document.getElementById("panel2-scrubber").value) / 1000 * _currentSwing.duration;
  const nextT = curT + dt;
  if (nextT >= _currentSwing.duration) {
    setScrubberToIndex(_currentSwing, _currentSwing.samples.length - 1);
    _playState.playing = false;
    document.getElementById("panel2-play-btn").textContent = "▶ Play";
    return;
  }
  const idx = _currentSwing.samples.findIndex((s) => s.t >= nextT);
  setScrubberToIndex(_currentSwing, idx === -1 ? _currentSwing.samples.length - 1 : idx);
  requestAnimationFrame(advancePlayback);
}

document.addEventListener("gs:swing", (e) => {
  loadSwingIntoReplay(e.detail);
});
