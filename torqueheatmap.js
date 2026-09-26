/* Per-joint lower-body effort heatmap, stiff vs. compliant.
 *
 * Web counterpart of the appendix figure
 * (ICRA2027_CompliantWBC/figures/plot_torque_heatmap.py): the same 12 rows
 * (six joint groups x left/right), the same 0.1 s bins and the same
 * saturation rule, drawn on the project page's light-blue ramp instead of the
 * paper's palette. Data comes from figures/torque_heatmap.js.
 *
 * Deliberately still: no animation, no pan/zoom. Hover reads a cell.
 */
(function () {
  "use strict";

  var host = document.getElementById("torqueheatmap");
  var data = window.__TORQUE_HEATMAP;
  if (!host || !data) return;

  /* ---- palette: the page's light-blue sequential ramp ---- */
  var css = getComputedStyle(host);
  function cssVar(name, fallback) {
    return (css.getPropertyValue(name) || "").trim() || fallback;
  }
  function rgbOf(hex, fallback) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return fallback;
    var v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  var BG = cssVar("--page-bg", "#ffffff");
  var RAMP = [
    // 0 is the page itself: an untouched joint leaves no mark.
    [0.00, rgbOf(BG, [255, 255, 255])],
    [0.10, [219, 234, 248]],
    [0.28, [168, 211, 242]],
    [0.48, [124, 188, 234]],
    [0.64, [74, 159, 224]],
    [0.82, [37, 105, 162]],
    [1.00, [23, 80, 127]]
  ];
  var SAT_COLOR = "#e0454f";   // a joint that touched its limit
  var INK = cssVar("--text", "#10243f");
  var INK2 = cssVar("--subtext0", "#5b6675");
  var FAINT = cssVar("--overlay1", "#8b95a2");
  var HAIR = cssVar("--line", "rgba(16, 36, 63, 0.10)");

  /* ---- geometry ---- */
  var ROW_H = 13;        // one joint (L or R)
  var GROUP_GAP = 4;     // white gutter between joint groups
  var TITLE_H = 26;      // band above each panel
  var PANEL_GAP = 30;
  var AXIS_H = 40;       // shared time axis under the lower panel
  var BAR_H = 44;        // colour key
  var PAD_R = 8;
  var padL = 96;         // measured from the group labels in layout()
  var labelPx = 11.5, sidePx = 9, labelGap = 20, sideGap = 6;

  /* ---- data ---- */
  var rows = data.rows;                    // [{group, side}] x 12
  var runs = data.runs;
  var nRows = rows.length;
  var nCols = runs[0].cells[0].length;
  var binSec = data.binSec || 0.1;
  var tEnd = data.tEnd || nCols * binSec;
  var satT = data.satThreshold != null ? data.satThreshold : 0.9;

  // Saturated cells arrive as [row, col] pairs; index them for O(1) lookup.
  var satSet = runs.map(function (r) {
    var s = {};
    (r.sat || []).forEach(function (rc) { s[rc[0] * nCols + rc[1]] = 1; });
    return s;
  });

  // Where each group starts, so labels can straddle their L/R pair.
  var groups = [];
  rows.forEach(function (row, i) {
    var last = groups[groups.length - 1];
    if (!last || last.name !== row.group) groups.push({ name: row.group, from: i, to: i });
    else last.to = i;
  });

  /* ---- DOM ---- */
  var stage = document.createElement("div");
  stage.className = "heatmap-stage";
  host.appendChild(stage);

  var canvas = document.createElement("canvas");
  canvas.className = "heatmap-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    "Per-joint effort over time for the twelve lower-body joints, " +
      runs.map(function (r) {
        return r.name + " saturates " + r.satPct + "% of the time";
      }).join("; ") + "."
  );
  stage.appendChild(canvas);

  var tip = document.createElement("div");
  tip.className = "heatmap-tip";
  tip.hidden = true;
  stage.appendChild(tip);

  /* ---- canvas ---- */
  var ctx = canvas.getContext("2d");
  var W = 0, H = 0, dpr = 1, rowH = ROW_H;
  var sans = cssVar("--plot-font",
    "-apple-system, BlinkMacSystemFont, \"Helvetica Neue\", sans-serif");
  var panels = [];   // filled by draw(): one plot rect per run
  var hoverCell = null;

  function font(px, weight) {
    return (weight ? weight + " " : "") + px + "px " + sans;
  }

  function lerp(a, b, u) { return a + (b - a) * u; }

  function rampColor(v) {
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    for (var i = 1; i < RAMP.length; i++) {
      if (v <= RAMP[i][0] || i === RAMP.length - 1) {
        var a = RAMP[i - 1], b = RAMP[i];
        var u = (v - a[0]) / (b[0] - a[0] || 1);
        return "rgb(" + Math.round(lerp(a[1][0], b[1][0], u)) + "," +
          Math.round(lerp(a[1][1], b[1][1], u)) + "," +
          Math.round(lerp(a[1][2], b[1][2], u)) + ")";
      }
    }
    return "#fff";
  }

  /* Vertical offset of a row inside a panel, group gutters included. */
  function rowTop(r) {
    var gi = 0;
    for (var i = 0; i < groups.length; i++) if (groups[i].from <= r) gi = i;
    return r * rowH + gi * GROUP_GAP;
  }

  function gridHeight() {
    return nRows * rowH + (groups.length - 1) * GROUP_GAP;
  }

  function layout() {
    var narrow = W < 560;
    rowH = narrow ? 10 : ROW_H;
    labelPx = narrow ? 10 : 11.5;
    sidePx = narrow ? 8 : 9;
    labelGap = narrow ? 15 : 20;
    sideGap = narrow ? 5 : 6;

    // The gutter is exactly as wide as the longest joint name needs, so the
    // labels never clip and never leave a hole at full width.
    ctx.font = font(labelPx);
    var widest = 0;
    for (var g = 0; g < groups.length; g++) {
      widest = Math.max(widest, ctx.measureText(groups[g].name).width);
    }
    padL = Math.ceil(widest) + labelGap + 4;

    var gh = gridHeight();
    panels = runs.map(function (run, i) {
      return {
        run: run,
        idx: i,
        x: padL,
        y: TITLE_H + i * (TITLE_H + gh + PANEL_GAP),
        w: Math.max(10, W - padL - PAD_R),
        h: gh
      };
    });
    var last = panels[panels.length - 1];
    return last.y + last.h + AXIS_H + BAR_H;
  }

  function resize() {
    var box = host.getBoundingClientRect();
    W = Math.max(280, Math.round(box.width));
    H = Math.round(layout());
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    stage.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  /* ---- drawing ---- */
  function drawPanel(p) {
    var cells = p.run.cells;
    var sat = satSet[p.idx];
    var cw = p.w / nCols;

    // Title, and the one number that matters for this row of the story.
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = font(13, 600);
    ctx.fillText(p.run.name, p.x, p.y - 9);

    ctx.textAlign = "right";
    ctx.font = font(11.5);
    ctx.fillStyle = SAT_COLOR;
    ctx.fillText("saturated " + p.run.satPct.toFixed(1) + "% of the time",
      p.x + p.w, p.y - 9);

    for (var r = 0; r < nRows; r++) {
      var y = p.y + rowTop(r);
      var row = cells[r];
      for (var c = 0; c < nCols; c++) {
        var x0 = p.x + Math.round(c * cw);
        var x1 = p.x + Math.round((c + 1) * cw);
        ctx.fillStyle = sat[r * nCols + c] ? SAT_COLOR : rampColor(row[c] / 100);
        ctx.fillRect(x0, y, Math.max(1, x1 - x0), rowH);
      }
    }

    // Row labels: the group name straddles its L/R pair, sides in the gutter.
    ctx.textBaseline = "middle";
    for (var g = 0; g < groups.length; g++) {
      var gr = groups[g];
      var yMid = p.y + (rowTop(gr.from) + rowTop(gr.to) + rowH) / 2;
      ctx.textAlign = "right";
      ctx.font = font(labelPx);
      ctx.fillStyle = INK2;
      ctx.fillText(gr.name, p.x - labelGap, yMid);
    }
    ctx.font = font(sidePx);
    ctx.fillStyle = FAINT;
    ctx.textAlign = "right";
    for (var s = 0; s < nRows; s++) {
      ctx.fillText(rows[s].side, p.x - sideGap, p.y + rowTop(s) + rowH / 2 + 0.5);
    }

    // Hover crosshair: outline the cell, keep everything else untouched.
    if (hoverCell && hoverCell.panel === p.idx) {
      var hx = p.x + Math.round(hoverCell.col * cw);
      var hw = Math.max(2, Math.round((hoverCell.col + 1) * cw) - Math.round(hoverCell.col * cw));
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      ctx.strokeRect(hx - 0.5, p.y + rowTop(hoverCell.row) - 0.5, hw + 1, rowH + 1);
    }
  }

  function drawTimeAxis(p) {
    var y = p.y + p.h + 1;
    var step = p.w / tEnd < 26 ? 2 : 1;   // keep labels from colliding
    ctx.strokeStyle = HAIR;
    ctx.lineWidth = 1;
    ctx.fillStyle = FAINT;
    ctx.font = font(10.5);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (var s = 0; s <= Math.floor(tEnd); s += step) {
      var x = p.x + (s / tEnd) * p.w;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, y);
      ctx.lineTo(x + 0.5, y + 4);
      ctx.stroke();
      ctx.fillText(String(s), x, y + 6);
    }
    ctx.fillStyle = INK2;
    ctx.textAlign = "center";
    ctx.fillText("time  [s]", p.x + p.w / 2, y + 20);
  }

  function drawKey(p) {
    var y = p.y + p.h + AXIS_H + 12;
    var w = Math.min(p.w * 0.52, 260);
    var h = 8;
    var x = p.x;

    for (var i = 0; i < w; i++) {
      ctx.fillStyle = rampColor(i / (w - 1));
      ctx.fillRect(x + i, y, 1, h);
    }
    ctx.strokeStyle = HAIR;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    ctx.fillStyle = FAINT;
    ctx.font = font(10);
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("0", x, y + h + 4);
    ctx.textAlign = "center";
    ctx.fillText("0.5", x + w / 2, y + h + 4);
    ctx.textAlign = "right";
    ctx.fillText("1", x + w, y + h + 4);

    ctx.textAlign = "left";
    ctx.fillStyle = INK2;
    ctx.font = font(10.5);
    ctx.fillText("effort  |τ| / τᵐᵃˣ", x, y - 14);

    // Red key, set apart so the one non-blue colour explains itself.
    var kx = x + w + 22;
    ctx.fillStyle = SAT_COLOR;
    ctx.fillRect(kx, y, 14, h);
    ctx.fillStyle = INK2;
    ctx.font = font(10.5);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText("a sample above " + satT + " of the limit", kx + 20, y + h / 2);
  }

  function draw() {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    panels.forEach(drawPanel);
    var last = panels[panels.length - 1];
    drawTimeAxis(last);
    drawKey(last);
  }

  /* ---- hover ---- */
  function hitTest(mx, my) {
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      if (mx < p.x || mx > p.x + p.w || my < p.y || my > p.y + p.h) continue;
      var local = my - p.y;
      for (var r = 0; r < nRows; r++) {
        var top = rowTop(r);
        if (local >= top && local < top + rowH) {
          var col = Math.floor(((mx - p.x) / p.w) * nCols);
          col = Math.max(0, Math.min(nCols - 1, col));
          return { panel: i, row: r, col: col };
        }
      }
      return null;   // inside the panel but in a group gutter
    }
    return null;
  }

  canvas.addEventListener("pointermove", function (e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var hit = hitTest(mx, my);
    var same = hit && hoverCell && hit.panel === hoverCell.panel &&
      hit.row === hoverCell.row && hit.col === hoverCell.col;
    if (!hit) {
      if (hoverCell) { hoverCell = null; draw(); }
      tip.hidden = true;
      return;
    }
    if (!same) { hoverCell = hit; draw(); }

    var run = runs[hit.panel];
    var v = run.cells[hit.row][hit.col] / 100;
    var t0 = (hit.col * binSec).toFixed(1);
    var saturated = satSet[hit.panel][hit.row * nCols + hit.col];
    tip.innerHTML =
      "<b>" + rows[hit.row].group + " &middot; " +
      (rows[hit.row].side === "L" ? "left" : "right") + "</b><br>" +
      "t = " + t0 + "&ndash;" + (Number(t0) + binSec).toFixed(1) + " s<br>" +
      "effort " + (v * 100).toFixed(0) + "% of limit" +
      (saturated ? '<br><span class="heatmap-tip-sat">touched the limit</span>' : "");
    tip.hidden = false;
    tip.classList.toggle("is-flipped", mx > W * 0.6);
    tip.style.left = Math.round(mx) + "px";
    tip.style.top = Math.round(my) + "px";
  });

  canvas.addEventListener("pointerleave", function () {
    tip.hidden = true;
    if (hoverCell) { hoverCell = null; draw(); }
  });

  /* ---- keep it sized to the column ---- */
  if (window.ResizeObserver) {
    new ResizeObserver(function () { resize(); }).observe(host);
  } else {
    window.addEventListener("resize", resize);
  }
  resize();
})();
