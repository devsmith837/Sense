// GolfSense - witmotion.js
// Clones of the WitMotion Minimu.exe utility panels: Raw Data table and
// Waveforms charts. (Attitude / 3D Sensor / Configuration / Recording views
// are added in later build steps.)

// ---------------- Raw Data view ----------------

const RAWDATA_FIELDS = [
  { key: "acc_ax", dp: 3 }, { key: "acc_ay", dp: 3 }, { key: "acc_az", dp: 3 },
  { key: "gyro_wx", dp: 2 }, { key: "gyro_wy", dp: 2 }, { key: "gyro_wz", dp: 2 },
  { key: "angle_roll", dp: 2 }, { key: "angle_pitch", dp: 2 }, { key: "angle_yaw", dp: 2 },
  { key: "mag_hx", dp: 1 }, { key: "mag_hy", dp: 1 }, { key: "mag_hz", dp: 1 },
  { key: "quat_q0", dp: 4 }, { key: "quat_q1", dp: 4 }, { key: "quat_q2", dp: 4 }, { key: "quat_q3", dp: 4 },
];

const _prevRawValues = {};

function renderRawDataRow() {
  const sample = window.latestSample;
  const body = document.getElementById("rawdata-body");
  if (!sample || sample.t === undefined) return;

  const d = new Date(sample.t * 1000);
  const tStr = d.toLocaleTimeString("en-US", { hour12: false }) +
    "." + String(Math.floor((sample.t % 1) * 1000)).padStart(3, "0");

  let html = `<tr><td>${tStr}</td>`;
  for (const f of RAWDATA_FIELDS) {
    const v = sample[f.key];
    if (v === undefined) {
      html += `<td class="zero">—</td>`;
      continue;
    }
    const changed = _prevRawValues[f.key] !== undefined && Math.abs(_prevRawValues[f.key] - v) > 1e-6;
    const isZero = Math.abs(v) < 0.005;
    _prevRawValues[f.key] = v;
    html += `<td class="${changed ? "changed" : ""} ${isZero ? "zero" : ""}">${v.toFixed(f.dp)}</td>`;
  }
  html += "</tr>";
  body.innerHTML = html;
}

setInterval(() => {
  const view = document.getElementById("view-rawdata");
  if (view && view.style.display !== "none") renderRawDataRow();
}, 100);

// ---------------- Waveforms view ----------------

const WAVEFORM_DEFS = [
  {
    id: "accel", title: "Acceleration (g)", min: -16, max: 16,
    fields: [
      { key: "acc_ax", label: "X", color: "#e74c3c" },
      { key: "acc_ay", label: "Y", color: "#2ecc71" },
      { key: "acc_az", label: "Z", color: "#3498db" },
    ],
  },
  {
    id: "gyro", title: "Angular Velocity (°/s)", min: -2000, max: 2000,
    fields: [
      { key: "gyro_wx", label: "X", color: "#e74c3c" },
      { key: "gyro_wy", label: "Y", color: "#2ecc71" },
      { key: "gyro_wz", label: "Z", color: "#3498db" },
    ],
  },
  {
    id: "angle", title: "Angle - Roll / Pitch / Yaw (°)", min: -180, max: 180,
    fields: [
      { key: "angle_roll", label: "Roll", color: "#e74c3c" },
      { key: "angle_pitch", label: "Pitch", color: "#2ecc71" },
      { key: "angle_yaw", label: "Yaw", color: "#3498db" },
    ],
  },
  {
    id: "mag", title: "Magnetic Field (µT)", autoscale: true,
    fields: [
      { key: "mag_hx", label: "X", color: "#e74c3c" },
      { key: "mag_hy", label: "Y", color: "#2ecc71" },
      { key: "mag_hz", label: "Z", color: "#3498db" },
    ],
  },
  {
    id: "quat", title: "Quaternion", min: -1, max: 1,
    fields: [
      { key: "quat_q0", label: "Q0", color: "#e74c3c" },
      { key: "quat_q1", label: "Q1", color: "#2ecc71" },
      { key: "quat_q2", label: "Q2", color: "#3498db" },
      { key: "quat_q3", label: "Q3", color: "#f1c40f" },
    ],
  },
  {
    id: "temp", title: "Temperature (°C)", autoscale: true,
    fields: [{ key: "acc_temp", label: "Temp", color: "#e67e22" }],
  },
];

