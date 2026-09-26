/* Interactive 3-D t-SNE of the force latent.
 *
 * Renders the same embedding, palette and grid styling as
 * `tools/plot_force_latent_tsne.py --3d --group-labels` (see
 * figures/force_latent_tsne_3d.js for the exported points), but on a canvas the
 * reader can rotate, zoom and inspect.
 */
(function () {
  "use strict";

  var host = document.getElementById("latent3d");
  var data = window.__FORCE_LATENT_TSNE;
  if (!host || !data) return;

  /* ---- styling mirrored from the matplotlib render ---- */
  var PANE_FILL = "#ffffff";
  var GRID_LINE = "#e7e8ee";
  var SPINE = "#1f1d1a";
  var MARKER_EDGE = "#ffffff";

  var DEG = Math.PI / 180;
  var LIM = 1.08; // half-extent of the drawn box, in normalised t-SNE units
  var DIVS = 6; // grid intervals per axis
  var CAM_DIST = 9; // camera distance — sets how strong the perspective is
  var PAD = 18; // px kept clear around the box at zoom 1 — lower fills more
  var POINT_R = 2.4; // marker radius in CSS px at zoom 1
  var HOME = { azim: -60, elev: 30, zoom: 1 };

  var view = { azim: HOME.azim, elev: HOME.elev, zoom: HOME.zoom };

  /* ---- data ---- */
  var xyz = data.xyz;
  var labels = data.label;
  var force = data.force;
  var classes = data.classes;
  var n = labels.length;
  var visible = classes.map(function () { return true; });

  var proj = new Float32Array(n * 3); // sx, sy, radius
  var order = new Int32Array(n);
  var depth = new Float32Array(n);
  for (var i = 0; i < n; i++) order[i] = i;

  /* ---- DOM ---- */
  var canvas = document.createElement("canvas");
  canvas.className = "latent3d-canvas";
  canvas.setAttribute("tabindex", "0");
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    "Interactive 3-D t-SNE of the force latent, coloured by perturbation class. " +
      "Drag to rotate, scroll to zoom; arrow keys rotate when focused."
  );
  host.appendChild(canvas);

  var tip = document.createElement("div");
  tip.className = "latent3d-tip";
  tip.hidden = true;
  host.appendChild(tip);

  var legend = document.createElement("div");
  legend.className = "latent3d-legend";
  classes.forEach(function (cls, idx) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "latent3d-legend-item";
    btn.setAttribute("aria-pressed", "true");
    btn.innerHTML =
      '<span class="latent3d-swatch" style="background:' + cls.color + '"></span>' +
      "<span>" + cls.id + ":" + cls.name + "</span>";
    btn.addEventListener("click", function () {
      visible[idx] = !visible[idx];
      btn.setAttribute("aria-pressed", String(visible[idx]));
      btn.classList.toggle("is-off", !visible[idx]);
      draw();
    });
    legend.appendChild(btn);
  });
  host.appendChild(legend);

  var bar = document.createElement("div");
  bar.className = "latent3d-bar";
  bar.innerHTML =
    '<span class="latent3d-hint">drag to rotate &middot; scroll to zoom</span>' +
    '<button type="button" class="latent3d-reset">Reset view</button>';
  bar.querySelector(".latent3d-reset").addEventListener("click", function () {
    view.azim = HOME.azim;
    view.elev = HOME.elev;
    view.zoom = HOME.zoom;
    draw();
  });
  host.appendChild(bar);

  /* ---- camera ---- */
  var ctx = canvas.getContext("2d");
  var W = 0, H = 0, dpr = 1;

  function camera() {
    var az = view.azim * DEG, el = view.elev * DEG;
    var f = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
    var rn = Math.hypot(-f[1], f[0]) || 1;
    var r = [-f[1] / rn, f[0] / rn, 0];
    var u = [-f[2] * r[1], f[2] * r[0], f[0] * r[1] - f[1] * r[0]];
    return { f: f, r: r, u: u };
  }

  // Unprojected (divided-by-depth) camera coordinates; `K` turns them into px.
  function toCam(cam, x, y, z) {
    var cz = CAM_DIST - (x * cam.f[0] + y * cam.f[1] + z * cam.f[2]);
    return [
      (x * cam.r[0] + y * cam.r[1] + z * cam.r[2]) / cz,
      (x * cam.u[0] + y * cam.u[1] + z * cam.u[2]) / cz,
      cz,
    ];
  }

  // Fit the eight box corners into the canvas so no view angle ever clips.
  function fitScale(cam) {
    var mx = 1e-6, my = 1e-6;
    for (var sx = -1; sx <= 1; sx += 2)
      for (var sy = -1; sy <= 1; sy += 2)
        for (var sz = -1; sz <= 1; sz += 2) {
          var c = toCam(cam, sx * LIM, sy * LIM, sz * LIM);
          mx = Math.max(mx, Math.abs(c[0]));
          my = Math.max(my, Math.abs(c[1]));
        }
    return Math.min((W / 2 - PAD) / mx, (H / 2 - PAD) / my) * view.zoom;
  }

  /* ---- drawing primitives ---- */
  function line3(cam, K, a, b) {
    var p = toCam(cam, a[0], a[1], a[2]);
    var q = toCam(cam, b[0], b[1], b[2]);
    ctx.moveTo(W / 2 + p[0] * K, H / 2 - p[1] * K);
    ctx.lineTo(W / 2 + q[0] * K, H / 2 - q[1] * K);
  }

  function quad3(cam, K, pts) {
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var c = toCam(cam, pts[i][0], pts[i][1], pts[i][2]);
      var x = W / 2 + c[0] * K, y = H / 2 - c[1] * K;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function ticks() {
    var out = [];
    for (var i = 0; i <= DIVS; i++) out.push(-LIM + (2 * LIM * i) / DIVS);
    return out;
  }

  // One back pane, perpendicular to `axis`, sitting at `at`, with its grid.
  function pane(cam, K, axis, at) {
    var a = (axis + 1) % 3, b = (axis + 2) % 3;
    var corner = function (ua, ub) {
      var p = [0, 0, 0];
      p[axis] = at; p[a] = ua; p[b] = ub;
      return p;
    };
    quad3(cam, K, [
      corner(-LIM, -LIM), corner(LIM, -LIM), corner(LIM, LIM), corner(-LIM, LIM),
    ]);
    ctx.fillStyle = PANE_FILL;
    ctx.fill();

    ctx.beginPath();
    ticks().forEach(function (t) {
      line3(cam, K, corner(t, -LIM), corner(t, LIM));
      line3(cam, K, corner(-LIM, t), corner(LIM, t));
    });
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Black spine with outward tick marks, drawn perpendicular in screen space.
  function spine(cam, K, from, to) {
    var p = toCam(cam, from[0], from[1], from[2]);
    var q = toCam(cam, to[0], to[1], to[2]);
    var x0 = W / 2 + p[0] * K, y0 = H / 2 - p[1] * K;
    var x1 = W / 2 + q[0] * K, y1 = H / 2 - q[1] * K;
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.hypot(dx, dy) || 1;
    var nx = -dy / len, ny = dx / len;
    // Flip the normal so the ticks point away from the box centre.
    if (nx * ((x0 + x1) / 2 - W / 2) + ny * ((y0 + y1) / 2 - H / 2) < 0) {
      nx = -nx; ny = -ny;
    }
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    for (var i = 0; i <= DIVS; i++) {
      var tx = x0 + (dx * i) / DIVS, ty = y0 + (dy * i) / DIVS;
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + nx * 5, ty + ny * 5);
    }
    ctx.strokeStyle = SPINE;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function draw() {
    if (!W || !H) return;
    var cam = camera();
    var K = fitScale(cam);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Panes: for each axis, keep the one on the far side of the camera.
    var far = [
      cam.f[0] > 0 ? -LIM : LIM,
      cam.f[1] > 0 ? -LIM : LIM,
      cam.f[2] > 0 ? -LIM : LIM,
    ];
    pane(cam, K, 0, far[0]);
    pane(cam, K, 1, far[1]);
    pane(cam, K, 2, far[2]);

    // Points, painter-sorted back to front.
    var count = 0;
    for (var i = 0; i < n; i++) {
      if (!visible[labels[i]]) continue;
      var c = toCam(cam, xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]);
      proj[3 * i] = W / 2 + c[0] * K;
      proj[3 * i + 1] = H / 2 - c[1] * K;
      proj[3 * i + 2] = POINT_R * (CAM_DIST / c[2]) * Math.sqrt(view.zoom);
      depth[i] = c[2];
      order[count++] = i;
    }
    var live = order.subarray(0, count);
    live.sort(function (a, b) { return depth[b] - depth[a]; });

    ctx.lineWidth = 0.5;
    ctx.strokeStyle = MARKER_EDGE;
    for (var k = 0; k < count; k++) {
      var idx = live[k];
      ctx.beginPath();
      ctx.arc(proj[3 * idx], proj[3 * idx + 1], proj[3 * idx + 2], 0, 6.2832);
      ctx.fillStyle = classes[labels[idx]].color;
      ctx.fill();
      ctx.stroke();
    }
    lastCount = count;

    // Spines: the two near edges of the bottom pane plus a vertical edge.
    var near = [-far[0], -far[1], -far[2]];
    spine(cam, K, [-LIM, near[1], far[2]], [LIM, near[1], far[2]]);
    spine(cam, K, [near[0], -LIM, far[2]], [near[0], LIM, far[2]]);
    var cA = toCam(cam, far[0], near[1], 0), cB = toCam(cam, near[0], far[1], 0);
    var vx = cA[0] > cB[0] ? far[0] : near[0];
    var vy = cA[0] > cB[0] ? near[1] : far[1];
    spine(cam, K, [vx, vy, -LIM], [vx, vy, LIM]);
  }

  var lastCount = 0;
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; draw(); });
  }

  /* ---- sizing ---- */
  function resize() {
    var rect = host.getBoundingClientRect();
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
  if (window.ResizeObserver) new ResizeObserver(resize).observe(host);
  else window.addEventListener("resize", resize);
  resize();

  /* ---- interaction ---- */
  var pointers = new Map();
  var dragFrom = null;
  var pinchFrom = 0;

  function pinchDist() {
    var pts = Array.from(pointers.values());
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragFrom = { x: e.clientX, y: e.clientY, azim: view.azim, elev: view.elev };
    } else if (pointers.size === 2) {
      dragFrom = null;
      pinchFrom = pinchDist() / view.zoom;
    }
    host.classList.add("is-dragging");
    tip.hidden = true;
  });

  canvas.addEventListener("pointermove", function (e) {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pointers.size >= 2 && pinchFrom) {
      view.zoom = clampZoom(pinchDist() / pinchFrom);
      schedule();
      return;
    }
    if (dragFrom) {
      view.azim = dragFrom.azim - (e.clientX - dragFrom.x) * 0.4;
      view.elev = Math.max(
        -89, Math.min(89, dragFrom.elev + (e.clientY - dragFrom.y) * 0.4)
      );
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
      host.classList.remove("is-dragging");
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  // Only the tooltip reacts to leaving — an in-flight drag is pointer-captured
  // and ends on pointerup, wherever that lands.
  canvas.addEventListener("pointerleave", function () { tip.hidden = true; });

  function clampZoom(z) { return Math.max(0.5, Math.min(8, z)); }

  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    view.zoom = clampZoom(view.zoom * Math.exp(-e.deltaY * 0.0015));
    schedule();
  }, { passive: false });

  canvas.addEventListener("dblclick", function () {
    view.azim = HOME.azim;
    view.elev = HOME.elev;
    view.zoom = HOME.zoom;
    draw();
  });

  canvas.addEventListener("keydown", function (e) {
    var step = e.shiftKey ? 15 : 5;
    var handled = true;
    if (e.key === "ArrowLeft") view.azim -= step;
    else if (e.key === "ArrowRight") view.azim += step;
    else if (e.key === "ArrowUp") view.elev = Math.min(89, view.elev + step);
    else if (e.key === "ArrowDown") view.elev = Math.max(-89, view.elev - step);
    else if (e.key === "+" || e.key === "=") view.zoom = clampZoom(view.zoom * 1.15);
    else if (e.key === "-" || e.key === "_") view.zoom = clampZoom(view.zoom / 1.15);
    else if (e.key === "0") { view.azim = HOME.azim; view.elev = HOME.elev; view.zoom = HOME.zoom; }
    else handled = false;
    if (handled) { e.preventDefault(); schedule(); }
  });

  function hover(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var best = -1, bestD = 81; // 9 px pick radius
    for (var k = 0; k < lastCount; k++) {
      var idx = order[k];
      var dx = proj[3 * idx] - mx, dy = proj[3 * idx + 1] - my;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = idx; }
    }
    if (best < 0) { tip.hidden = true; return; }
    tip.textContent =
      classes[labels[best]].name + " · |F| = " + force[best].toFixed(1) + " N";
    tip.hidden = false;
    tip.style.left = Math.round(proj[3 * best]) + "px";
    tip.style.top = Math.round(proj[3 * best + 1]) + "px";
  }
})();
