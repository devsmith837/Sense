// GolfSense - golfsense.js
// Golf-specific panel logic that isn't 3D rendering (see three_driver.js /
// three_swing.js for those). Panel 3 (impact zone / strike map) lives here.

const FACE_MAX_DELTA_DEG = 10; // heel/toe and high/low deltas beyond this pin to the face edge
const STRIKE_TENDENCY_THRESHOLD_DEG = 2.0; // beyond this, call it a heel/toe/high/low strike

function buildFaceGrid() {
  const svg = document.getElementById("panel3-face-svg");
  const NS = "http://www.w3.org/2000/svg";
  const left = 20, top = 20, size = 160, cell = size / 5;

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("x", left); bg.setAttribute("y", top);
  bg.setAttribute("width", size); bg.setAttribute("height", size);
  bg.setAttribute("fill", "#2a2e37"); bg.setAttribute("rx", 4);
  svg.appendChild(bg);

  for (let i = 1; i < 5; i++) {
    const x = left + i * cell;
    const vline = document.createElementNS(NS, "line");
    vline.setAttribute("x1", x); vline.setAttribute("y1", top);
    vline.setAttribute("x2", x); vline.setAttribute("y2", top + size);
    vline.setAttribute("stroke", "#3a3f4a"); vline.setAttribute("stroke-width", 1);
    svg.appendChild(vline);

    const y = top + i * cell;
    const hline = document.createElementNS(NS, "line");
    hline.setAttribute("x1", left); hline.setAttribute("y1", y);
    hline.setAttribute("x2", left + size); hline.setAttribute("y2", y);
    hline.setAttribute("stroke", "#3a3f4a"); hline.setAttribute("stroke-width", 1);
    svg.appendChild(hline);
  }

  const outline = document.createElementNS(NS, "rect");
  outline.setAttribute("x", left); outline.setAttribute("y", top);
  outline.setAttribute("width", size); outline.setAttribute("height", size);
  outline.setAttribute("fill", "none"); outline.setAttribute("stroke", "#555");
  outline.setAttribute("stroke-width", 1.5); outline.setAttribute("rx", 4);
  svg.appendChild(outline);

  const labels = [
    ["CROWN", left + size / 2, top - 6, "middle"],
    ["SOLE", left + size / 2, top + size + 14, "middle"],
    ["HEEL", left - 4, top + size / 2, "end"],
    ["TOE", left + size + 4, top + size / 2, "start"],
  ];
  for (const [text, x, y, anchor] of labels) {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", x); t.setAttribute("y", y);
    t.setAttribute("text-anchor", anchor); t.setAttribute("fill", "#9aa1ac");
    t.setAttribute("font-size", "9"); t.textContent = text;
    svg.appendChild(t);
  }

  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("id", "panel3-impact-dot");
  dot.setAttribute("r", 7);
  dot.setAttribute("stroke", "#0d0f13");
  dot.setAttribute("stroke-width", 1.5);
  svg.appendChild(dot);

  return { left, top, size, cell };
}

const _faceGrid = buildFaceGrid();

function zoneClassification(heelToeDeg, highLowDeg) {
  const clampFrac = (v) => Math.max(-1, Math.min(1, v / FACE_MAX_DELTA_DEG));
  const fracX = 0.5 - clampFrac(heelToeDeg) / 2;
  const fracY = 0.5 - clampFrac(highLowDeg) / 2;
  const col = Math.max(0, Math.min(4, Math.floor(fracX * 5)));
  const row = Math.max(0, Math.min(4, Math.floor(fracY * 5)));
  const colDist = Math.abs(col - 2), rowDist = Math.abs(row - 2);
  const dist = Math.max(colDist, rowDist);
  let color, quality;
  if (dist <= 1) { color = "#2ecc71"; quality = "sweet spot"; }
  else if (colDist === 2 && rowDist === 2) { color = "#e74c3c"; quality = "edge"; }
  else { color = "#f1c40f"; quality = "adjacent"; }
  return { fracX, fracY, color, quality };
}

function gearEffectMessage(heelToeDeg, highLowDeg) {
  const absHeelToe = Math.abs(heelToeDeg), absHighLow = Math.abs(highLowDeg);
  if (absHeelToe < STRIKE_TENDENCY_THRESHOLD_DEG && absHighLow < STRIKE_TENDENCY_THRESHOLD_DEG) {
    return "Center: Optimal gear effect — maximum energy transfer";
  }
  if (absHeelToe >= absHighLow) {
    return heelToeDeg > 0
      ? "Heel strike: Fade/Slice spin — gear effect opens the face at impact"
      : "Toe strike: Draw/Hook spin — gear effect closes the face at impact";
  }
  return highLowDeg > 0
    ? "High strike (above CG): Lower spin, more roll — high launch"
    : "Low strike (below CG): Higher spin, less distance";
}