function createWaveformCard(def) {
  const card = document.createElement("div");
  card.className = "waveform-card";
  card.innerHTML = `
    <div class="waveform-header">
      <h3>${def.title}</h3>
      <div class="axis-toggles">
        ${def.fields.map((f, i) => `<label><input type="checkbox" checked data-idx="${i}"> ${f.label}</label>`).join("")}
      </div>
      <select class="window-select">
        <option value="1">1s</option>
        <option value="5" selected>5s</option>
        <option value="10">10s</option>
        <option value="30">30s</option>
      </select>
      <button class="small secondary pause-btn" type="button">Pause</button>
    </div>
    <canvas></canvas>
  `;

  const chart = new Chart(card.querySelector("canvas").getContext("2d"), {
    type: "line",
    data: {
      datasets: def.fields.map((f) => ({
        label: f.label, borderColor: f.color, backgroundColor: f.color,
        data: [], borderWidth: 1.5, pointRadius: 0, tension: 0.15,
      })),
    },
    options: {
      animation: false,
      parsing: false,
      scales: {
        x: { type: "linear", min: -5, max: 0, ticks: { color: "#9aa1ac" }, grid: { color: "#333843" } },
        y: { min: def.min, max: def.max, ticks: { color: "#9aa1ac" }, grid: { color: "#333843" } },
      },
      plugins: { legend: { display: false } },
    },
  });

  let windowSec = 5;
  let paused = false;
  const buffer = [];

  card.querySelector(".window-select").addEventListener("change", (e) => {
    windowSec = parseFloat(e.target.value);
  });
  card.querySelector(".pause-btn").addEventListener("click", (e) => {
    paused = !paused;
    e.target.textContent = paused ? "Resume" : "Pause";
  });
  card.querySelectorAll(".axis-toggles input").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      chart.data.datasets[idx].hidden = !e.target.checked;
    });
  });

  function pushSample(sample) {
    if (paused) return;
    const values = def.fields.map((f) => sample[f.key]);
    if (values.some((v) => v === undefined)) return;
    buffer.push({ t: Date.now() / 1000, values });
    const cutoff = Date.now() / 1000 - 30;
    while (buffer.length && buffer[0].t < cutoff) buffer.shift();
  }

  function render() {
    if (paused) return;
    const now = Date.now() / 1000;
    const cutoff = now - windowSec;
    const visible = buffer.filter((pt) => pt.t >= cutoff);

    if (def.autoscale) {
      let lo = Infinity, hi = -Infinity;
      for (const pt of visible) {
        for (const v of pt.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      if (lo === Infinity) { lo = -1; hi = 1; }
      const pad = (hi - lo) * 0.15 || 1;
      chart.options.scales.y.min = lo - pad;
      chart.options.scales.y.max = hi + pad;
    }

    def.fields.forEach((f, i) => {
      chart.data.datasets[i].data = visible.map((pt) => ({ x: pt.t - now, y: pt.values[i] }));
    });
    chart.options.scales.x.min = -windowSec;
    chart.options.scales.x.max = 0;
    chart.update("none");
  }

  return { el: card, pushSample, render };
}

const _waveformCards = WAVEFORM_DEFS.map(createWaveformCard);
const _waveformsGrid = document.getElementById("waveforms-grid");
_waveformCards.forEach((c) => _waveformsGrid.appendChild(c.el));

document.addEventListener("gs:sample", (e) => {
  _waveformCards.forEach((c) => c.pushSample(e.detail));
});

setInterval(() => {
  const view = document.getElementById("view-waveforms");
  if (view && view.style.display !== "none") {
    _waveformCards.forEach((c) => c.render());
  }
}, 100);

// ---------------- Configuration view ----------------

function currentContentFields() {
  return Array.from(document.querySelectorAll(".cfg-content:checked")).map((cb) => cb.value);
}

document.getElementById("cfg-rate").addEventListener("change", (e) => {
  socket.emit("config_set_rate", { hz: parseFloat(e.target.value) });
  showToast(`Output rate set to ${e.target.value} Hz`);
});

document.getElementById("cfg-bandwidth").addEventListener("change", (e) => {
  socket.emit("config_set_bandwidth", { hz: parseFloat(e.target.value) });
  showToast(`Bandwidth set to ${e.target.value} Hz`);
});

document.querySelectorAll('input[name="cfg-algo"]').forEach((r) => {
  r.addEventListener("change", (e) => {
    if (!e.target.checked) return;
    const axis6 = e.target.value === "6";
    socket.emit("config_set_algorithm", { axis6 });
    showToast(`Algorithm set to ${axis6 ? "6-axis" : "9-axis"}`);
  });
});

document.querySelectorAll('input[name="cfg-dir"]').forEach((r) => {
  r.addEventListener("change", (e) => {
    if (!e.target.checked) return;
    const vertical = e.target.value === "v";
    socket.emit("config_set_direction", { vertical });
    showToast(`Installation direction set to ${vertical ? "vertical" : "horizontal"}`);
  });
});

document.querySelectorAll(".cfg-content").forEach((cb) => {
  cb.addEventListener("change", () => {
    socket.emit("config_set_content", { fields: currentContentFields() });
    showToast("Output content updated");
  });
});

document.getElementById("cfg-read-btn").addEventListener("click", () => {
  socket.emit("config_read");
});

document.getElementById("cfg-save-btn").addEventListener("click", () => {
  socket.emit("config_save");
  showToast("Config saved to sensor ✓");
});

document.getElementById("cfg-factory-btn").addEventListener("click", () => {
  if (confirm("Factory reset will erase all sensor configuration and restore defaults. Continue?")) {
    socket.emit("config_factory_reset");
    showToast("Factory reset sent", "error");
  }
});

socket.on("config_state", (cfg) => {
  const contentStr = Array.isArray(cfg.content) ? cfg.content.join(", ") : "unknown";
  document.getElementById("cfg-current").textContent =
    `Last commanded config (not a verified hardware readback):\n` +
    `Rate: ${cfg.rate ?? "unknown"} Hz | Bandwidth: ${cfg.bandwidth ?? "unknown"} Hz\n` +
    `Algorithm: ${cfg.algorithm ?? "unknown"} | Direction: ${cfg.direction ?? "unknown"}\n` +
    `Content: ${contentStr}`;

  if (cfg.rate) document.getElementById("cfg-rate").value = String(cfg.rate);
  if (cfg.bandwidth) document.getElementById("cfg-bandwidth").value = String(cfg.bandwidth);
});

// -- Accelerometer calibration: 3s countdown + progress bar --
document.getElementById("cal-accel-btn").addEventListener("click", () => {
  socket.emit("config_start_accel_cal");
  const box = document.getElementById("cal-accel-progress");
  const fill = document.getElementById("cal-accel-fill");
  const label = document.getElementById("cal-accel-label");
  box.style.display = "block";
  fill.style.width = "0%";
  const durationMs = 3000;
  const startT = performance.now();
  const timer = setInterval(() => {
    const elapsed = performance.now() - startT;
    const pct = Math.min(100, (elapsed / durationMs) * 100);
    fill.style.width = `${pct}%`;
    const secLeft = Math.max(0, Math.ceil((durationMs - elapsed) / 1000));
    label.textContent = `Keep club perfectly still... ${secLeft}`;
    if (elapsed >= durationMs) {
      clearInterval(timer);
      socket.emit("config_stop_accel_cal");
      box.style.display = "none";
      showToast("Accelerometer calibrated ✓");
    }
  }, 50);
});

// -- Magnetic field calibration: rotation instruction, user-ended --
document.getElementById("cal-mag-btn").addEventListener("click", () => {
  socket.emit("config_start_mag_cal");
  document.getElementById("cal-mag-anim").style.display = "block";
});

document.getElementById("cal-mag-done-btn").addEventListener("click", () => {
  socket.emit("config_stop_mag_cal");
  document.getElementById("cal-mag-anim").style.display = "none";
  showToast("Magnetic field calibrated ✓");
});

// -- Gyroscope auto-calibration: guided keep-still countdown --
// (BWT901CL firmware auto-calibrates gyro bias while stationary; there is no
// separate documented start/stop register distinct from accel cal, so this
// is a guided UX rather than a distinct protocol command.)
document.getElementById("cal-gyro-btn").addEventListener("click", () => {
  const box = document.getElementById("cal-gyro-progress");
  const fill = document.getElementById("cal-gyro-fill");
  const label = document.getElementById("cal-gyro-label");
  box.style.display = "block";
  fill.style.width = "0%";
  const durationMs = 2000;
  const startT = performance.now();
  const timer = setInterval(() => {
    const elapsed = performance.now() - startT;
    const pct = Math.min(100, (elapsed / durationMs) * 100);
    fill.style.width = `${pct}%`;
    const secLeft = Math.max(0, Math.ceil((durationMs - elapsed) / 1000));
    label.textContent = `Keep sensor still... ${secLeft}`;
    if (elapsed >= durationMs) {
      clearInterval(timer);
      box.style.display = "none";
      showToast("Gyroscope calibrated ✓");
    }
  }, 50);
});

document.getElementById("cal-resetz-btn").addEventListener("click", () => {
  socket.emit("config_reset_z");
  showToast("Z-axis angle reset to 0 ✓");
});

document.getElementById("cal-setref-btn").addEventListener("click", () => {
  socket.emit("config_set_angle_ref");
  showToast("Angle reference set ✓");
});

// ---------------- Attitude view ----------------

function updateAttitude(sample) {
  const roll = sample.angle_roll ?? 0;
  const pitch = sample.angle_pitch ?? 0;
  const yaw = sample.angle_yaw ?? 0;

  document.getElementById("ah-horizon").setAttribute(
    "transform", `rotate(${roll} 150 150) translate(0 ${-pitch * 3})`);
  document.getElementById("compass-needle").setAttribute(
    "transform", `rotate(${yaw} 150 150)`);

  document.getElementById("att-roll").textContent = roll.toFixed(1) + "°";
  document.getElementById("att-pitch").textContent = pitch.toFixed(1) + "°";
  document.getElementById("att-yaw").textContent = yaw.toFixed(1) + "°";
  document.getElementById("att-ax").textContent = (sample.acc_ax ?? 0).toFixed(3);
  document.getElementById("att-ay").textContent = (sample.acc_ay ?? 0).toFixed(3);
  document.getElementById("att-az").textContent = (sample.acc_az ?? 0).toFixed(3);
  document.getElementById("att-gx").textContent = (sample.gyro_wx ?? 0).toFixed(1);
  document.getElementById("att-gy").textContent = (sample.gyro_wy ?? 0).toFixed(1);
  document.getElementById("att-gz").textContent = (sample.gyro_wz ?? 0).toFixed(1);
}

document.addEventListener("gs:sample", (e) => {
  const view = document.getElementById("view-attitude");
  if (view && view.style.display !== "none") updateAttitude(e.detail);
});

// ---------------- 3D Sensor view ----------------

function initSensor3D() {
  const canvas = document.getElementById("sensor3d-canvas");
  const wrap = document.getElementById("sensor3d-canvas-wrap");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1e2128);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const defaultCamPos = new THREE.Vector3(6, 5, 8);
  const defaultTarget = new THREE.Vector3(0, 1.5, 0);
  camera.position.copy(defaultCamPos);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.copy(defaultTarget);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);

  scene.add(new THREE.GridHelper(20, 20, 0x444a55, 0x2a2e37));

  const boxGeo = new THREE.BoxGeometry(4, 0.6, 2.4);
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x3ea6ff, metalness: 0.2, roughness: 0.6 });
  const box = new THREE.Mesh(boxGeo, boxMat);
  box.position.y = 1.5;
  scene.add(box);

  const edges = new THREE.EdgesGeometry(boxGeo);
  box.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff })));

  const axisLen = 3;
  box.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), axisLen, 0xe74c3c, 0.4, 0.25));
  box.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), axisLen, 0x2ecc71, 0.4, 0.25));
  box.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), axisLen, 0x3498db, 0.4, 0.25));

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

  document.getElementById("sensor3d-reset-btn").addEventListener("click", () => {
    camera.position.copy(defaultCamPos);
    controls.target.copy(defaultTarget);
    controls.update();
  });

  return { box, camera, controls };
}

