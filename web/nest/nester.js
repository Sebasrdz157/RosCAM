/*!
 * RosCAM nesting core.
 *
 * Adapted from SVGnest (https://github.com/Jack000/SVGnest, commit 1248dc2), Copyright 2015
 * Jack Qiao, MIT license (see LICENSE-SVGnest.txt): the genetic algorithm (order + rotation of
 * parts) and the no-fit-polygon placement from svgnest.js / util/placementworker.js. Uses
 * SVGnest's clipper.js and geometryutil.js unchanged.
 *
 * Changes for RosCAM:
 *   - No SVG/DOM: parts, sheet and obstacles come in as plain polygons ([[x, y], ...], inches).
 *   - One sheet only: parts that don't fit are reported instead of opening a new bin.
 *   - Fixed obstacles (a sheet's used areas) are treated as parts already placed.
 *   - Gravity pulls parts down then left, so the leftover stays one piece at the top.
 *   - No-fit polygons are cached per part shape, not per copy, so quantities are cheap.
 *   - Runs step by step (one layout per step) so a worker can report progress and stop.
 *   - Allowed rotations are an explicit list (e.g. [0, 90, 180, 270] or [0]).
 *
 * Coordinates: a placement {x, y, rotation} means "turn the part's shape `rotation` degrees
 * counter-clockwise about (0, 0), then move it by (x, y)".
 */