function renderAttackGauge(attackAngleDeg) {
  const svg = document.getElementById("panel3-attack-svg");
  const NS = "http://www.w3.org/2000/svg";
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const cx = 100, cy = 80, r = 65;
  const arc = document.createElementNS(NS, "path");
  arc.setAttribute("d", `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`);
  arc.setAttribute("fill", "none"); arc.setAttribute("stroke", "#3a3f4a"); arc.setAttribute("stroke-width", 8);
  svg.appendChild(arc);

  const clamped = Math.max(-15, Math.min(15, attackAngleDeg));
  const angleRad = (clamped / 15) * (Math.PI / 2); // -15..+15deg -> -90..+90deg needle sweep
  const nx = cx + r * Math.sin(angleRad);
  const ny = cy - r * Math.cos(angleRad);

  let color;
  if (attackAngleDeg >= 1) color = "#2ecc71";
  else if (attackAngleDeg > -1) color = "#f1c40f";
  else color = attackAngleDeg > -5 ? "#e67e22" : "#e74c3c";

  const needle = document.createElementNS(NS, "line");
  needle.setAttribute("x1", cx); needle.setAttribute("y1", cy);
  needle.setAttribute("x2", nx); needle.setAttribute("y2", ny);
  needle.setAttribute("stroke", color); needle.setAttribute("stroke-width", 3);
  needle.setAttribute("stroke-linecap", "round");
  svg.appendChild(needle);

  const hub = document.createElementNS(NS, "circle");
  hub.setAttribute("cx", cx); hub.setAttribute("cy", cy); hub.setAttribute("r", 4);
  hub.setAttribute("fill", color);
  svg.appendChild(hub);

  const label = document.getElementById("panel3-attack-label");
  const desc = attackAngleDeg >= 1 ? "ascending" : (attackAngleDeg > -1 ? "level" : "descending");
  const check = attackAngleDeg >= 1 && attackAngleDeg <= 5 ? " ✓" : "";
  label.textContent = `Angle of Attack: ${attackAngleDeg >= 0 ? "+" : ""}${attackAngleDeg.toFixed(1)}° (${desc})${check}`;
  label.style.color = color;
}

function updateImpactPanel(rawSwing) {
  const km = rawSwing.key_moments;
  if (!km || rawSwing.arc_bottom_index === null || rawSwing.arc_bottom_index === undefined) {
    document.getElementById("panel3-empty-note").style.display = "flex";
    document.getElementById("panel3-empty-note").textContent = "No clean impact detected for this swing.";
    document.getElementById("panel3-content").style.display = "none";
    return;
  }
  const impactSample = rawSwing.samples[rawSwing.arc_bottom_index];
  const ref = rawSwing.address_reference;
  const refRoll = ref ? ref.roll : 0;
  const refPitch = ref ? ref.pitch : 0;

  const heelToeDeg = (impactSample.roll ?? 0) - refRoll;
  const attackAngleDeg = (impactSample.pitch ?? 0) - refPitch;

  const zone = zoneClassification(heelToeDeg, attackAngleDeg);
  const dot = document.getElementById("panel3-impact-dot");
  const cx = _faceGrid.left + zone.fracX * _faceGrid.size;
  const cy = _faceGrid.top + zone.fracY * _faceGrid.size;
  dot.setAttribute("cx", cx);
  dot.setAttribute("cy", cy);
  dot.setAttribute("fill", zone.color);

  document.getElementById("panel3-gear-label").textContent = gearEffectMessage(heelToeDeg, attackAngleDeg);
  renderAttackGauge(attackAngleDeg);

  document.getElementById("panel3-empty-note").style.display = "none";
  document.getElementById("panel3-content").style.display = "flex";
}

document.addEventListener("gs:swing", (e) => updateImpactPanel(e.detail));

// ---------------- Panel 4: ball flight prediction ----------------

function shotShapeColor(shape) {
  if (shape === "STRAIGHT") return "#2ecc71";
  if (shape === "FADE" || shape === "DRAW") return "#f1c40f";
  if (shape === "PUSH" || shape === "PULL") return "#e67e22";
  return "#e74c3c"; // SLICE / HOOK / PUSH-SLICE / PULL-HOOK
}