const _sensor3d = initSensor3D();

document.addEventListener("gs:sample", (e) => {
  const view = document.getElementById("view-sensor3d");
  if (view && view.style.display !== "none") {
    const s = e.detail;
    if (s.quat_q0 !== undefined) {
      _sensor3d.box.quaternion.set(s.quat_q1, s.quat_q2, s.quat_q3, s.quat_q0);
    }
  }
});

// ---------------- Recording view ----------------

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

document.getElementById("record-start-btn").addEventListener("click", () => {
  socket.emit("recording_start");
});
document.getElementById("record-stop-btn").addEventListener("click", () => {
  socket.emit("recording_stop");
});

socket.on("recording_status", (data) => {
  const led = document.getElementById("record-led");
  const label = document.getElementById("record-status-label");
  led.className = data.recording ? "led recording" : "led";
  label.textContent = data.recording ? "Recording..." : "Not recording";
  document.getElementById("record-duration").textContent = `${data.duration.toFixed(1)}s`;
  document.getElementById("record-sample-count").textContent = data.sample_count;
  document.getElementById("record-start-btn").disabled = data.recording;
  document.getElementById("record-stop-btn").disabled = !data.recording;
});

socket.on("recording_saved", (data) => {
  if (data) showToast(`Session saved: ${data.filename} (${data.sample_count} samples)`);
});

