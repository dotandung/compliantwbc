/* Interactive joint-torque vs. log|F| plot.
 *
 * Renders the same traces, palette, soft-bound lines and panel ordering as
 * `tools/plot_joint_torque_with_force.py` (see figures/joint_torque_force.js
 * for the exported series), but on a canvas the reader can pan, zoom and
 * inspect sample-by-sample.
 *
 * Two modes: "animate" sweeps the traces out from the first step to the last
 * and loops (the default), "static" draws the whole capture at once — the
 * published figure. Legend and controls sit below the canvas so nothing ever
 * covers the traces, at any screen width.
 */
(function () {
  "use strict";

  var host = document.getElementById("torqueplot");
  var data = window.__JOINT_TORQUE_FORCE;
  if (!host || !data) return;

  /* ---- palette: edit here, no re-export needed ----
   * One entry per run, in the order the exporter wrote them
   * (figures/joint_torque_force.js -> runs[]): non-compliant, then compliant.
   * Extra runs fall back to whatever colour the data carries.
   */
  var RUN_COLORS = [
    "#1374cf",  // non-compliant
    "#f8bd1b"   // compliant
  ];

  /* ---- the rest of the chart's ink ---- */
  var BG = "#ffffff";
  var GRID = "#e0e0e0";
  var SPINE = "#888888";
  var TEXT = "#222222";
  var FORCE_COLOR = "#444444"; // dark gray for the |F| trace on the twin axis
  var BOUND_COLOR = "#cc1429"; // crimson soft-τ bound
  var ZERO_LINE = "rgba(0, 0, 0, 0.3)";

  var PAD_L = 52, PAD_R = 52, PAD_T = 8, PAD_B = 34;
  var TITLE_H = 20; // band above each panel holding the joint name
  var PANEL_GAP = 14;
  var TAU_STEP = 50; // N·m between left-axis ticks
  var LOGF_STEP = 0.5;

  // Playback: 2× real time keeps a full 15 s capture to a ~7.5 s loop while
  // the time axis still reads in true seconds. HOLD is the pause on the
  // completed trace before the sweep restarts.
  var SPEED = 2.0;
  var HOLD_MS = 900;

  /* ---- data ---- */
  var t = data.t;
  var logF = data.logF;
  var runs = data.runs;
  var panels = data.panels;
  var tauMax = data.tauMax || 150;
  var n = t.length;
  var T0 = t[0], T1 = t[n - 1];
  var DT = (T1 - T0) / Math.max(n - 1, 1);

  // Twin-axis range: matplotlib autoscales log|F| with a 5% margin.
  var fLo = Infinity, fHi = -Infinity;
  for (var i = 0; i < n; i++) {
    if (logF[i] < fLo) fLo = logF[i];
    if (logF[i] > fHi) fHi = logF[i];
  }
  var fPad = 0.05 * (fHi - fLo || 1);
  fLo -= fPad; fHi += fPad;

  // Legend entries: one per run, plus the shared bound and force traces.
  var hasBound = panels.some(function (p) { return p.bound != null; });
  var series = runs.map(function (r, idx) {
    return {
      key: "run" + idx,
      name: r.name,
      color: RUN_COLORS[idx] || r.color || TEXT,
      kind: "run",
      run: idx
    };
  });
  if (hasBound) {
    series.push({ key: "bound", name: "soft τ bound", color: BOUND_COLOR, kind: "bound" });
  }
  series.push({ key: "force", name: "log|F|", color: FORCE_COLOR, kind: "force" });
  var visible = series.map(function () { return true; });
  var boundIdx = series.findIndex(function (s) { return s.kind === "bound"; });
  var forceIdx = series.findIndex(function (s) { return s.kind === "force"; });

  var view = { t0: T0, t1: T1 };
  var boxes = []; // per-panel plot rectangles, filled by draw()

  // Readers who ask for less motion get the finished figure instead of a
  // looping sweep.
  var reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var mode = reduceMotion ? "static" : "animate";
  var head = n - 1; // last sample revealed; always n-1 in static mode

  /* ---- DOM ---- */
  var stage = document.createElement("div");
  stage.className = "torqueplot-stage";
  host.appendChild(stage);

  var canvas = document.createElement("canvas");
  canvas.className = "torqueplot-canvas";
  canvas.setAttribute("tabindex", "0");
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    "Joint torque over time for " +
      panels.map(function (p) { return p.joint; }).join(" and ") +
      ", comparing " + runs.map(function (r) { return r.name; }).join(" and ") +
      " controllers against the applied perturbation magnitude. " +
      "Drag to pan, scroll to zoom; arrow keys pan when focused."
  );
  stage.appendChild(canvas);

  var tip = document.createElement("div");
  tip.className = "torqueplot-tip";
  tip.hidden = true;
  stage.appendChild(tip);

  var foot = document.createElement("div");
  foot.className = "torqueplot-foot";
  host.appendChild(foot);

  var legend = document.createElement("div");
  legend.className = "torqueplot-legend";
  series.forEach(function (s, idx) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "torqueplot-legend-item";
    btn.setAttribute("aria-pressed", "true");
    btn.innerHTML =
      '<span class="torqueplot-swatch torqueplot-swatch--' + s.kind +
      '" style="--swatch:' + s.color + '"></span><span>' + s.name + "</span>";
    btn.addEventListener("click", function () {
      visible[idx] = !visible[idx];
      btn.setAttribute("aria-pressed", String(visible[idx]));
      btn.classList.toggle("is-off", !visible[idx]);
      draw();
    });
    legend.appendChild(btn);
  });
  foot.appendChild(legend);

  var controls = document.createElement("div");
  controls.className = "torqueplot-controls";
  controls.innerHTML =
    '<span class="torqueplot-hint">drag to pan &middot; scroll to zoom</span>' +
    '<span class="torqueplot-modes" role="group" aria-label="Plot mode">' +
    '<button type="button" data-mode="animate">Animate</button>' +
    '<button type="button" data-mode="static">Static</button>' +
    "</span>" +
    '<button type="button" class="torqueplot-reset">Reset</button>';
  foot.appendChild(controls);

  var modeButtons = Array.prototype.slice.call(
    controls.querySelectorAll(".torqueplot-modes button")
  );
  modeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setMode(btn.getAttribute("data-mode"));
    });
  });
  controls.querySelector(".torqueplot-reset").addEventListener("click", reset);

  /* ---- canvas ---- */
  var ctx = canvas.getContext("2d");
  var W = 0, H = 0, dpr = 1;
  var mono = (getComputedStyle(host).getPropertyValue("--plot-font") || "").trim() ||
    "-apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif";

  function font(px, weight) {
    return (weight ? weight + " " : "") + px + "px " + mono;
  }

  /* ---- playback ---- */
  var raf = 0;
  var startTs = 0;
  var onScreen = true;

  function syncModeButtons() {
    modeButtons.forEach(function (btn) {
      var on = btn.getAttribute("data-mode") === mode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    syncModeButtons();
    if (mode === "animate") {
      startTs = 0;
      head = 0;
      play();
    } else {
      stop();
      head = n - 1;
      draw();
    }
  }

  function play() {
    if (mode !== "animate" || raf || !onScreen) return;
    raf = requestAnimationFrame(step);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    // Clearing the epoch means scrolling away and back replays the sweep from
    // the start rather than resuming mid-trajectory (or jumping to the end).
    startTs = 0;
  }

  function step(ts) {
    raf = 0;
    if (mode !== "animate") return;
    if (!startTs) startTs = ts;
    var runMs = ((T1 - T0) / SPEED) * 1000;
    var wall = ts - startTs;
    if (wall <= runMs) {
      head = Math.min(n - 1, Math.round(((wall / 1000) * SPEED) / DT));
    } else if (wall <= runMs + HOLD_MS) {
      head = n - 1;
    } else {
      startTs = ts;
      head = 0;
    }
    draw();
    play();
  }

  function reset() {
    view.t0 = T0;
    view.t1 = T1;
    if (mode === "animate") {
      startTs = 0;
      head = 0;
      play();
    }
    draw();
  }

  /* ---- scales ---- */
  function xOf(box, tv) {
    return box.x + ((tv - view.t0) / (view.t1 - view.t0)) * box.w;
  }
  function tOf(box, px) {
    return view.t0 + ((px - box.x) / box.w) * (view.t1 - view.t0);
  }
  function yTau(box, v) {
    return box.y + box.h * (1 - (v + tauMax) / (2 * tauMax));
  }
  function yLogF(box, v) {
    return box.y + box.h * (1 - (v - fLo) / (fHi - fLo));
  }

  // Index range covering [view.t0, view.t1], padded by one sample so the
  // polyline enters and leaves the box rather than stopping at its edge, and
  // clipped to whatever the sweep has revealed so far.
  function span() {
    var a = Math.floor((view.t0 - T0) / DT) - 1;
    var b = Math.ceil((view.t1 - T0) / DT) + 1;
    return [Math.max(0, a), Math.min(Math.min(n - 1, head), b)];
  }

  function niceStep(range, target) {
    var raw = range / target;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function ticksFor(lo, hi, step) {
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      out.push(Math.abs(v) < 1e-9 ? 0 : v);
    }
    return out;
  }

  /* ---- drawing ---- */
  function polyline(box, yFn, values, a, b) {
    ctx.beginPath();
    for (var i = a; i <= b; i++) {
      var x = xOf(box, t[i]), y = yFn(box, values[i]);
      if (i === a) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawPanel(panel, box, isLast) {
    var sp = span(), a = sp[0], b = sp[1];
    var hasTrace = b > a;

    ctx.fillStyle = BG;
    ctx.fillRect(box.x, box.y, box.w, box.h);

    // Grid — left-axis τ ticks plus the time ticks, as in the offline figure
    // (the twin axis draws no grid of its own).
    var tauTicks = ticksFor(-tauMax, tauMax, TAU_STEP);
    // ~100 px between time ticks, so the labels stay readable at any width.
    var xStep = niceStep(view.t1 - view.t0, Math.max(3, Math.round(box.w / 100)));
    var xTicks = ticksFor(view.t0, view.t1, xStep);
    ctx.beginPath();
    tauTicks.forEach(function (v) {
      var y = Math.round(yTau(box, v)) + 0.5;
      ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y);
    });
    xTicks.forEach(function (v) {
      var x = Math.round(xOf(box, v)) + 0.5;
      ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h);
    });
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();

    // τ = 0 reference
    ctx.beginPath();
    var yz = Math.round(yTau(box, 0)) + 0.5;
    ctx.moveTo(box.x, yz); ctx.lineTo(box.x + box.w, yz);
    ctx.strokeStyle = ZERO_LINE;
    ctx.lineWidth = 1;
    ctx.stroke();

    // ±0.9 × effort limit. Drawn in full even while the sweep runs — it is a
    // property of the joint, not of the trajectory.
    if (panel.bound != null && boundIdx >= 0 && visible[boundIdx]) {
      ctx.beginPath();
      [panel.bound, -panel.bound].forEach(function (v) {
        var y = yTau(box, v);
        ctx.moveTo(box.x, y); ctx.lineTo(box.x + box.w, y);
      });
      ctx.strokeStyle = BOUND_COLOR;
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.85;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // log|F| on the twin axis — long dashes, distinct from the solid τ lines.
    if (visible[forceIdx] && hasTrace) {
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = FORCE_COLOR;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      polyline(box, yLogF, logF, a, b);
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    // τ traces on top
    if (hasTrace) {
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      series.forEach(function (s, idx) {
        if (s.kind !== "run" || !visible[idx]) return;
        ctx.strokeStyle = s.color;
        polyline(box, yTau, panel.tau[s.run], a, b);
      });
    }

    // Leading edge of the sweep
    if (mode === "animate" && head > 0 && head < n - 1) drawHead(box, panel);
    ctx.restore();

    // Frame
    ctx.strokeStyle = SPINE;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(box.x) + 0.5, Math.round(box.y) + 0.5,
      Math.round(box.w), Math.round(box.h)
    );

    // Left axis: τ ticks + label
    ctx.fillStyle = TEXT;
    ctx.font = font(10);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    tauTicks.forEach(function (v) {
      ctx.fillText(String(v), box.x - 6, yTau(box, v));
    });
    ctx.save();
    ctx.translate(14, box.y + box.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("τ  [N·m]", 0, 0);
    ctx.restore();

    // Right axis: log|F| ticks + label
    ctx.fillStyle = FORCE_COLOR;
    ctx.textAlign = "left";
    ticksFor(fLo, fHi, LOGF_STEP).forEach(function (v) {
      ctx.fillText(v.toFixed(1), box.x + box.w + 6, yLogF(box, v));
    });
    ctx.save();
    ctx.translate(W - 12, box.y + box.h / 2);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("log|F|  [N]", 0, 0);
    ctx.restore();

    // Panel title — the '_joint' suffix is the first thing to go when narrow.
    ctx.fillStyle = TEXT;
    ctx.font = font(box.w < 420 ? 10 : 11);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(
      box.w < 420 ? panel.joint.replace(/_joint$/, "") : panel.joint,
      box.x + box.w / 2, box.y - 6
    );

    // Shared x axis, labelled once under the bottom panel.
    if (isLast) {
      ctx.font = font(10);
      ctx.textBaseline = "top";
      xTicks.forEach(function (v) {
        ctx.fillText(formatT(v, xStep), xOf(box, v), box.y + box.h + 6);
      });
      ctx.fillText("t  [s]", box.x + box.w / 2, box.y + box.h + 20);
    }
  }

  // Vertical rule plus a dot on each visible τ trace at the swept-to sample.
  function drawHead(box, panel) {
    var x = xOf(box, t[head]);
    if (x < box.x - 2 || x > box.x + box.w + 2) return;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, box.y);
    ctx.lineTo(Math.round(x) + 0.5, box.y + box.h);
    ctx.strokeStyle = "rgba(31, 29, 26, 0.22)";
    ctx.lineWidth = 1;
    ctx.stroke();
    series.forEach(function (s, idx) {
      if (s.kind !== "run" || !visible[idx]) return;
      ctx.beginPath();
      ctx.arc(x, yTau(box, panel.tau[s.run][head]), 3, 0, 6.2832);
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }

  function formatT(v, step) {
    // Fractional steps (0.5 s, 2.5 s, …) need a decimal even when >= 1.
    var dec = step % 1 === 0 ? 0 : step >= 0.1 ? 1 : 2;
    return v.toFixed(dec);
  }

  function layout() {
    boxes = [];
    var slotH = (H - PAD_T - PAD_B - PANEL_GAP * (panels.length - 1)) / panels.length;
    for (var i = 0; i < panels.length; i++) {
      var top = PAD_T + i * (slotH + PANEL_GAP);
      boxes.push({
        x: PAD_L,
        y: top + TITLE_H,
        w: Math.max(10, W - PAD_L - PAD_R),
        h: Math.max(10, slotH - TITLE_H),
      });
    }
  }

  function draw() {
    if (!W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    layout();
    for (var i = 0; i < panels.length; i++) {
      drawPanel(panels[i], boxes[i], i === panels.length - 1);
    }
    if (cursor != null) drawCursor();
  }

  var cursor = null; // { idx, panel }

  function drawCursor() {
    var box = boxes[cursor.panel];
    if (!box) return;
    var x = xOf(box, t[cursor.idx]);
    if (x < box.x || x > box.x + box.w) return;

    ctx.save();
    ctx.beginPath();
    boxes.forEach(function (b) {
      ctx.moveTo(Math.round(x) + 0.5, b.y);
      ctx.lineTo(Math.round(x) + 0.5, b.y + b.h);
    });
    ctx.strokeStyle = "rgba(31, 29, 26, 0.35)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Dot each visible τ trace where the crosshair meets it.
    boxes.forEach(function (b, pi) {
      series.forEach(function (s, idx) {
        if (s.kind !== "run" || !visible[idx]) return;
        ctx.beginPath();
        ctx.arc(x, yTau(b, panels[pi].tau[s.run][cursor.idx]), 3, 0, 6.2832);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    });
    ctx.restore();
  }

  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; draw(); });
  }

  /* ---- sizing ---- */
  function resize() {
    var rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.round(rect.width);
    H = Math.round(rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    draw();
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
  else window.addEventListener("resize", resize);

  /* ---- interaction ---- */
  var pointers = new Map();
  var dragFrom = null;
  var pinchFrom = 0;

  function pinchSpan() {
    var pts = Array.from(pointers.values());
    return Math.abs(pts[0].x - pts[1].x) || 1;
  }

  function clampView(t0, t1) {
    var width = Math.min(Math.max(t1 - t0, (T1 - T0) / 200), T1 - T0);
    if (t0 < T0) t0 = T0;
    if (t0 + width > T1) t0 = T1 - width;
    view.t0 = t0;
    view.t1 = t0 + width;
  }

  function zoomAbout(tAnchor, factor) {
    var w = (view.t1 - view.t0) * factor;
    var frac = (tAnchor - view.t0) / (view.t1 - view.t0);
    clampView(tAnchor - frac * w, tAnchor - frac * w + w);
  }

  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragFrom = { x: e.clientX, t0: view.t0, t1: view.t1 };
    } else if (pointers.size === 2) {
      dragFrom = null;
      pinchFrom = pinchSpan() * (view.t1 - view.t0);
    }
    stage.classList.add("is-dragging");
    cursor = null;
    tip.hidden = true;
    schedule();
  });

  canvas.addEventListener("pointermove", function (e) {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pointers.size >= 2 && pinchFrom) {
      var mid = view.t0 + (view.t1 - view.t0) / 2;
      var w = pinchFrom / pinchSpan();
      clampView(mid - w / 2, mid + w / 2);
      schedule();
      return;
    }
    if (dragFrom) {
      var box = boxes[0];
      var perPx = (dragFrom.t1 - dragFrom.t0) / Math.max(box.w, 1);
      var shift = (e.clientX - dragFrom.x) * perPx;
      clampView(dragFrom.t0 - shift, dragFrom.t1 - shift);
      schedule();
      return;
    }
    hover(e);
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchFrom = 0;
    if (pointers.size === 0) {
      dragFrom = null;
      stage.classList.remove("is-dragging");
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", function () {
    tip.hidden = true;
    cursor = null;
    schedule();
  });

  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    var box = boxes[0];
    if (!box) return;
    var rect = canvas.getBoundingClientRect();
    var mx = Math.min(Math.max(e.clientX - rect.left, box.x), box.x + box.w);
    zoomAbout(tOf(box, mx), Math.exp(e.deltaY * 0.0015));
    schedule();
  }, { passive: false });

  canvas.addEventListener("dblclick", reset);

  canvas.addEventListener("keydown", function (e) {
    var w = view.t1 - view.t0;
    var step = (e.shiftKey ? 0.3 : 0.1) * w;
    var handled = true;
    if (e.key === "ArrowLeft") clampView(view.t0 - step, view.t1 - step);
    else if (e.key === "ArrowRight") clampView(view.t0 + step, view.t1 + step);
    else if (e.key === "+" || e.key === "=") zoomAbout(view.t0 + w / 2, 1 / 1.2);
    else if (e.key === "-" || e.key === "_") zoomAbout(view.t0 + w / 2, 1.2);
    else if (e.key === "0") { view.t0 = T0; view.t1 = T1; }
    else if (e.key === " ") setMode(mode === "animate" ? "static" : "animate");
    else handled = false;
    if (handled) { e.preventDefault(); schedule(); }
  });

  function hover(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var pi = -1;
    for (var k = 0; k < boxes.length; k++) {
      var b = boxes[k];
      if (mx >= b.x && mx <= b.x + b.w && my >= b.y - TITLE_H && my <= b.y + b.h) {
        pi = k;
        break;
      }
    }
    if (pi < 0) {
      if (cursor) { cursor = null; schedule(); }
      tip.hidden = true;
      return;
    }

    var box = boxes[pi];
    // Never read ahead of the sweep.
    var idx = Math.round((tOf(box, mx) - T0) / DT);
    idx = Math.min(Math.min(n - 1, head), Math.max(0, idx));
    if (!cursor || cursor.idx !== idx || cursor.panel !== pi) {
      cursor = { idx: idx, panel: pi };
      schedule();
    }

    var rows = ['<b>t = ' + t[idx].toFixed(2) + " s</b>"];
    series.forEach(function (s, si) {
      if (s.kind !== "run" || !visible[si]) return;
      rows.push(
        '<span class="torqueplot-key" style="--swatch:' + s.color + '"></span>' +
        s.name + " · τ = " + panels[pi].tau[s.run][idx].toFixed(1) + " N·m"
      );
    });
    tip.innerHTML = rows.join("<br>");
    tip.hidden = false;

    // Keep the tooltip inside the stage: flip to the left of the cursor near
    // the right edge, and clamp vertically to the panel.
    tip.classList.toggle("is-flipped", mx > W * 0.6);
    tip.style.left = Math.round(mx) + "px";
    tip.style.top = Math.round(Math.min(Math.max(my, box.y + 8), box.y + box.h - 8)) + "px";
  }

  /* ---- run only while on screen and the tab is visible ---- */
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      if (onScreen) play(); else stop();
    }, { threshold: 0 }).observe(host);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else play();
  });

  syncModeButtons();
  head = mode === "animate" ? 0 : n - 1;
  resize();
  play();
})();