function renderBallFlight(bf) {
  const emptyNote = document.getElementById("panel4-empty-note");
  const content = document.getElementById("panel4-content");
  if (!bf) {
    emptyNote.style.display = "flex";
    emptyNote.textContent = "No clean impact detected for this swing.";
    content.style.display = "none";
    return;
  }

  const svg = document.getElementById("panel4-fairway-svg");
  const NS = "http://www.w3.org/2000/svg";
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const teeX = 100, teeY = 250;
  const forwardScale = 220 / 260;
  const carryPx = Math.min(230, bf.carry_yards * forwardScale);
  const landingY = teeY - carryPx;
  const lateralScale = 4;
  const clampLat = (v) => Math.max(-75, Math.min(75, v));
  const startOffsetX = clampLat(bf.start_direction_deg * lateralScale);
  const totalOffsetX = clampLat((bf.start_direction_deg + bf.curve_deg) * lateralScale);
  const landingX = teeX + totalOffsetX;
  const controlX = teeX + startOffsetX;
  const controlY = teeY - carryPx * 0.4;
  const color = shotShapeColor(bf.shot_shape);

  const fairway = document.createElementNS(NS, "rect");
  fairway.setAttribute("x", 40); fairway.setAttribute("y", 10);
  fairway.setAttribute("width", 120); fairway.setAttribute("height", 240);
  fairway.setAttribute("fill", "#1e3a24"); fairway.setAttribute("rx", 6);
  svg.appendChild(fairway);

  const targetLine = document.createElementNS(NS, "line");
  targetLine.setAttribute("x1", teeX); targetLine.setAttribute("y1", teeY);
  targetLine.setAttribute("x2", teeX); targetLine.setAttribute("y2", 15);
  targetLine.setAttribute("stroke", "#4a7a52"); targetLine.setAttribute("stroke-width", 1.5);
  targetLine.setAttribute("stroke-dasharray", "4 4");
  svg.appendChild(targetLine);

  const dirLen = 28;
  const dirRad = (bf.start_direction_deg * Math.PI) / 180;
  const dirEndX = teeX + Math.sin(dirRad) * dirLen;
  const dirEndY = teeY - Math.cos(dirRad) * dirLen;
  const dirLine = document.createElementNS(NS, "line");
  dirLine.setAttribute("x1", teeX); dirLine.setAttribute("y1", teeY);
  dirLine.setAttribute("x2", dirEndX); dirLine.setAttribute("y2", dirEndY);
  dirLine.setAttribute("stroke", "#fff"); dirLine.setAttribute("stroke-width", 2);
  svg.appendChild(dirLine);

  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", `M ${teeX} ${teeY} Q ${controlX} ${controlY} ${landingX} ${landingY}`);
  path.setAttribute("fill", "none"); path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", 2.5);
  svg.appendChild(path);

  const landing = document.createElementNS(NS, "circle");
  landing.setAttribute("cx", landingX); landing.setAttribute("cy", landingY);
  landing.setAttribute("r", 5); landing.setAttribute("fill", color);
  landing.setAttribute("stroke", "#0d0f13"); landing.setAttribute("stroke-width", 1.5);
  svg.appendChild(landing);

  const tee = document.createElementNS(NS, "circle");
  tee.setAttribute("cx", teeX); tee.setAttribute("cy", teeY);
  tee.setAttribute("r", 3.5); tee.setAttribute("fill", "#fff");
  svg.appendChild(tee);

  const shapeLabel = document.getElementById("panel4-shape-label");
  shapeLabel.textContent = bf.shot_shape;
  shapeLabel.style.color = color;
  document.getElementById("panel4-carry").textContent = `Carry: ~${Math.round(bf.carry_yards)} yd (rough est.)`;
  document.getElementById("panel4-curve").textContent = `Curve: ${bf.curve_deg >= 0 ? "+" : ""}${bf.curve_deg.toFixed(1)}°`;

  emptyNote.style.display = "none";
  content.style.display = "flex";
}

document.addEventListener("gs:swing", (e) => renderBallFlight(e.detail.ball_flight));

// ---------------- Panel 5: swing diagnosis ----------------

function renderDiagnosis(tips) {
  const emptyNote = document.getElementById("panel5-empty-note");
  const container = document.getElementById("panel5-tips");
  container.innerHTML = "";

  if (!tips || tips.length === 0) {
    emptyNote.style.display = "flex";
    emptyNote.textContent = "No faults detected — clean swing, or not enough data yet.";
    container.style.display = "none";
    return;
  }

  for (const tip of tips) {
    const dotIdx = tip.indexOf(". ");
    const title = dotIdx === -1 ? tip : tip.slice(0, dotIdx);
    const rest = dotIdx === -1 ? "" : tip.slice(dotIdx + 2);
    const el = document.createElement("div");
    el.className = "diagnosis-tip";
    el.innerHTML = `<b>${title}</b>${rest}`;
    container.appendChild(el);
  }

  emptyNote.style.display = "none";
  container.style.display = "flex";
}

document.addEventListener("gs:swing", (e) => renderDiagnosis(e.detail.diagnosis));

// ---------------- Panel 6: session history bar ----------------

const MAX_HISTORY_CARDS = 10;
let sessionMetrics = [];    // unbounded, for aggregate stats
let sessionCards = [];      // last N full payloads, for clickable review