(function (root) {
  'use strict';

  var G = root.GeometryUtil;
  var CL = root.ClipperLib;
  var SCALE = 10000000;            // clipper works in integers (SVGnest's clipperScale)

  function toPts(poly) {
    var pts = poly.map(function (p) { return { x: Number(p[0]), y: Number(p[1]) }; });
    var a = pts[0], b = pts[pts.length - 1];
    if (pts.length > 1 && G.almostEqual(a.x, b.x) && G.almostEqual(a.y, b.y)) pts.pop();
    if (G.polygonArea(pts) > 0) pts.reverse();      // SVGnest convention: negative area
    return pts;
  }

  function rotate(poly, deg) {
    if (!deg) return poly.map(function (p) { return { x: p.x, y: p.y }; });
    return G.rotatePolygon(poly, deg);
  }

  function bounds(poly) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i];
      if (p.x < b.x0) b.x0 = p.x; if (p.x > b.x1) b.x1 = p.x;
      if (p.y < b.y0) b.y0 = p.y; if (p.y > b.y1) b.y1 = p.y;
    }
    return b;
  }

  function toClipper(poly, dx, dy) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      out.push({ X: Math.round((poly[i].x + (dx || 0)) * SCALE), Y: Math.round((poly[i].y + (dy || 0)) * SCALE) });
    }
    return out;
  }
  function fromClipper(path) {
    return path.map(function (p) { return { x: p.X / SCALE, y: p.Y / SCALE }; });
  }

  // Outer no-fit polygon of B around A (where B's first point may not go), from SVGnest's
  // minkowskiDifference: Minkowski sum of A and -B, shifted by B[0].
  function outerNfp(A, B) {
    var Ac = toClipper(A), Bc = toClipper(B);
    for (var i = 0; i < Bc.length; i++) { Bc[i].X = -Bc[i].X; Bc[i].Y = -Bc[i].Y; }
    var solution = CL.Clipper.MinkowskiSum(Ac, Bc, true);
    var nfp = null, largest = null;
    for (i = 0; i < solution.length; i++) {
      var n = fromClipper(solution[i]);
      var area = G.polygonArea(n);
      if (largest === null || largest > area) { nfp = n; largest = area; }
    }
    if (!nfp) return null;
    for (i = 0; i < nfp.length; i++) { nfp[i].x += B[0].x; nfp[i].y += B[0].y; }
    if (Math.abs(G.polygonArea(nfp)) < Math.abs(G.polygonArea(A))) return null;   // SVGnest sanity check
    if (G.polygonArea(nfp) > 0) nfp.reverse();
    return [nfp];
  }

  // Inner fit: where B's first point may go so B stays inside the rectangular sheet.
  function innerFit(bin, B) {
    var nfp = G.noFitPolygonRectangle(bin, B);
    if (!nfp || !nfp.length) return null;
    for (var i = 0; i < nfp.length; i++) if (G.polygonArea(nfp[i]) > 0) nfp[i].reverse();
    return nfp;
  }

  // ---------------------------------------------------------------- genetic algorithm
  // From SVGnest's GeneticAlgorithm: an individual is an insertion order plus one rotation
  // per part; children come from single-point crossover, then small random mutations.
  function GeneticAlgorithm(adam, binBounds, config) {
    this.config = config;
    this.binBounds = binBounds;
    var angles = adam.map(this.randomAngle, this);
    this.population = [{ placement: adam, rotation: angles }];
    while (this.population.length < config.populationSize) {
      this.population.push(this.mutate(this.population[0]));
    }
  }
  GeneticAlgorithm.prototype.randomAngle = function (part) {
    var list = this.config.angles.slice(0);
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(this.config.random() * (i + 1)), t = list[i]; list[i] = list[j]; list[j] = t;
    }
    for (i = 0; i < list.length; i++) {
      var b = bounds(rotate(part.poly, list[i]));
      if (b.x1 - b.x0 <= this.binBounds.width && b.y1 - b.y0 <= this.binBounds.height) return list[i];
    }
    return list[0];
  };
  GeneticAlgorithm.prototype.mutate = function (ind) {
    var c = { placement: ind.placement.slice(0), rotation: ind.rotation.slice(0) };
    var rate = 0.01 * this.config.mutationRate;
    for (var i = 0; i < c.placement.length; i++) {
      if (this.config.random() < rate && i + 1 < c.placement.length) {
        var t = c.placement[i]; c.placement[i] = c.placement[i + 1]; c.placement[i + 1] = t;
        t = c.rotation[i]; c.rotation[i] = c.rotation[i + 1]; c.rotation[i + 1] = t;
      }
      if (this.config.random() < rate) c.rotation[i] = this.randomAngle(c.placement[i]);
    }
    return c;
  };
  GeneticAlgorithm.prototype.mate = function (male, female) {
    var cut = Math.round(Math.min(Math.max(this.config.random(), 0.1), 0.9) * (male.placement.length - 1));
    function child(a, b) {
      var gene = a.placement.slice(0, cut), rot = a.rotation.slice(0, cut);
      var have = {};
      gene.forEach(function (g) { have[g.uid] = true; });
      for (var i = 0; i < b.placement.length; i++) {
        if (!have[b.placement[i].uid]) { gene.push(b.placement[i]); rot.push(b.rotation[i]); }
      }
      return { placement: gene, rotation: rot };
    }
    return [child(male, female), child(female, male)];
  };
  GeneticAlgorithm.prototype.generation = function () {
    this.population.sort(function (a, b) { return a.fitness - b.fitness; });
    var next = [this.population[0]];                     // keep the best (elitism)
    while (next.length < this.population.length) {
      var male = this.pick(), female = this.pick(male);
      var kids = this.mate(male, female);
      next.push(this.mutate(kids[0]));
      if (next.length < this.population.length) next.push(this.mutate(kids[1]));
    }
    this.population = next;
  };
  GeneticAlgorithm.prototype.pick = function (exclude) {
    var pop = this.population.filter(function (p) { return p !== exclude; });
    var r = this.config.random(), lower = 0, w = 1 / pop.length, upper = w;
    for (var i = 0; i < pop.length; i++) {
      if (r > lower && r < upper) return pop[i];
      lower = upper;
      upper += 2 * w * ((pop.length - i) / pop.length);
    }
    return pop[0];
  };

  // ---------------------------------------------------------------- nester
  /**
   * opts.bin        rectangle the shapes must stay inside, as a polygon
   * opts.obstacles  polygons the shapes may not overlap (used areas), fixed in place
   * opts.parts      [{shape: polygon, quantity}] (shape already includes spacing)
   * opts.angles     allowed rotations in degrees, default [0, 90, 180, 270]
   */
  function Nester(opts) {
    var self = this;
    this.bin = toPts(opts.bin);
    var bb = bounds(this.bin);
    this.binBounds = { x0: bb.x0, y0: bb.y0, width: bb.x1 - bb.x0, height: bb.y1 - bb.y0 };
    this.obstacles = (opts.obstacles || []).filter(function (o) { return o.length >= 3; }).map(toPts);
    this.shapes = opts.parts.map(function (p) { return toPts(p.shape); });
    this.items = [];
    opts.parts.forEach(function (p, src) {
      for (var k = 0; k < (p.quantity || 1); k++) {
        self.items.push({ uid: src + ':' + k, src: src, poly: self.shapes[src],
                          area: Math.abs(G.polygonArea(self.shapes[src])) });
      }
    });
    var adam = this.items.slice(0).sort(function (a, b) { return b.area - a.area; });   // biggest first
    this.config = {
      angles: opts.angles && opts.angles.length ? opts.angles : [0, 90, 180, 270],
      populationSize: opts.populationSize || 10,
      mutationRate: opts.mutationRate || 10,
      random: opts.random || Math.random,
    };
    this.ga = new GeneticAlgorithm(adam, this.binBounds, this.config);
    this.cache = {};
    this.best = null;
    this.generationCount = 0;
    this.evaluated = 0;
  }

  Nester.prototype._rotated = function (src, rot) {
    var key = 'r|' + src + '|' + rot;
    return this.cache[key] || (this.cache[key] = rotate(this.shapes[src], rot));
  };
  Nester.prototype._inner = function (src, rot) {
    var key = 'i|' + src + '|' + rot;
    if (!(key in this.cache)) this.cache[key] = innerFit(this.bin, this._rotated(src, rot));
    return this.cache[key];
  };
  Nester.prototype._outer = function (aKey, A, src, rot) {
    var key = 'o|' + aKey + '|' + src + '|' + rot;
    if (!(key in this.cache)) this.cache[key] = outerNfp(A, this._rotated(src, rot));
    return this.cache[key];
  };

  // Place parts in the individual's order (SVGnest's placePaths, single sheet).
  Nester.prototype.place = function (ind) {
    var placed = [];      // {key, poly, x, y}: obstacles first, then parts
    var self = this;
    this.obstacles.forEach(function (o, k) { placed.push({ key: 'ob' + k, poly: o, x: 0, y: 0 }); });
    var placements = [], unplaced = [];
    var maxX = -Infinity, maxY = -Infinity;

    for (var i = 0; i < ind.placement.length; i++) {
      var item = ind.placement[i], rot = ind.rotation[i];
      var path = this._rotated(item.src, rot);
      var binNfp = this._inner(item.src, rot);
      if (!binNfp) { unplaced.push(item); continue; }

      var clipper = new CL.Clipper(), any = false;
      for (var j = 0; j < placed.length; j++) {
        var nfp = this._outer(placed[j].key, placed[j].poly, item.src, rot);
        if (!nfp) continue;
        for (var k = 0; k < nfp.length; k++) {
          var c = CL.Clipper.CleanPolygon(toClipper(nfp[k], placed[j].x, placed[j].y), 0.0001 * SCALE);
          if (c.length > 2 && Math.abs(CL.Clipper.Area(c)) > 0.1 * SCALE * SCALE * 1e-8) {
            clipper.AddPath(c, CL.PolyType.ptSubject, true);
            any = true;
          }
        }
      }
      var finalNfp;
      var binPaths = binNfp.map(function (p) { return toClipper(p); });
      if (any) {
        var combined = new CL.Paths();
        if (!clipper.Execute(CL.ClipType.ctUnion, combined, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero)) {
          unplaced.push(item); continue;
        }
        var diff = new CL.Paths();
        clipper = new CL.Clipper();
        clipper.AddPaths(combined, CL.PolyType.ptClip, true);
        clipper.AddPaths(binPaths, CL.PolyType.ptSubject, true);
        if (!clipper.Execute(CL.ClipType.ctDifference, diff, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero)) {
          unplaced.push(item); continue;
        }
        finalNfp = CL.Clipper.CleanPolygons(diff, 0.0001 * SCALE).map(fromClipper);
      } else {
        finalNfp = binNfp;
      }
      // A position is any vertex of the free region. A degenerate (zero-area) region is
      // still valid: e.g. a part exactly as wide as the free space can only go in one spot.
      var pb = bounds(path), best = null;
      for (j = 0; j < finalNfp.length; j++) {
        var nf = finalNfp[j];
        if (nf.length < 1) continue;
        for (k = 0; k < nf.length; k++) {
          var sx = nf[k].x - path[0].x, sy = nf[k].y - path[0].y;
          var top = Math.max(maxY, sy + pb.y1), right = Math.max(maxX, sx + pb.x1);
          // Gravity: keep the layout low first, then narrow; ties go lowest, then left-most.
          var score = top * 2 + right;
          var low = sy + pb.y0;
          if (!best || score < best.score - 1e-9 ||
              (Math.abs(score - best.score) <= 1e-9 && (low < best.low - 1e-9 ||
               (Math.abs(low - best.low) <= 1e-9 && sx < best.x)))) {
            best = { score: score, low: low, x: sx, y: sy };
          }
        }
      }
      if (!best) { unplaced.push(item); continue; }
      placed.push({ key: 's' + item.src + '@' + rot, poly: path, x: best.x, y: best.y });
      placements.push({ part: item.src, uid: item.uid, x: best.x, y: best.y, rotation: rot });
      maxX = Math.max(maxX, best.x + pb.x1);
      maxY = Math.max(maxY, best.y + pb.y1);
    }
    var h = this.binBounds.height || 1, w = this.binBounds.width || 1;
    var fitness = unplaced.length * 1000 + (placements.length ? (maxY - this.binBounds.y0) / h + 0.1 * (maxX - this.binBounds.x0) / w : 0);
    return { fitness: fitness, placements: placements, unplaced: unplaced.map(function (u) { return u.src; }),
             top: placements.length ? maxY : null };
  };

  // Evaluate one more layout. Returns true when it beat the best so far.
  Nester.prototype.step = function () {
    var ind = null, pop = this.ga.population;
    for (var i = 0; i < pop.length; i++) if (pop[i].fitness === undefined) { ind = pop[i]; break; }
    if (!ind) {
      this.ga.generation();
      this.generationCount++;
      ind = this.ga.population[1] || this.ga.population[0];
      if (ind.fitness !== undefined) return false;
    }
    var res = this.place(ind);
    ind.fitness = res.fitness;
    this.evaluated++;
    if (!this.best || res.fitness < this.best.fitness - 1e-9) {
      this.best = res;
      return true;
    }
    return false;
  };

  Nester.prototype.utilization = function () {
    if (!this.best) return 0;
    var self = this, used = 0;
    this.best.placements.forEach(function (p) { used += Math.abs(G.polygonArea(self.shapes[p.part])); });
    return used / (this.binBounds.width * this.binBounds.height);
  };

  root.RosNester = Nester;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
