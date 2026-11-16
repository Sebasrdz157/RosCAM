/* Self-contained 3D G-code toolpath viewer with playback.
 *
 * RosCAM copy of PenguinCAM's static/gcode_viewer.js, changed for RosCAM:
 *   - opts.stockTop: Z of the top of the stock. RosCAM zeros Z on top of the stock, so it
 *     passes 0 and the stock box sits below Z0 (PenguinCAM's Z0 is the spoilboard).
 *   - The toolpath is built once and playback only moves draw ranges, so long end mill
 *     programs (tens of thousands of moves) scrub smoothly.
 *   - Each move remembers the "(Program n of N: ...)" header it came from, shown in the
 *     scrubber, so several programs can be played back to back.
 *   - opts.sectionColors[n-1] colors program n's moves (full when cut, faded when still to
 *     come) and opts.rapidColor the rapid (G0) moves, so each bit has its own color.
 *
 * Arc tessellation, coordinate mapping gcode (x,y,z) -> THREE (x, z, -y) with
 * gcode-Z as the up axis, stock box, tool, green-completed / gold-upcoming
 * toolpath, scrubber + playback, packaged as a reusable module with no coupling
 * to a specific page. The wizard uses it.
 *
 * Usage:
 *   var v = new GcodeViewer({ canvas, container, scrubber, scrubberLabel,
 *                             scrubberOp, playButton, restartButton, speedSelect,
 *                             resetButton, emptyState });
 *   v.load(gcodeText, { stockWidth, stockHeight, stockDepth, toolDiameter });
 * Requires THREE and THREE.OrbitControls to be loaded first.
 */
