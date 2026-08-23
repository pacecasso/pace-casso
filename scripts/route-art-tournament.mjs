#!/usr/bin/env node
/*
 * Offline GPS-art generator tournament prototype.
 *
 * Runs three competing generator lanes against the same target sketch:
 *  1. semantic: use the artist-authored line directly at city scale
 *  2. block: quantize the etch-a-sketch line to average Manhattan block units
 *  3. inverse: sample the target and choose the nearest real street nodes
 *
 * This is deliberately Manhattan-only and offline. It outputs a visual sheet
 * and JSON scores so we can compare approaches without touching production UI.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const createJiti = require("jiti");
const jiti = createJiti(fileURLToPath(import.meta.url), { fsCache: false });
const { fillLineMaskSignificantComponents } = jiti("../lib/inkMaskUnionEnclosed.ts");
const { filledSilhouetteToLineArtMask } = jiti("../lib/filledSilhouetteToLineArtMask.ts");
const { extractNormalizedContourFromLineMask } = jiti("../lib/extractNormalizedContourFromLineMask.ts");
const { inkThresholdForUpload } = jiti("../lib/otsuThreshold.ts");
const OUT_ROOT = path.join(ROOT, "tmp-route-tournament");
const LATTICE_PATH = path.join(ROOT, "lib", "data", "manhattan-lattice.json");
const M_PER_LAT = 111_320;
const STREET_BEARING = 119;
const AVENUE_BEARING = 29;
const BOX_SIZE = 300;
const LUM_SAMPLE_SUPER = 2;
const LUM_SAMPLE_PX = BOX_SIZE * LUM_SAMPLE_SUPER;
const DEFAULT_CONTOUR_LEVEL = 0.22;
const PHOTO_BLUR_SIGMA = 1.0;
const PHOTO_LINE_ART_OUTLINE_LAYERS = 3;


function unit(deg) {
  const r = (deg * Math.PI) / 180;
  return { e: Math.sin(r), n: Math.cos(r) };
}
const X_AXIS = unit(STREET_BEARING);
const Y_AXIS = unit(AVENUE_BEARING);

function mPerLng(lat) {
  return M_PER_LAT * Math.cos((lat * Math.PI) / 180);
}

function meters(a, b) {
  return Math.hypot(
    (b[0] - a[0]) * M_PER_LAT,
    (b[1] - a[1]) * mPerLng((a[0] + b[0]) / 2),
  );
}

function toLatLngFrom(origin, [x, y]) {
  const e = x * X_AXIS.e + y * Y_AXIS.e;
  const n = x * X_AXIS.n + y * Y_AXIS.n;
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng(origin[0])];
}

function toLocalFrom(origin, [lat, lng]) {
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng(origin[0]);
  const det = X_AXIS.e * Y_AXIS.n - Y_AXIS.e * X_AXIS.n;
  return [(e * Y_AXIS.n - Y_AXIS.e * n) / det, (X_AXIS.e * n - e * X_AXIS.n) / det];
}

function placeLocalAtCenter(local, center) {
  const xs = local.map((p) => p[0]);
  const ys = local.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const offset = toLatLngFrom(center, [cx, cy]);
  const origin = [center[0] - (offset[0] - center[0]), center[1] - (offset[1] - center[1])];
  return { origin, latLngs: local.map((p) => toLatLngFrom(origin, p)) };
}

function loadGraph() {
  const data = JSON.parse(fs.readFileSync(LATTICE_PATH, "utf8"));
  const adj = Array.from({ length: data.nodes.length }, () => []);
  for (const [a, b, len, via] of data.edges) {
    adj[a].push({ to: b, len, via });
    adj[b].push({ to: a, len, via: [...via].reverse() });
  }
  return { nodes: data.nodes, edges: data.edges, adj };
}
function labelConnectedComponents4(binary, w, h) {
  const labels = new Int32Array(w * h);
  let nextLabel = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (binary[i] === 0 || labels[i] !== 0) continue;
      nextLabel++;
      const stack = [i];
      while (stack.length) {
        const j = stack.pop();
        if (labels[j] !== 0 || binary[j] === 0) continue;
        labels[j] = nextLabel;
        const jx = j % w;
        const jy = (j / w) | 0;
        if (jx > 0) stack.push(j - 1);
        if (jx < w - 1) stack.push(j + 1);
        if (jy > 0) stack.push(j - w);
        if (jy < h - 1) stack.push(j + w);
      }
    }
  }
  return labels;
}

function gaussianBlurFloat32(src, w, h, sigma) {
  const radius = Math.ceil(sigma * 2.5);
  const ks = 2 * radius + 1;
  const kernel = new Float32Array(ks);
  let ksum = 0;
  for (let i = 0; i < ks; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    ksum += kernel[i];
  }
  for (let i = 0; i < ks; i++) kernel[i] /= ksum;

  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < ks; k++) {
        v += src[y * w + Math.max(0, Math.min(w - 1, x + k - radius))] * kernel[k];
      }
      tmp[y * w + x] = v;
    }
  }

  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < ks; k++) {
        v += tmp[Math.max(0, Math.min(h - 1, y + k - radius)) * w + x] * kernel[k];
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function inkFromRgba(data, idx) {
  const a = data[idx + 3];
  if (a < 128) return 0;
  return 1 - (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255;
}

async function traceImageProductionPath(imagePath, options = {}) {
  const meta = await sharp(imagePath).metadata();
  const inputHasAlpha = Boolean(meta.hasAlpha);
  const crop = options.crop;
  const cropBox = crop
    ? {
        left: Math.max(0, Math.round((meta.width || 1) * crop.left)),
        top: Math.max(0, Math.round((meta.height || 1) * crop.top)),
        width: Math.max(1, Math.round((meta.width || 1) * crop.width)),
        height: Math.max(1, Math.round((meta.height || 1) * crop.height)),
      }
    : null;
  const sourceW = cropBox?.width || meta.width || LUM_SAMPLE_PX;
  const sourceH = cropBox?.height || meta.height || LUM_SAMPLE_PX;
  const resizeScale = Math.min(LUM_SAMPLE_PX / sourceW, LUM_SAMPLE_PX / sourceH);
  const drawnFrac = (sourceW * resizeScale * sourceH * resizeScale) / (LUM_SAMPLE_PX * LUM_SAMPLE_PX);
  let img = sharp(imagePath).ensureAlpha();
  if (cropBox) img = img.extract(cropBox);
  img = img.resize(LUM_SAMPLE_PX, LUM_SAMPLE_PX, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });

  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  const transparentFrac = transparent / (LUM_SAMPLE_PX * LUM_SAMPLE_PX);

  let lum;
  let threshold;
  let useAlpha = inputHasAlpha && transparentFrac > 0.1;
  if (useAlpha) {
    const alphaLum = new Float32Array(BOX_SIZE * BOX_SIZE);
    let fg = 0;
    for (let y = 0; y < BOX_SIZE; y++) {
      for (let x = 0; x < BOX_SIZE; x++) {
        let maxA = 0;
        for (let dy = 0; dy < LUM_SAMPLE_SUPER; dy++) {
          for (let dx = 0; dx < LUM_SAMPLE_SUPER; dx++) {
            const a = data[((y * LUM_SAMPLE_SUPER + dy) * LUM_SAMPLE_PX + (x * LUM_SAMPLE_SUPER + dx)) * 4 + 3];
            if (a > maxA) maxA = a;
          }
        }
        const v = maxA >= 128 ? 1 : 0;
        alphaLum[y * BOX_SIZE + x] = v;
        fg += v;
      }
    }
    if (fg / alphaLum.length > drawnFrac * 0.92) {
      useAlpha = false;
    } else {
      lum = alphaLum;
      threshold = 0.5;
    }
  }

  if (!useAlpha) {
    const raw = new Float32Array(BOX_SIZE * BOX_SIZE);
    for (let y = 0; y < BOX_SIZE; y++) {
      for (let x = 0; x < BOX_SIZE; x++) {
        let minL = 1;
        for (let dy = 0; dy < LUM_SAMPLE_SUPER; dy++) {
          for (let dx = 0; dx < LUM_SAMPLE_SUPER; dx++) {
            const l = inkFromRgba(data, ((y * LUM_SAMPLE_SUPER + dy) * LUM_SAMPLE_PX + (x * LUM_SAMPLE_SUPER + dx)) * 4);
            if (l < minL) minL = l;
          }
        }
        raw[y * BOX_SIZE + x] = minL;
      }
    }
    lum = gaussianBlurFloat32(raw, BOX_SIZE, BOX_SIZE, PHOTO_BLUR_SIGMA);
    threshold = inkThresholdForUpload(lum);
  }

  const binary = new Uint8Array(BOX_SIZE * BOX_SIZE);
  for (let i = 0; i < binary.length; i++) binary[i] = lum[i] >= threshold ? 1 : 0;
  const labels = labelConnectedComponents4(binary, BOX_SIZE, BOX_SIZE);
  let maxLabel = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
  const counts = new Array(maxLabel + 1).fill(0);
  for (let i = 0; i < labels.length; i++) if (labels[i] > 0) counts[labels[i]]++;
  const entries = [];
  for (let label = 1; label <= maxLabel; label++) if (counts[label] > 0) entries.push({ label, count: counts[label] });
  entries.sort((a, b) => b.count - a.count);
  if (entries.length === 0) throw new Error(`no foreground in ${imagePath}`);

  const filled = new Uint8Array(BOX_SIZE * BOX_SIZE);
  fillLineMaskSignificantComponents(labels, entries, 0, filled, BOX_SIZE, BOX_SIZE);
  const outline = filledSilhouetteToLineArtMask(filled, BOX_SIZE, BOX_SIZE, PHOTO_LINE_ART_OUTLINE_LAYERS);
  const contour = extractNormalizedContourFromLineMask(outline, DEFAULT_CONTOUR_LEVEL, BOX_SIZE, BOX_SIZE);
  if (!contour || contour.length < 4) throw new Error(`contour too short in ${imagePath}`);
  return {
    contour,
    trace: {
      mode: useAlpha ? "alpha" : "luminance",
      transparentPct: Number((transparentFrac * 100).toFixed(1)),
      threshold: Number(threshold.toFixed(3)),
      components: entries.length,
      points: contour.length,
    },
  };
}

function nearestNode(graph, p, maxM = 180) {
  let best = -1;
  let bd = maxM;
  for (let i = 0; i < graph.nodes.length; i++) {
    const d = meters(p, graph.nodes[i]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function dijkstra(graph, a, b) {
  if (a === b) return [a];
  const dist = new Float64Array(graph.nodes.length);
  dist.fill(Infinity);
  dist[a] = 0;
  const prev = new Int32Array(graph.nodes.length);
  prev.fill(-1);
  const used = new Uint8Array(graph.nodes.length);

  for (let iter = 0; iter < graph.nodes.length; iter++) {
    let u = -1;
    let bd = Infinity;
    for (let i = 0; i < dist.length; i++) {
      if (!used[i] && dist[i] < bd) {
        bd = dist[i];
        u = i;
      }
    }
    if (u < 0 || u === b) break;
    used[u] = 1;
    for (const edge of graph.adj[u]) {
      const nd = bd + edge.len;
      if (nd < dist[edge.to]) {
        dist[edge.to] = nd;
        prev[edge.to] = u;
      }
    }
  }
  if (!Number.isFinite(dist[b])) return null;
  const ids = [];
  let cur = b;
  while (cur !== -1) {
    ids.push(cur);
    if (cur === a) break;
    cur = prev[cur];
  }
  if (ids[ids.length - 1] !== a) return null;
  return ids.reverse();
}

function appendNodePath(graph, out, ids) {
  for (const id of ids) {
    const p = graph.nodes[id];
    if (!out.length || meters(out[out.length - 1], p) > 2) out.push(p);
  }
}

function routeThroughNodes(graph, nodeIds) {
  const chain = [];
  let skipped = 0;
  let legs = 0;
  for (let i = 1; i < nodeIds.length; i++) {
    const a = nodeIds[i - 1];
    const b = nodeIds[i];
    if (a == null || b == null || a === b) continue;
    const ids = dijkstra(graph, a, b);
    if (!ids) {
      skipped++;
      continue;
    }
    legs++;
    appendNodePath(graph, chain, ids);
  }
  return { chain, skipped, legs };
}

function pathLengthLocal(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) {
    m += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return m;
}

function densifyLocal(points, stepM) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(d / stepM));
    for (let s = 1; s <= n; s++) {
      out.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
    }
  }
  return out;
}

function quantizeLocal(points, xStep = 274, yStep = 80) {
  const out = [];
  for (const [x, y] of densifyLocal(points, 45)) {
    const q = [Math.round(x / xStep) * xStep, Math.round(y / yStep) * yStep];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  return out;
}

function circle(cx, cy, r, start, end, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = start + ((end - start) * i) / n;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return pts;
}

function makeLoveTarget() {
  const u = 210;
  const h = 4 * u;
  const gap = 1.25 * u;
  let x = 0;
  const pts = [];
  const push = (p) => pts.push([x + p[0] * u, p[1] * u]);
  // L
  [[0, 0], [0, h / u], [1.7, h / u]].forEach(push);
  x += 1.7 * u + gap;
  pts.push([x, h]);
  // O rectangle counter as one loop
  [[0, h / u], [0, 0], [2.1, 0], [2.1, h / u], [0, h / u]].forEach(push);
  x += 2.1 * u + gap;
  pts.push([x, 0]);
  // V
  [[0, 0], [1.05, h / u], [2.1, 0]].forEach(push);
  x += 2.1 * u + gap;
  pts.push([x, 0]);
  // E
  [[2.0, 0], [0, 0], [0, 2], [1.6, 2], [0, 2], [0, 4], [2.0, 4]].forEach(push);
  return centerLocal(pts);
}

function makeNikeTarget() {
  return centerLocal([
    [-1650, 180], [-1270, 90], [-720, 5], [-50, -75], [660, -145], [1550, -260],
    [1190, -65], [540, 120], [-130, 270], [-780, 360], [-1320, 350], [-1650, 210],
  ]);
}

function makeGasTarget() {
  const coil = circle(980, 180, 250, Math.PI * 0.1, Math.PI * 2.1, 24);
  return centerLocal([
    [-720, -920], [-720, 760], [-460, 1040], [420, 1040], [690, 760], [690, -920], [-720, -920],
    [-500, 360], [-500, 720], [310, 720], [310, 360], [-500, 360],
    [690, -220], [760, 120], ...coil, [1320, 40], [1580, -220], [1340, -310], [1110, -180],
  ]);
}

function centerLocal(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return points.map(([x, y]) => [x - cx, y - cy]);
}

const TARGET_SPECS = {
  love: {
    label: "LOVE",
    center: [40.752, -73.989],
    fitM: 5200,
    imageCandidates: [],
    preferSynthetic: true,
    syntheticLocal: makeLoveTarget,
  },
  nike: {
    label: "Nike swoosh",
    center: [40.752, -73.99],
    fitM: 2400,
    crop: { left: 0, top: 0, width: 1, height: 0.46 },
    imageCandidates: ["nike.png"],
    preferSynthetic: true,
    syntheticLocal: makeNikeTarget,
  },
  gas: {
    label: "Gas pump",
    center: [40.752, -73.989],
    fitM: 1200,
    imageCandidates: ["gas.png"],
    syntheticLocal: makeGasTarget,
  },
};

function firstExistingImage(candidates) {
  for (const name of candidates) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function normalizedContourToLocal(contour, fitM) {
  const xs = contour.map((p) => p.x);
  const ys = contour.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const scale = fitM / Math.max(maxX - minX, maxY - minY, 0.001);
  return contour.map((p) => [(p.x - cx) * scale, (cy - p.y) * scale]);
}

async function loadTarget(targetId, options = {}) {
  const spec = TARGET_SPECS[targetId];
  if (!spec) throw new Error(`Unknown target "${targetId}". Use ${Object.keys(TARGET_SPECS).join(", ")}, or all.`);

  if (!options.synthetic && !spec.preferSynthetic) {
    const imagePath = firstExistingImage(spec.imageCandidates);
    if (imagePath) {
      const traced = await traceImageProductionPath(imagePath, { crop: spec.crop });
      return {
        label: spec.label,
        center: spec.center,
        local: centerLocal(normalizedContourToLocal(traced.contour, spec.fitM)),
        source: {
          kind: "image",
          file: path.relative(ROOT, imagePath).replace(/\\/g, "/"),
          ...traced.trace,
        },
      };
    }
  }

  return {
    label: `${spec.label} synthetic`,
    center: spec.center,
    local: spec.syntheticLocal(),
    source: { kind: "synthetic", file: null, points: spec.syntheticLocal().length },
  };
}

function routeKm(chain) {
  let m = 0;
  for (let i = 1; i < chain.length; i++) m += meters(chain[i - 1], chain[i]);
  return m / 1000;
}

function nearestDistanceLocal(p, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const bx = b[0] - a[0];
    const by = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * bx + (p[1] - a[1]) * by) / (bx * bx + by * by || 1)));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + bx * t), p[1] - (a[1] + by * t)));
  }
  return best;
}

function scoreRoute(targetLocal, routeLocal, skipped) {
  const targetSamples = densifyLocal(targetLocal, 45);
  const routeSamples = densifyLocal(routeLocal, 45);
  let cov = 0;
  let targetErr = 0;
  for (const p of targetSamples) {
    const d = nearestDistanceLocal(p, routeSamples);
    targetErr += d;
    if (d <= 125) cov++;
  }
  let near = 0;
  let extraErr = 0;
  for (const p of routeSamples) {
    const d = nearestDistanceLocal(p, targetSamples);
    extraErr += d;
    if (d <= 160) near++;
  }
  const coverage = targetSamples.length ? cov / targetSamples.length : 0;
  const precision = routeSamples.length ? near / routeSamples.length : 0;
  const meanTargetErrorM = targetSamples.length ? targetErr / targetSamples.length : Infinity;
  const meanExtraErrorM = routeSamples.length ? extraErr / routeSamples.length : Infinity;
  const score = Math.max(
    0,
    Math.round(100 * (0.64 * coverage + 0.36 * precision) - skipped * 8 - meanTargetErrorM * 0.035 - meanExtraErrorM * 0.015),
  );
  return {
    score,
    coverage: Number((coverage * 100).toFixed(1)),
    precision: Number((precision * 100).toFixed(1)),
    meanTargetErrorM: Number(meanTargetErrorM.toFixed(1)),
    meanExtraErrorM: Number(meanExtraErrorM.toFixed(1)),
  };
}

const MANHATTAN_PLACEMENT_CENTERS = [
  [40.752, -73.989],
  [40.741, -73.992],
  [40.764, -73.981],
  [40.729, -73.986],
  [40.776, -73.977],
  [40.716, -74.006],
  [40.786, -73.968],
  [40.748, -73.969],
];

function buildCandidateAtCenter(graph, target, generator, center) {
  const { origin, latLngs } = placeLocalAtCenter(generator.local, center);
  const nodeIds = [];
  for (const p of latLngs) {
    const id = nearestNode(graph, p, generator.pinM ?? 185);
    if (id >= 0 && id !== nodeIds[nodeIds.length - 1]) nodeIds.push(id);
  }
  const routed = routeThroughNodes(graph, nodeIds);
  const routeLocal = routed.chain.map((p) => toLocalFrom(origin, p));
  const score = scoreRoute(target.local, routeLocal, routed.skipped);
  return {
    id: generator.id,
    label: generator.label,
    origin,
    placementCenter: center,
    intendedLocal: generator.local,
    routeLocal,
    chain: routed.chain,
    pins: nodeIds.length,
    legs: routed.legs,
    skipped: routed.skipped,
    km: Number(routeKm(routed.chain).toFixed(2)),
    ...score,
  };
}

function betterCandidate(a, b) {
  if (!a) return b;
  if (b.score !== a.score) return b.score > a.score ? b : a;
  if (b.coverage !== a.coverage) return b.coverage > a.coverage ? b : a;
  return b.km < a.km ? b : a;
}

function buildCandidate(graph, target, generator) {
  const centers = generator.searchPlacements ? MANHATTAN_PLACEMENT_CENTERS : [target.center];
  let best = null;
  for (const center of centers) {
    best = betterCandidate(best, buildCandidateAtCenter(graph, target, generator, center));
  }
  best.placementsTried = centers.length;
  return best;
}

function makeGenerators(target) {
  const semantic = {
    id: "semantic",
    label: "Semantic primitive",
    local: densifyLocal(target.local, 120),
    pinM: 190,
  };
  const block = {
    id: "block",
    label: "Block-scale matcher",
    local: quantizeLocal(target.local, 274, 80),
    pinM: 170,
    searchPlacements: true,
  };
  const inverse = {
    id: "inverse",
    label: "Inverse nearest-street",
    local: densifyLocal(target.local, 80),
    pinM: 260,
    searchPlacements: true,
  };
  return [semantic, block, inverse];
}

function boundsOf(lines) {
  const all = lines.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const pad = 220;
  return {
    minX: Math.min(...xs) - pad,
    maxX: Math.max(...xs) + pad,
    minY: Math.min(...ys) - pad,
    maxY: Math.max(...ys) + pad,
  };
}

function pathD(points, project) {
  if (points.length < 2) return "";
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

async function rasterizeLocalPath(points, bounds, strokeWidth = 12, size = 320) {
  const scale = Math.min((size - 24) / (bounds.maxX - bounds.minX || 1), (size - 24) / (bounds.maxY - bounds.minY || 1));
  const project = ([x, y]) => [12 + (x - bounds.minX) * scale, size - 12 - (y - bounds.minY) * scale];
  const d = pathD(points, project);
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="#000" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(size * size);
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) mask[p] = data[i + 3] > 24 ? 1 : 0;
  return mask;
}

async function scoreVisualMatch(targetLocal, routeLocal) {
  const bounds = boundsOf([targetLocal, routeLocal]);
  const [targetMask, routeMask] = await Promise.all([
    rasterizeLocalPath(targetLocal, bounds, 14),
    rasterizeLocalPath(routeLocal, bounds, 12),
  ]);
  let targetInk = 0;
  let routeInk = 0;
  let hit = 0;
  for (let i = 0; i < targetMask.length; i++) {
    if (targetMask[i]) targetInk++;
    if (routeMask[i]) routeInk++;
    if (targetMask[i] && routeMask[i]) hit++;
  }
  const visualCoverage = targetInk ? hit / targetInk : 0;
  const visualPrecision = routeInk ? hit / routeInk : 0;
  const f1 = visualCoverage + visualPrecision > 0 ? (2 * visualCoverage * visualPrecision) / (visualCoverage + visualPrecision) : 0;
  const visualScore = Math.round(f1 * 100);
  return {
    visualScore,
    visualCoverage: Number((visualCoverage * 100).toFixed(1)),
    visualPrecision: Number((visualPrecision * 100).toFixed(1)),
    visualPass: visualScore >= 62 && visualCoverage >= 0.55 && visualPrecision >= 0.55,
  };
}

async function attachVisualScores(target, candidates) {
  for (const candidate of candidates) {
    Object.assign(candidate, await scoreVisualMatch(target.local, candidate.routeLocal));
  }
}

function compareCandidates(a, b) {
  if (a.visualPass !== b.visualPass) return a.visualPass ? -1 : 1;
  if (b.visualScore !== a.visualScore) return b.visualScore - a.visualScore;
  if (b.score !== a.score) return b.score - a.score;
  return a.km - b.km;
}
function renderPanel(target, candidate, w = 720, h = 520) {
  const b = boundsOf([target.local, candidate.routeLocal, candidate.intendedLocal]);
  const scale = Math.min((w - 64) / (b.maxX - b.minX), (h - 92) / (b.maxY - b.minY));
  const project = ([x, y]) => [32 + (x - b.minX) * scale, h - 34 - (y - b.minY) * scale];
  const targetD = pathD(target.local, project);
  const intendedD = pathD(candidate.intendedLocal, project);
  const routeD = pathD(candidate.routeLocal, project);
  return `
    <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#fbfbf8"/>
      <path d="${targetD}" fill="none" stroke="#111827" stroke-width="8" stroke-opacity="0.18" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${intendedD}" fill="none" stroke="#2563eb" stroke-width="3.2" stroke-opacity="0.45" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${routeD}" fill="none" stroke="#dc2626" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="0" y="0" width="${w}" height="72" fill="rgba(255,255,255,0.94)"/>
      <text x="18" y="24" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#111827">${esc(candidate.label)} - ${candidate.visualPass ? "VISUAL PASS" : "VISUAL FAIL"} - visual ${candidate.visualScore}</text>
      <text x="18" y="48" font-family="Arial, sans-serif" font-size="14" fill="#4b5563">${candidate.km} km - geom ${candidate.score} - visual cov ${candidate.visualCoverage}% - visual prec ${candidate.visualPrecision}% - pins ${candidate.pins} - placements ${candidate.placementsTried}</text>
      <text x="18" y="66" font-family="Arial, sans-serif" font-size="12" fill="#6b7280">gray target - blue generator input - red routed streets</text>
    </svg>`;
}

async function writeSheet(targetId, target, candidates, outDir) {
  const panelW = 720;
  const panelH = 520;
  const gap = 18;
  const pad = 24;
  const headerH = 92;
  const comps = [];
  const sourceText = target.source?.kind === "image"
    ? `${target.source.file} - ${target.source.mode} trace, ${target.source.points} pts, ${target.source.components} components, threshold ${target.source.threshold}`
    : "synthetic benchmark target";
  const header = Buffer.from(`
    <svg width="${pad * 2 + panelW * 3 + gap * 2}" height="${headerH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#111827"/>
      <text x="24" y="32" font-family="Arial, sans-serif" font-size="25" font-weight="700" fill="#fff">Route-art tournament prototype: ${esc(target.label)}</text>
      <text x="24" y="58" font-family="Arial, sans-serif" font-size="15" fill="#d1d5db">Three lanes compete on the same target. Offline Manhattan lattice, no Mapbox calls.</text>
      <text x="24" y="80" font-family="Arial, sans-serif" font-size="13" fill="#9ca3af">Source: ${esc(sourceText)}</text>
    </svg>`);
  comps.push({ input: header, left: 0, top: 0 });
  for (let i = 0; i < candidates.length; i++) {
    const svg = renderPanel(target, candidates[i], panelW, panelH);
    const img = await sharp(Buffer.from(svg)).png().toBuffer();
    comps.push({ input: img, left: pad + i * (panelW + gap), top: headerH + pad });
  }
  const sheet = path.join(outDir, "SHEET.png");
  await sharp({
    create: {
      width: pad * 2 + panelW * 3 + gap * 2,
      height: headerH + pad * 2 + panelH,
      channels: 4,
      background: "#e5e7eb",
    },
  }).composite(comps).png().toFile(sheet);
  return sheet;
}

async function runTarget(targetId, options = {}) {
  const target = await loadTarget(targetId, options);
  const graph = loadGraph();
  const outDir = path.join(OUT_ROOT, targetId);
  fs.mkdirSync(outDir, { recursive: true });
  const candidates = makeGenerators(target)
    .map((generator) => buildCandidate(graph, target, generator));
  await attachVisualScores(target, candidates);
  candidates.sort(compareCandidates);
  const sheet = await writeSheet(targetId, target, candidates, outDir);
  const summary = {
    target: targetId,
    label: target.label,
    targetLengthKmAtScale: Number((pathLengthLocal(target.local) / 1000).toFixed(2)),
    source: target.source,
    generatedAt: new Date().toISOString(),
    sheet: path.relative(ROOT, sheet).replace(/\\/g, "/"),
    candidates: candidates.map((c) => ({
      id: c.id,
      label: c.label,
      score: c.score,
      km: c.km,
      coverage: c.coverage,
      precision: c.precision,
      meanTargetErrorM: c.meanTargetErrorM,
      meanExtraErrorM: c.meanExtraErrorM,
      visualScore: c.visualScore,
      visualCoverage: c.visualCoverage,
      visualPrecision: c.visualPrecision,
      visualPass: c.visualPass,
      pins: c.pins,
      legs: c.legs,
      skipped: c.skipped,
      points: c.chain.length,
      placementsTried: c.placementsTried,
      placementCenter: c.placementCenter,
    })),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  const targetArg = (process.argv[2] ?? "love").toLowerCase();
  const options = { synthetic: process.argv.includes("--synthetic") };
  const ids = targetArg === "all" ? Object.keys(TARGET_SPECS) : [targetArg];
  const summaries = [];
  for (const id of ids) summaries.push(await runTarget(id, options));
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(OUT_ROOT, "summary.json"), JSON.stringify(summaries, null, 2));
  for (const summary of summaries) {
    console.log(`${summary.label}: ${summary.sheet}`);
    for (const c of summary.candidates) {
      console.log(`  ${c.id.padEnd(8)} score=${String(c.score).padStart(3)} km=${String(c.km).padStart(5)} coverage=${c.coverage}% precision=${c.precision}% skipped=${c.skipped}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});