function metricsFromSwing(rawSwing) {
  const ref = rawSwing.address_reference;
  const impactIdx = rawSwing.arc_bottom_index;
  if (!ref || impactIdx === null || impactIdx === undefined) return null;
  const impactSample = rawSwing.samples[impactIdx];
  const faceAngleDeg = (impactSample.roll ?? 0) - ref.roll;
  const highLowDeg = (impactSample.pitch ?? 0) - ref.pitch;
  const speedMph = rawSwing.ball_flight ? rawSwing.ball_flight.speed_mph : null;
  const shape = rawSwing.ball_flight ? rawSwing.ball_flight.shot_shape : null;
  return { faceAngleDeg, highLowDeg, speedMph, shape };
}

function renderMiniZoneSvg(heelToeDeg, highLowDeg) {
  const zone = zoneClassification(heelToeDeg, highLowDeg);
  const cx = 5 + zone.fracX * 20, cy = 5 + zone.fracY * 20;
  return `<svg class="sc-zone-svg" viewBox="0 0 30 30">
    <rect x="5" y="5" width="20" height="20" fill="#2a2e37" stroke="#555" rx="2"/>
    <circle cx="${cx}" cy="${cy}" r="3" fill="${zone.color}"/>
  </svg>`;
}

function renderSessionCards() {
  const container = document.getElementById("session-cards");
  container.innerHTML = "";
  for (const rawSwing of sessionCards) {
    const m = metricsFromSwing(rawSwing);
    const card = document.createElement("div");
    card.className = "session-card";
    if (m) {
      const absFace = Math.abs(m.faceAngleDeg);
      const faceColor = `#${faceAngleColor(absFace).toString(16).padStart(6, "0")}`;
      card.innerHTML = `
        <div class="sc-index">#${rawSwing.index + 1}</div>
        <div class="sc-face" style="color:${faceColor}">${m.faceAngleDeg >= 0 ? "+" : ""}${m.faceAngleDeg.toFixed(1)}°</div>
        <div class="sc-speed">${m.speedMph ? Math.round(m.speedMph) + " mph" : "—"}</div>
        ${renderMiniZoneSvg(m.faceAngleDeg, m.highLowDeg)}
        <div class="sc-shape" style="color:${shotShapeColor(m.shape)}">${m.shape || "—"}</div>
      `;
    } else {
      card.innerHTML = `<div class="sc-index">#${rawSwing.index + 1}</div><div class="sc-speed">No clean impact</div>`;
    }
    card.addEventListener("click", () => {
      document.querySelectorAll(".session-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      document.dispatchEvent(new CustomEvent("gs:swing", { detail: rawSwing }));
    });
    container.appendChild(card);
  }
}

function mostCommonShape() {
  const counts = {};
  let best = null, bestCount = 0;
  for (const m of sessionMetrics) {
    if (!m.shape) continue;
    counts[m.shape] = (counts[m.shape] || 0) + 1;
    if (counts[m.shape] > bestCount) { bestCount = counts[m.shape]; best = m.shape; }
  }
  return best;
}

function renderSessionSummary() {
  const withFace = sessionMetrics.filter((m) => m.faceAngleDeg !== undefined);
  if (withFace.length === 0) {
    document.getElementById("summary-avg-face").textContent = "—";
    document.getElementById("summary-face-std").textContent = "—";
    document.getElementById("summary-avg-speed").textContent = "—";
    document.getElementById("summary-common-shape").textContent = "—";
    return;
  }
  const faces = withFace.map((m) => m.faceAngleDeg);
  const avgFace = faces.reduce((a, b) => a + b, 0) / faces.length;
  const std = faces.length >= 2
    ? Math.sqrt(faces.reduce((a, b) => a + (b - avgFace) ** 2, 0) / (faces.length - 1))
    : 0;
  const speeds = withFace.map((m) => m.speedMph).filter((v) => v !== null);
  const avgSpeed = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;

  document.getElementById("summary-avg-face").textContent = `${avgFace >= 0 ? "+" : ""}${avgFace.toFixed(1)}°`;
  document.getElementById("summary-face-std").textContent = `${std.toFixed(1)}°`;
  document.getElementById("summary-avg-speed").textContent = avgSpeed ? `${Math.round(avgSpeed)} mph` : "—";
  document.getElementById("summary-common-shape").textContent = mostCommonShape() || "—";
}

document.addEventListener("gs:swing", (e) => {
  const rawSwing = e.detail;
  const m = metricsFromSwing(rawSwing);
  if (m) sessionMetrics.push(m);
  sessionCards.push(rawSwing);
  if (sessionCards.length > MAX_HISTORY_CARDS) sessionCards.shift();
  renderSessionCards();
  renderSessionSummary();
});

socket.on("connection_status", (data) => {
  if (data.connected) {
    sessionMetrics = [];
    sessionCards = [];
    renderSessionCards();
    renderSessionSummary();
  }
});