(function () {
  'use strict';

  function GcodeViewer(els) {
    this.els = els;
    this.moves = [];
    this.completedLine = null;
    this.upcomingLine = null;
    this.toolMesh = null;
    this.stockHeight = 0;
    this.stockTop = 0;
    this.positions = null;
    this.isPlaying = false;
    this.interval = null;
    this.speed = 40;
    this._initScene();
    this._bindControls();
  }

  GcodeViewer.prototype._initScene = function () {
    var canvas = this.els.canvas;
    var container = this.els.container || canvas.parentElement;
    this.container = container;

    var w = container.clientWidth || 600;
    var h = container.clientHeight || 400;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this._themeColors().bg);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
    this.camera.position.set(10, 10, 10);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    var dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7.5);
    this.scene.add(dir);

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 500;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
    this.controls.update();

    this.optimalCam = { x: 10, y: 10, z: 10 };
    this.optimalLook = { x: 0, y: 0, z: 0 };

    var self = this;
    (function animate() {
      requestAnimationFrame(animate);
      if (self.controls) self.controls.update();
      self.renderer.render(self.scene, self.camera);
    })();

    window.addEventListener('resize', function () { self._resize(); });
  };

  GcodeViewer.prototype._resize = function () {
    var w = this.container.clientWidth || 600;
    var h = this.container.clientHeight || 400;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  // Background colors that follow the page theme (light/dark).
  GcodeViewer.prototype._themeColors = function () {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return light ? { bg: 0xf2f4f7 }
                 : { bg: 0x0a0e14 };
  };

  GcodeViewer.prototype.setTheme = function () {
    if (this.scene) this.scene.background = new THREE.Color(this._themeColors().bg);
  };

  GcodeViewer.prototype._bindControls = function () {
    var self = this, e = this.els;
    if (e.scrubber) e.scrubber.addEventListener('input', function (ev) { self._update(parseInt(ev.target.value, 10) || 0); });
    if (e.playButton) e.playButton.addEventListener('click', function () { self.isPlaying ? self._stop() : self._start(); });
    if (e.restartButton) e.restartButton.addEventListener('click', function () {
      if (e.scrubber) e.scrubber.value = 0;
      self._update(0);
      if (self.isPlaying) { self._stop(); setTimeout(function () { self._start(); }, 100); }
    });
    if (e.speedSelect) e.speedSelect.addEventListener('change', function (ev) {
      self.speed = parseInt(ev.target.value, 10) || 40;
      if (self.isPlaying) { self._stop(); self._start(); }
    });
    if (e.resetButton) e.resetButton.addEventListener('click', function () { self.resetView(); });
  };

  /* ----------------------------------------------------------- parsing */
  GcodeViewer.prototype._parse = function (gcode) {
    var lines = gcode.split('\n');
    var moves = [];
    var cx = 0, cy = 0, cz = 0;
    var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    function track(x, y, z) {
      if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
      if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
    }
    var section = '', sectionIndex = -1;
    for (var li = 0; li < lines.length; li++) {
      var t = lines[li].trim();
      var sec = t.match(/^\(Program ((\d+) of \d+: .*)\)$/);
      if (sec) { section = 'Program ' + sec[1]; sectionIndex = parseInt(sec[2], 10) - 1; continue; }
      if (!t || t.charAt(0) === '(' || t.charAt(0) === ';') continue;
      var gm = t.match(/^(G[0-3])\b/);
      if (!gm) continue;
      var type = gm[1];
      var xm = t.match(/X(-?[\d.]+)/), ym = t.match(/Y(-?[\d.]+)/), zm = t.match(/Z(-?[\d.]+)/);
      var nx = xm ? parseFloat(xm[1]) : cx, ny = ym ? parseFloat(ym[1]) : cy, nz = zm ? parseFloat(zm[1]) : cz;

      if (type === 'G2' || type === 'G3') {
        var im = t.match(/I(-?[\d.]+)/), jm = t.match(/J(-?[\d.]+)/);
        if (im && jm) {
          var ai = parseFloat(im[1]), aj = parseFloat(jm[1]);
          var ccx = cx + ai, ccy = cy + aj;
          var sa = Math.atan2(cy - ccy, cx - ccx), ea = Math.atan2(ny - ccy, nx - ccx);
          var r = Math.sqrt(ai * ai + aj * aj);
          var sweep = ea - sa, cw = type === 'G2';
          if (cw) { if (sweep > 0) sweep -= 2 * Math.PI; if (Math.abs(sweep) < 0.001) sweep = -2 * Math.PI; }
          else { if (sweep < 0) sweep += 2 * Math.PI; if (Math.abs(sweep) < 0.001) sweep = 2 * Math.PI; }
          if (isNaN(r) || r <= 0 || isNaN(sweep)) continue;
          var sx = cx, sy = cy, sz = cz;
          var segs = Math.max(8, Math.ceil(Math.abs(sweep) * r * 10));
          var zStep = (nz - sz) / segs;
          for (var s = 0; s < segs; s++) {
            var tt = (s + 1) / segs;
            var ang = sa + sweep * tt;
            var px = ccx + r * Math.cos(ang), py = ccy + r * Math.sin(ang), pz = sz + zStep * (s + 1);
            if (isNaN(px) || isNaN(py) || isNaN(pz)) continue;
            moves.push({ type: type, from: { x: cx, y: cy, z: cz }, to: { x: px, y: py, z: pz }, line: t, section: section, sectionIndex: sectionIndex });
            cx = px; cy = py; cz = pz; track(cx, cy, cz);
          }
          continue;
        }
      }
      if (nx !== cx || ny !== cy || nz !== cz) {
        moves.push({ type: type, from: { x: cx, y: cy, z: cz }, to: { x: nx, y: ny, z: nz }, line: t, section: section, sectionIndex: sectionIndex });
        cx = nx; cy = ny; cz = nz; track(cx, cy, cz);
      }
    }
    return { moves: moves, bounds: b };
  };

  /* -------------------------------------------------------------- load */
  GcodeViewer.prototype.load = function (gcode, opts) {
    opts = opts || {};
    var parsed = this._parse(gcode);
    this.moves = parsed.moves;
    if (!this.moves.length) return;
    var b = parsed.bounds;
    var maxX = b.maxX, maxY = b.maxY, maxZ = b.maxZ, minX = b.minX, minY = b.minY;

    // Clear everything except lights.
    var keep = [];
    this.scene.children.forEach(function (c) { if (c instanceof THREE.Light) keep.push(c); });
    while (this.scene.children.length) this.scene.remove(this.scene.children[0]);
    var scene = this.scene;
    keep.forEach(function (c) { scene.add(c); });
    this.completedLine = this.upcomingLine = this.toolMesh = null;

    var tc = this._themeColors();
    this.scene.background = new THREE.Color(tc.bg);
    var maxDim = Math.max(maxX, maxY, maxZ);
    this._addAxes(Math.max(maxDim, 5) * 0.6);
    var ms = Math.max(0.15, maxDim * 0.02);
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(ms, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff })));

    // Stock box. Prefer explicit stock dims (multi-part sheet); fall back to toolpath extents.
    var stockW = opts.stockWidth || (maxX - minX);
    var stockD = opts.stockDepth || (maxY - minY);
    var stockH = opts.stockHeight || 0.25;
    this.stockHeight = stockH;
    this.stockTop = (opts.stockTop !== undefined) ? opts.stockTop : stockH;
    this.sectionColors = opts.sectionColors || null;
    this.rapidColor = opts.rapidColor || '#6e7681';
    var stockGeo = new THREE.BoxGeometry(stockW, stockH, stockD);
    var stockMat = new THREE.MeshStandardMaterial({
      color: 0xe8f0ff, transparent: true, opacity: 0.15,
      metalness: 0.3, roughness: 0.7, side: THREE.DoubleSide, depthWrite: false
    });
    var stockMesh = new THREE.Mesh(stockGeo, stockMat);
    stockMesh.position.set(stockW / 2, this.stockTop - stockH / 2, -stockD / 2);
    stockMesh.renderOrder = -1;
    this.scene.add(stockMesh);

    var toolDia = opts.toolDiameter || 0.157;
    var toolLen = Math.max((maxZ - this.stockTop) * 1.5, 1.0);
    this.toolMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(toolDia / 2, toolDia / 2, toolLen, 16),
      new THREE.MeshStandardMaterial({ color: 0xc0c0c0, metalness: 0.8, roughness: 0.2, emissive: 0x404040 })
    );
    this.toolMesh.userData.toolLength = toolLen;
    this.scene.add(this.toolMesh);

    // Scrubber + controls.
    if (this.els.scrubber) { this.els.scrubber.max = this.moves.length - 1; this.els.scrubber.value = 0; }
    if (this.els.scrubberContainer) this.els.scrubberContainer.style.display = 'block';
    if (this.els.playbackControls) this.els.playbackControls.style.display = 'flex';
    if (this.els.emptyState) this.els.emptyState.style.display = 'none';

    this._buildPath();
    this._update(0);

    // Camera.
    // Frame the stock: look at its centre from the front-right, a little above.
    var cxs = stockW / 2, czs = -stockD / 2, span = Math.max(stockW, stockD) || 10;
    this.camera.position.set(cxs + span * 0.45, this.stockTop + span * 0.75, czs + span * 0.95);
    this.optimalCam = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
    this.optimalLook = { x: cxs, y: this.stockTop - stockH / 2, z: czs };
    this.controls.target.set(this.optimalLook.x, this.optimalLook.y, this.optimalLook.z);
    this.controls.update();
    this._resize();
  };

  /* ---------------------------------------------------------- playback */
  GcodeViewer.prototype._update = function (idx) {
    if (!this.moves.length) return;
    var e = this.els;
    var move = this.moves[idx];
    if (e.scrubberLabel) e.scrubberLabel.textContent = 'Move ' + (idx + 1) + ' of ' + this.moves.length;
    if (e.scrubberOp) e.scrubberOp.textContent = (move.section ? move.section + ' | ' : '') +
      (move.type === 'G0' ? 'Rapid' : 'Cut') + ': ' + move.line;

    if (this.toolMesh) {
      var x, y, z;
      if (idx === 0) {
        x = move.from.x; y = move.from.y;
        z = (!move.from.z || move.from.z === 0) ? this.stockTop + 0.5 : move.from.z;
      } else {
        x = move.to.x; y = move.to.y; z = move.to.z;
      }
      var tl = this.toolMesh.userData.toolLength;
      this.toolMesh.position.set(x, z + tl / 2, -y);
    }

    // Point k of the path is the tool position after move k-1 (point 0 is the start).
    // Completed = points 0..idx+1, upcoming = points idx+1..end.
    var n = this.moves.length + 1;
    if (this.completedLine) this.completedLine.geometry.setDrawRange(0, idx > 0 ? idx + 2 : 0);
    if (this.upcomingLine) this.upcomingLine.geometry.setDrawRange(idx + 1, idx < n - 2 ? n - idx - 1 : 0);
  };

  // Build both path lines once; playback only changes their draw ranges.
  GcodeViewer.prototype._buildPath = function () {
    var n = this.moves.length + 1;
    var pos = new Float32Array(n * 3);
    var first = this.moves[0];
    var fz = (!first.from.z || first.from.z === 0) ? this.stockTop + 0.5 : first.from.z;
    pos[0] = first.from.x; pos[1] = fz; pos[2] = -first.from.y;
    for (var i = 0; i < this.moves.length; i++) {
      var m = this.moves[i];
      pos[(i + 1) * 3] = m.to.x; pos[(i + 1) * 3 + 1] = m.to.z; pos[(i + 1) * 3 + 2] = -m.to.y;
    }
    var attr = new THREE.BufferAttribute(pos, 3);
    var g1 = new THREE.BufferGeometry(); g1.setAttribute('position', attr);
    var g2 = new THREE.BufferGeometry(); g2.setAttribute('position', attr);
    if (this.sectionColors) {
      // Vertex k ends move k-1, so it takes that move's color (vertex 0 takes the first move's).
      var full = new Float32Array(n * 3), faded = new Float32Array(n * 3);
      var bg = new THREE.Color(this._themeColors().bg), rapid = new THREE.Color(this.rapidColor);
      var cache = {}, self = this;
      var colorOf = function (m) {
        if (m.type === 'G0') return rapid;
        var key = m.sectionIndex;
        if (!cache[key]) cache[key] = new THREE.Color(self.sectionColors[key] || '#fdb515');
        return cache[key];
      };
      for (var v = 0; v < n; v++) {
        var c = colorOf(this.moves[Math.max(0, v - 1)]);
        full[v * 3] = c.r; full[v * 3 + 1] = c.g; full[v * 3 + 2] = c.b;
        var f = c.clone().lerp(bg, 0.6);
        faded[v * 3] = f.r; faded[v * 3 + 1] = f.g; faded[v * 3 + 2] = f.b;
      }
      g1.setAttribute('color', new THREE.BufferAttribute(faded, 3));
      g2.setAttribute('color', new THREE.BufferAttribute(full, 3));
      this.upcomingLine = new THREE.Line(g1, new THREE.LineBasicMaterial({ vertexColors: true }));
      this.completedLine = new THREE.Line(g2, new THREE.LineBasicMaterial({ vertexColors: true }));
    } else {
      this.upcomingLine = new THREE.Line(g1, new THREE.LineBasicMaterial({ color: 0xfdb515, opacity: 0.8, transparent: true }));
      this.completedLine = new THREE.Line(g2, new THREE.LineBasicMaterial({ color: 0x2ea043 }));
    }
    this.scene.add(this.upcomingLine);
    this.scene.add(this.completedLine);
  };

  GcodeViewer.prototype._start = function () {
    // If playback is parked at the end (it auto-pauses there), pressing play should
    // replay from the beginning rather than sit stuck at the last move.
    var cur = this.els.scrubber ? parseInt(this.els.scrubber.value, 10) : 0;
    if (cur >= this.moves.length - 1) {
      if (this.els.scrubber) this.els.scrubber.value = 0;
      this._update(0);
    }
    this.isPlaying = true;
    if (this.els.playButton) { this.els.playButton.classList.add('playing'); this.els.playButton.textContent = 'Pause'; }
    var self = this;
    // speed is moves per second; tick ~60 times a second and advance as many moves as needed.
    var tick = 1000 / 60, carry = 0;
    this.interval = setInterval(function () {
      var cur = self.els.scrubber ? parseInt(self.els.scrubber.value, 10) : 0;
      var max = self.moves.length - 1;
      if (cur >= max) { self._stop(); return; }
      carry += self.speed / 60;
      var step = Math.floor(carry);
      if (step < 1) return;
      carry -= step;
      var next = Math.min(max, cur + step);
      if (self.els.scrubber) self.els.scrubber.value = next;
      self._update(next);
    }, tick);
  };

  GcodeViewer.prototype._stop = function () {
    this.isPlaying = false;
    if (this.els.playButton) { this.els.playButton.classList.remove('playing'); this.els.playButton.textContent = 'Play'; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  };

  GcodeViewer.prototype.resetView = function () {
    if (!this.controls) return;
    this.camera.position.set(this.optimalCam.x, this.optimalCam.y, this.optimalCam.z);
    this.controls.target.set(this.optimalLook.x, this.optimalLook.y, this.optimalLook.z);
    this.controls.update();
  };

  /* ------------------------------------------------------------- axes */
  // A billboard text label (canvas sprite) for an axis tip.
  GcodeViewer.prototype._axisSprite = function (text, hex) {
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = hex;
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 32, 34);
    var tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  };

  // Draw labeled machine axes at the origin. The gcode->THREE remap is (x, z, -y), so
  // machine +X -> THREE (1,0,0), +Y -> THREE (0,0,-1), +Z -> THREE (0,1,0). Colors match
  // the 2D layout view: X red, Y green, Z blue. Y therefore points toward the part (into
  // the scene), not toward the camera as the old generic AxesHelper's blue Z did.
  GcodeViewer.prototype._addAxes = function (len) {
    var self = this;
    var lblScale = Math.max(len * 0.18, 0.5);
    [
      { dir: [1, 0, 0], color: 0xff0000, hex: '#ff0000', label: 'X' },
      { dir: [0, 0, -1], color: 0x2ea043, hex: '#2ea043', label: 'Y' },
      { dir: [0, 1, 0], color: 0x2f81f7, hex: '#2f81f7', label: 'Z' },
    ].forEach(function (ax) {
      var end = new THREE.Vector3(ax.dir[0] * len, ax.dir[1] * len, ax.dir[2] * len);
      self.scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), end]),
        new THREE.LineBasicMaterial({ color: ax.color })));
      var spr = self._axisSprite(ax.label, ax.hex);
      spr.scale.set(lblScale, lblScale, lblScale);
      spr.position.copy(end.clone().multiplyScalar(1.12));
      self.scene.add(spr);
    });
  };

  window.GcodeViewer = GcodeViewer;
})();