function renderRecordingList(files) {
  const tbody = document.getElementById("recording-file-tbody");
  tbody.innerHTML = "";
  if (!files.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-dim);">No recordings yet.</td></tr>';
    return;
  }
  for (const f of files) {
    const row = document.createElement("tr");
    const date = new Date(f.mtime * 1000).toLocaleString();
    const durationS = ((f.sample_count || 0) / 200).toFixed(1);
    row.innerHTML = `
      <td>${f.filename}</td>
      <td>${date}</td>
      <td>${durationS}s</td>
      <td>${f.sample_count}</td>
      <td>${formatBytes(f.size_bytes)}</td>
      <td>
        <button class="secondary load-btn">Load</button>
        <button class="secondary export-btn">Export CSV</button>
      </td>
    `;
    row.querySelector(".load-btn").addEventListener("click", () => {
      socket.emit("load_recording", { filename: f.filename });
    });
    row.querySelector(".export-btn").addEventListener("click", () => {
      socket.emit("export_csv", { filename: f.filename });
    });
    tbody.appendChild(row);
  }
}

socket.on("recording_list", (data) => renderRecordingList(data.files));

socket.on("playback_loaded", (data) => {
  document.getElementById("playback-current-file").textContent = `Loaded: ${data.filename} (${data.total} samples)`;
  document.getElementById("playback-progress-fill").style.width = "0%";
  document.getElementById("playback-progress-label").textContent = `0 / ${data.total} samples`;
});

document.getElementById("playback-play-btn").addEventListener("click", () => {
  socket.emit("playback_play");
});
document.getElementById("playback-pause-btn").addEventListener("click", () => {
  socket.emit("playback_pause");
});
document.getElementById("playback-stop-btn").addEventListener("click", () => {
  socket.emit("playback_stop");
});
document.getElementById("playback-speed-select").addEventListener("change", (e) => {
  socket.emit("playback_set_speed", { speed: parseFloat(e.target.value) });
});

socket.on("playback_progress", (data) => {
  const pct = data.total ? (data.index / data.total) * 100 : 0;
  document.getElementById("playback-progress-fill").style.width = `${pct}%`;
  document.getElementById("playback-progress-label").textContent = `${data.index} / ${data.total} samples`;
});

socket.on("playback_status", (data) => {
  if (!data.playing) showToast("Playback finished");
});

socket.on("csv_exported", (data) => {
  showToast(`CSV exported: ${data.filename}`);
});
