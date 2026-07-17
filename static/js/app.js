// GolfSense core: socket connection, connection panel, top status bar.
// View-specific logic (Raw Data, Waveforms, etc.) lives in later JS files.

const socket = io();
window.socket = socket;
window.latestSample = {};

const state = {
  connected: false,
  activePort: null,
  frameHz: 0,
};

window.golfsenseCalibration = { calibrated: false, reference: null };

function $(sel) { return document.querySelector(sel); }

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.classList.add("toast-out"), 2600);
  setTimeout(() => el.remove(), 3000);
}
window.showToast = showToast;

function showView(name) {
  document.querySelectorAll("#view-container .view").forEach((el) => {
    el.style.display = el.id === `view-${name}` ? "block" : "none";
  });
}

$("#view-select").addEventListener("change", (e) => showView(e.target.value));

function renderStatus() {
  const led = $("#sensor-led");
  const label = $("#sensor-status-label");
  if (state.connected) {
    led.className = "led connected";
    label.textContent = `Connected (${state.activePort})`;
  } else {
    led.className = "led";
    label.textContent = "Disconnected";
  }
  $("#frame-rate-chip").textContent = `${state.frameHz} Hz`;
}

function renderPortList(ports) {
  const list = $("#port-list");
  list.innerHTML = "";
  if (!ports.length) {
    list.innerHTML = '<div style="color:var(--text-dim)">No COM ports found.</div>';
    return;
  }
  for (const p of ports) {
    const row = document.createElement("div");
    row.className = "port-row";
    row.innerHTML = `
      <span class="port-name">${p.port}</span>
      <span class="port-desc">${p.description}</span>
      <span class="signal-badge ${p.signal_strength}">${p.signal_strength}</span>
      <button data-port="${p.port}">Connect</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      $("#sensor-led").className = "led searching";
      $("#sensor-status-label").textContent = "Connecting...";
      socket.emit("connect_port", { port: p.port });
    });
    list.appendChild(row);
  }
}

$("#rescan-btn").addEventListener("click", () => {
  $("#port-list").innerHTML = '<div style="color:var(--text-dim)">Scanning...</div>';
  socket.emit("scan_ports");
});

$("#disconnect-btn").addEventListener("click", () => {
  socket.emit("disconnect_port");
});

$("#calibrate-btn").addEventListener("click", () => {
  socket.emit("calibrate_address");
});

function renderCalibration() {
  const cal = window.golfsenseCalibration;
  const dot = $("#calibration-dot");
  const label = $("#calibration-label");
  dot.className = cal.calibrated ? "led connected" : "led";
  label.textContent = cal.calibrated ? "Calibrated ✓" : "Not Calibrated";
}

socket.on("calibration_status", (data) => {
  window.golfsenseCalibration = { calibrated: data.calibrated, reference: data.reference || null };
  renderCalibration();
  if (data.calibrated) showToast("Calibrated ✓ — angles now relative to address");
});

socket.on("connect", () => {
  socket.emit("scan_ports");
});

socket.on("port_list", (data) => renderPortList(data.ports));

socket.on("connection_status", (data) => {
  state.connected = data.connected;
  state.activePort = data.port;
  renderStatus();
  $("#connection-panel").style.display = data.connected ? "none" : "block";
  $("#view-container").style.display = data.connected ? "block" : "none";
  $("#disconnect-btn").style.display = data.connected ? "inline-block" : "none";
  $("#calibrate-btn").style.display = data.connected ? "inline-block" : "none";
  $("#calibration-chip").style.display = data.connected ? "flex" : "none";
  if (data.connected) showView($("#view-select").value);
});

socket.on("swing_captured", (data) => {
  console.log("swing_captured", data);
  showToast(`Swing ${data.index + 1} captured ✓ (${data.duration.toFixed(2)}s)`);
  document.dispatchEvent(new CustomEvent("gs:swing", { detail: data }));
});

socket.on("frame_rate", (data) => {
  state.frameHz = data.hz;
  renderStatus();
});

let sampleCount = 0;
let lastLogTime = 0;
socket.on("sensor_data", (sample) => {
  sampleCount++;
  window.latestSample = sample;
  const now = performance.now();
  if (now - lastLogTime > 1000) {
    lastLogTime = now;
    console.log("sensor_data (sampled 1/sec):", sample);
  }
  $("#sample-counter").textContent = `${sampleCount} samples received`;
  document.dispatchEvent(new CustomEvent("gs:sample", { detail: sample }));
});

showView("golfsense");
renderStatus();
