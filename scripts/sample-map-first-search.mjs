import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);

const {
  buildLatticeGraph,
  compileContourToLattice,
  haversineMeters,
} = jiti("../lib/latticeCompiler.ts");
const {
  prepareTracedBinaryComponents,
  centerlinePolylineFromPreparedBinary,
} = jiti("../lib/centerlineFromMask.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-sample-map-first", stamp);

const M_PER_LAT = 111320;
const BASE = [40.744061, -74.006811];
const X_AXIS = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y_AXIS = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };

const idx = (x, y, w) => y * w + x;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function routePixel(r, g, b) {
  const red = r >= 145 && r - g >= 38 && r - b >= 30;
  const brightOrange = r >= 185 && g >= 50 && g <= 165 && b <= 135 && r - g >= 34;
  const compressedStravaOrange =
    r >= 138 && g >= 78 && g <= 190 && b >= 55 && b <= 178 &&
    r - g >= 18 && g - b >= 4 && r - b >= 36;
  const magentaRed = r >= 150 && g <= 95 && b <= 150 && r > b + 8;
  return red || brightOrange || compressedStravaOrange || magentaRed;
}

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function neighbors8(x, y, w, h) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push([nx, ny]);
    }
  }
  return out;
}

function components(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = idx(x, y, w);
      if (!mask[start] || seen[start]) continue;
      const stack = [[x, y]];
      const pixels = [];
      seen[start] = 1;
      let minX = x, minY = y, maxX = x, maxY = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        pixels.push([cx, cy]);
        minX = Math.min(minX, cx); minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
        for (const [nx, ny] of neighbors8(cx, cy, w, h)) {
          const ni = idx(nx, ny, w);
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      comps.push({ pixels, count: pixels.length, bbox: { minX, minY, maxX, maxY } });
    }
  }
  return comps.sort((a, b) => b.count - a.count);
}

function chooseSneakerComponents(comps, h) {
  const routeComps = comps.filter((c) => {
    const bw = c.bbox.maxX - c.bbox.minX + 1;
    const bh = c.bbox.maxY - c.bbox.minY + 1;
    const yMid = (c.bbox.minY + c.bbox.maxY) / 2;
    if (yMid < h * 0.42) return false;
    if (c.count < 80) return false;
    if (Math.max(bw, bh) < 25) return false;
    return true;
  });
  const biggest = routeComps[0]?.count ?? 0;
  return routeComps.filter((c) => c.count >= Math.max(80, biggest * 0.06)).slice(0, 6);
}

function simplifyByDistance(points, minDist) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || dist(last, p) >= minDist) {
      out.push(p);
      last = p;
    }
  }
  const tail = points[points.length - 1];
  if (tail && out.length && dist(out[out.length - 1], tail) > 0.01) out.push(tail);
  return out;
}

function stitchStrokes(strokes) {
  const remaining = strokes.map((s) => s.slice());
  const first = remaining.shift() ?? [];
  const out = first.slice();
  while (remaining.length && out.length) {
    const last = out[out.length - 1];
    let bestIndex = 0, reverse = false, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const stroke = remaining[i];
      const da = dist(last, stroke[0]);
      const db = dist(last, stroke[stroke.length - 1]);
      if (da < bestDist) { bestDist = da; bestIndex = i; reverse = false; }
      if (db < bestDist) { bestDist = db; bestIndex = i; reverse = true; }
    }
    const next = remaining.splice(bestIndex, 1)[0];
    if (reverse) next.reverse();
    out.push(...next);
  }
  return out;
}

function localToLatLng([x, y]) {
  const e = x * X_AXIS.e + y * Y_AXIS.e;
  const n = x * X_AXIS.n + y * Y_AXIS.n;
  const mPerLng = M_PER_LAT * Math.cos((BASE[0] * Math.PI) / 180);
  return [BASE[0] + n / M_PER_LAT, BASE[1] + e / mPerLng];
}

function latLngToLocal([lat, lng]) {
  const mPerLng = M_PER_LAT * Math.cos((BASE[0] * Math.PI) / 180);
  const n = (lat - BASE[0]) * M_PER_LAT;
  const e = (lng - BASE[1]) * mPerLng;
  const det = X_AXIS.e * Y_AXIS.n - Y_AXIS.e * X_AXIS.n;
  return [(e * Y_AXIS.n - Y_AXIS.e * n) / det, (X_AXIS.e * n - e * X_AXIS.n) / det];
}

async function renderPath(points, file, color = "#111") {
  const b = bounds(points);
  const w = 1100, h = 820, pad = 50;
  const scale = Math.min((w - pad * 2) / (b.maxX - b.minX || 1), (h - pad * 2) / (b.maxY - b.minY || 1));
  const usedW = (b.maxX - b.minX) * scale;
  const usedH = (b.maxY - b.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - b.minX) * scale, oy + (y - b.minY) * scale];
  const d = points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function extractSneakerReference() {
  const source = path.join(root, "sneaker.jpg");
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const fullMask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (routePixel(data[i], data[i + 1], data[i + 2])) fullMask[idx(x, y, info.width)] = 1;
    }
  }
  const kept = chooseSneakerComponents(components(fullMask, info.width, info.height), info.height);
  const all = kept.flatMap((c) => c.pixels);
  const b = bounds(all);
  const pad = 8;
  const crop = {
    minX: Math.max(0, b.minX - pad),
    minY: Math.max(0, b.minY - pad),
    maxX: Math.min(info.width - 1, b.maxX + pad),
    maxY: Math.min(info.height - 1, b.maxY + pad),
  };
  const cw = crop.maxX - crop.minX + 1;
  const ch = crop.maxY - crop.minY + 1;
  const lineMask = new Uint8Array(cw * ch);
  for (const c of kept) {
    for (const [x, y] of c.pixels) lineMask[idx(x - crop.minX, y - crop.minY, cw)] = 255;
  }
  const prepared = prepareTracedBinaryComponents(lineMask, cw, ch, 6, 20);
  const strokes = prepared
    .map((comp) => centerlinePolylineFromPreparedBinary(comp, cw, ch))
    .filter((s) => s.length >= 3)
    .sort((a, b2) => b2.length - a.length)
    .slice(0, 6)
    .map((s) => simplifyByDistance(s, 2.2));
  const route = simplifyByDistance(stitchStrokes(strokes), 3.2);
  await renderPath(route, path.join(outDir, "1-reference-centerline.png"));
  return normalizeDesign(route, strokes, { crop, source: "sneaker.jpg" });
}

function normalizeDesign(route, strokes, meta) {
  const b = bounds(strokes.flat());
  const w = b.maxX - b.minX || 1;
  const h = b.maxY - b.minY || 1;
  const norm = ([x, y]) => [(x - b.minX) / w, (y - b.minY) / h];
  return {
    route: route.map(norm),
    features: strokes.map((stroke) => stroke.map(norm)),
    aspect: w / h,
    meta,
  };
}

function transformDesign(design, rotateDeg, mirrorX) {
  const all = design.features.flat();
  const cx = 0.5, cy = 0.5;
  const a = (rotateDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const mapPoint = ([x0, y0]) => {
    const x = (mirrorX ? 1 - x0 : x0) - cx;
    const y = y0 - cy;
    return [x * ca - y * sa, x * sa + y * ca];
  };
  const rawFeatures = design.features.map((s) => s.map(mapPoint));
  const rawRoute = design.route.map(mapPoint);
  const b = bounds(rawFeatures.flat());
  const w = b.maxX - b.minX || 1;
  const h = b.maxY - b.minY || 1;
  const norm = ([x, y]) => [(x - b.minX) / w, (y - b.minY) / h];
  return {
    route: rawRoute.map(norm),
    features: rawFeatures.map((s) => s.map(norm)),
    heightRatio: h / w,
  };
}

function place(points, center, widthM, heightRatio) {
  const heightM = widthM * heightRatio;
  return points.map(([u, v]) => [center[0] + (u - 0.5) * widthM, center[1] + (v - 0.5) * heightM]);
}

function buildStreetSegments(graph) {
  const seen = new Set();
  const segs = [];
  for (const [from, entries] of graph.adj.entries()) {
    for (const edge of entries) {
      const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(latLngToLocal);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (dist(a, b) < 1) continue;
        segs.push({ a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
      }
    }
  }
  return segs;
}

function segmentGrid(segs, cell = 210) {
  const grid = new Map();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (let gx = Math.floor(s.minX / cell); gx <= Math.floor(s.maxX / cell); gx++) {
      for (let gy = Math.floor(s.minY / cell); gy <= Math.floor(s.maxY / cell); gy++) {
        const key = `${gx}:${gy}`;
        const arr = grid.get(key);
        if (arr) arr.push(i);
        else grid.set(key, [i]);
      }
    }
  }
  return { grid, cell };
}

function pointToSegment(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 0) return { d: dist(p, a), vx: 0, vy: 0 };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const q = [a[0] + vx * t, a[1] + vy * t];
  return { d: dist(p, q), vx, vy };
}

function nearestStreet(p, tangent, segs, index, radius = 230) {
  const gx = Math.floor(p[0] / index.cell), gy = Math.floor(p[1] / index.cell);
  const cr = Math.ceil(radius / index.cell) + 1;
  const seen = new Set();
  let best = { d: Infinity, align: 0, si: -1 };
  for (let dx = -cr; dx <= cr; dx++) {
    for (let dy = -cr; dy <= cr; dy++) {
      for (const si of index.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
        if (seen.has(si)) continue;
        seen.add(si);
        const s = segs[si];
        if (p[0] < s.minX - radius || p[0] > s.maxX + radius || p[1] < s.minY - radius || p[1] > s.maxY + radius) continue;
        const hit = pointToSegment(p, s.a, s.b);
        if (hit.d >= best.d) continue;
        const sl = Math.hypot(hit.vx, hit.vy) || 1;
        const tl = Math.hypot(tangent[0], tangent[1]) || 1;
        const align = Math.abs((hit.vx / sl) * (tangent[0] / tl) + (hit.vy / sl) * (tangent[1] / tl));
        best = { d: hit.d, align, si };
      }
    }
  }
  return best;
}

function sampleStroke(stroke, maxUnitStep = 0.032) {
  const out = [];
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1], b = stroke[i];
    const d = dist(a, b);
    const steps = Math.max(1, Math.ceil(d / maxUnitStep));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({
        p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        tangent: [b[0] - a[0], b[1] - a[1]],
      });
    }
  }
  return out;
}

function fabricScore(transformed, center, widthM, segs, index) {
  const samples = transformed.features.flatMap((stroke) => sampleStroke(stroke));
  let total = 0, missed = 0, close = 0, aligned = 0;
  for (const sample of samples) {
    const p = place([sample.p], center, widthM, transformed.heightRatio)[0];
    const tangent = [sample.tangent[0] * widthM, sample.tangent[1] * widthM * transformed.heightRatio];
    const hit = nearestStreet(p, tangent, segs, index, 230);
    if (!Number.isFinite(hit.d) || hit.d > 180) {
      missed++;
      total += 260;
      continue;
    }
    if (hit.d < 55) close++;
    if (hit.align > 0.78) aligned++;
    total += hit.d + (1 - hit.align) * 65;
  }
  const n = Math.max(1, samples.length);
  const coverage = close / n;
  const alignment = aligned / n;
  return {
    score: total / n + missed * 10 - coverage * 22 - alignment * 12,
    missed,
    coverage,
    alignment,
    sampleCount: samples.length,
  };
}

function candidateCenters(graph) {
  const cells = new Map();
  for (const node of graph.nodes) {
    const p = latLngToLocal(node);
    const key = `${Math.round(p[0] / 380)}:${Math.round(p[1] / 380)}`;
    const cur = cells.get(key) ?? { sx: 0, sy: 0, count: 0 };
    cur.sx += p[0]; cur.sy += p[1]; cur.count++;
    cells.set(key, cur);
  }
  return [...cells.values()].filter((c) => c.count >= 3).map((c) => [c.sx / c.count, c.sy / c.count]);
}

function routeD(chain, project) {
  return chain.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}


function fabricSupportSegments(transformed, center, widthM, segs, index) {
  const selected = new Set();
  const placedPoints = [];
  for (const stroke of transformed.features) {
    for (const sample of sampleStroke(stroke, 0.024)) {
      const p = place([sample.p], center, widthM, transformed.heightRatio)[0];
      placedPoints.push(p);
      const tangent = [sample.tangent[0] * widthM, sample.tangent[1] * widthM * transformed.heightRatio];
      const hit = nearestStreet(p, tangent, segs, index, 230);
      if (hit.si >= 0 && hit.d < 80 && hit.align > 0.5) selected.add(hit.si);
    }
  }
  return { selected: [...selected], placedPoints };
}

async function renderFabricSupport(candidate, segs, graph, segIndex, file, label = "") {
  const support = fabricSupportSegments(candidate.transformed, candidate.center, candidate.widthM, segs, segIndex);
  const pts = support.placedPoints;
  const selectedSegs = support.selected.map((i) => segs[i]);
  const allPts = pts.concat(selectedSegs.flatMap((s) => [s.a, s.b]));
  const b = bounds(allPts);
  const pad = 280;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const w = 1100, h = 820;
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const streets = [];
  const seen = new Set();
  for (const [from, entries] of graph.adj.entries()) {
    for (const edge of entries) {
      const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(latLngToLocal);
      if (!line.some(inView)) continue;
      streets.push(`<path d="${routeD(line, project)}" fill="none" stroke="#dddddd" stroke-width="1.8"/>`);
    }
  }
  const supportPaths = selectedSegs.map((s) => `<path d="${routeD([s.a, s.b], project)}" fill="none" stroke="#ef1744" stroke-width="8" stroke-linecap="round"/>`);
  const targetPoints = pts.filter((_, i) => i % 4 === 0).map((p) => {
    const [x, y] = project(p);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6" fill="#111" opacity="0.35"/>`;
  });
  const text = label ? `<text x="32" y="46" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}${supportPaths.join("\n")}${targetPoints.join("\n")}${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
async function renderStreet(chain, graph, file, label = "") {
  const route = chain.map(latLngToLocal);
  const rb = bounds(route);
  const pad = 260;
  const view = { minX: rb.minX - pad, maxX: rb.maxX + pad, minY: rb.minY - pad, maxY: rb.maxY + pad };
  const w = 1100, h = 820;
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const streets = [];
  const seen = new Set();
  for (const [from, entries] of graph.adj.entries()) {
    for (const edge of entries) {
      const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(latLngToLocal);
      if (!pts.some(inView)) continue;
      streets.push(`<path d="${routeD(pts, project)}" fill="none" stroke="#d7d7d7" stroke-width="2"/>`);
    }
  }
  const rd = routeD(route, project);
  const text = label ? `<text x="32" y="46" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="#771225" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><path d="${rd}" fill="none" stroke="#ef1744" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso sample map-first search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

function runabilityStats(chain) {
  let maxHopMeters = 0, totalMeters = 0;
  for (let i = 1; i < chain.length; i++) {
    const d = haversineMeters(chain[i - 1], chain[i]);
    totalMeters += d;
    maxHopMeters = Math.max(maxHopMeters, d);
  }
  return { points: chain.length, totalKm: totalMeters / 1000, maxHopMeters };
}

async function makeContactSheet(items, file) {
  const tileW = 560, tileH = 430;
  const composites = [];
  for (let i = 0; i < items.length; i++) {
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${tileH}"><rect width="100%" height="100%" fill="#f7f4ee"/><text x="18" y="32" font-family="Arial" font-size="20" font-weight="700" fill="#111">${items[i].label}</text></svg>`);
    const img = await sharp(items[i].image).resize({ width: tileW - 28, height: tileH - 52, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    const left = (i % 2) * tileW;
    const top = Math.floor(i / 2) * tileH;
    composites.push({ input: label, left, top });
    composites.push({ input: img.data, left: left + Math.round((tileW - img.info.width) / 2), top: top + 44 + Math.round((tileH - 58 - img.info.height) / 2) });
  }
  await sharp({
    create: {
      width: tileW * 2,
      height: tileH * Math.ceil(items.length / 2),
      channels: 4,
      background: "#ece7dd",
    },
  }).composite(composites).png().toFile(file);
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(path.join(root, "sneaker.jpg"), path.join(outDir, "0-reference-sneaker.jpg"));
  const lattice = JSON.parse(await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8"));
  const graph = buildLatticeGraph(lattice);
  const design = await extractSneakerReference();
  const segs = buildStreetSegments(graph);
  const segIndex = segmentGrid(segs);
  let centers = candidateCenters(graph);
  if (process.env.FAST === "1" || process.env.FABRIC_ONLY === "1") centers = centers.filter((_, i) => i % 3 === 0);
  const rotations = process.env.FAST === "1" || process.env.FABRIC_ONLY === "1" ? [-6, 0, 6] : [-10, -6, -3, 0, 3, 6, 10];
  const widths = process.env.FAST === "1" || process.env.FABRIC_ONLY === "1" ? [2800, 4200, 5600] : [2200, 2800, 3400, 4200, 5200, 6400];
  const fabric = [];
  let scanCount = 0;
  for (const rotateDeg of rotations) {
    for (const mirrorX of [false, true]) {
      const transformed = transformDesign(design, rotateDeg, mirrorX);
      for (const center of centers) {
        for (const widthM of widths) {
          scanCount++;
          const f = fabricScore(transformed, center, widthM, segs, segIndex);
          const shapeAspect = 1 / transformed.heightRatio;
          const shapeAspectError = Math.abs(shapeAspect - design.aspect);
          const rankScore = f.score + shapeAspectError * 34;
          fabric.push({ ...f, rankScore, shapeAspect, shapeAspectError, rotateDeg, mirrorX, center, widthM, heightRatio: transformed.heightRatio, transformed });
        }
      }
    }
  }
  fabric.sort((a, b) => a.rankScore - b.rankScore);
  const fabricDir = path.join(outDir, "fabric-support");
  await fs.mkdir(fabricDir, { recursive: true });
  const fabricSheetItems = [];
  for (let i = 0; i < Math.min(8, fabric.length); i++) {
    const c = fabric[i];
    const file = path.join(fabricDir, `fabric-${String(i + 1).padStart(2, "0")}.png`);
    await renderFabricSupport(c, segs, graph, segIndex, file, `fabric ${i + 1} score ${c.rankScore.toFixed(1)}`);
    fabricSheetItems.push({ label: `fabric ${i + 1} score ${c.rankScore.toFixed(1)}`, image: file });
  }
  await makeContactSheet(fabricSheetItems, path.join(outDir, "fabric-support-sheet.png"));
  if (process.env.FABRIC_ONLY === "1") {
    await fs.writeFile(path.join(outDir, "fabric-summary.json"), JSON.stringify({ subject: "sneaker", scanCount, centers: centers.length, segmentCount: segs.length, design: { aspect: design.aspect, meta: design.meta }, top: fabric.slice(0, 8).map(({ transformed, ...rest }) => rest) }, null, 2));
    console.log(path.relative(root, outDir));
    return;
  }
  const compilePool = fabric.slice(0, 90);
  const compiled = [];
  let id = 0;
  for (const candidate of compilePool) {
    const placed = place(candidate.transformed.route, candidate.center, candidate.widthM, candidate.heightRatio).map(localToLatLng);
    for (const opts of [
      { sampleMeters: 24, pinRadiusMeters: 140, minPinSpacingMeters: 45, maxLegDetourRatio: 2.2, maxLegDetourSlackMeters: 180 },
      { sampleMeters: 32, pinRadiusMeters: 165, minPinSpacingMeters: 60, maxLegDetourRatio: 2.6, maxLegDetourSlackMeters: 230 },
    ]) {
      const result = compileContourToLattice(placed, graph, opts);
      if (!result || result.chain.length < 20) continue;
      const rb = bounds(result.chain.map(latLngToLocal));
      const aspect = (rb.maxX - rb.minX) / Math.max(1, rb.maxY - rb.minY);
      const stats = runabilityStats(result.chain);
      const score =
        candidate.rankScore +
        result.meanDeviationMeters * 0.72 +
        result.skippedPins * 220 +
        Math.abs(aspect - design.aspect) * 9 +
        Math.max(0, stats.maxHopMeters - 230) * 0.45;
      compiled.push({
        id: `samplefit-${String(++id).padStart(4, "0")}`,
        score,
        fabricScore: candidate.score,
        rotateDeg: candidate.rotateDeg,
        mirrorX: candidate.mirrorX,
        center: candidate.center,
        widthM: candidate.widthM,
        heightRatio: candidate.heightRatio,
        coverage: candidate.coverage,
        alignment: candidate.alignment,
        fabricMissed: candidate.missed,
        km: result.km,
        meanDeviationMeters: result.meanDeviationMeters,
        maxDeviationMeters: result.maxDeviationMeters,
        skippedPins: result.skippedPins,
        legCount: result.legCount,
        aspect,
        runability: stats,
        chain: result.chain,
      });
    }
  }
  compiled.sort((a, b) => a.score - b.score);
  const top = compiled.slice(0, 8);
  const summary = [];
  const sheetItems = [];
  for (const candidate of top) {
    const dir = path.join(outDir, candidate.id);
    await fs.mkdir(dir, { recursive: true });
    const blind = path.join(dir, "route-blind.png");
    const labeled = path.join(dir, "route-labeled.png");
    await renderStreet(candidate.chain, graph, blind);
    await renderStreet(candidate.chain, graph, labeled, `${candidate.id} ${candidate.km.toFixed(1)} km`);
    await fs.writeFile(path.join(dir, `${candidate.id}.gpx`), gpx(candidate.id, candidate.chain), "utf8");
    sheetItems.push({ label: `${candidate.id} score ${candidate.score.toFixed(1)} km ${candidate.km.toFixed(1)}`, image: blind });
    const clean = { ...candidate };
    delete clean.chain;
    summary.push({
      ...clean,
      blindImage: path.relative(root, blind).replace(/\\/g, "/"),
      labeledImage: path.relative(root, labeled).replace(/\\/g, "/"),
      gpx: path.relative(root, path.join(dir, `${candidate.id}.gpx`)).replace(/\\/g, "/"),
    });
  }
  await makeContactSheet(sheetItems, path.join(outDir, "candidate-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({
    subject: "sneaker",
    scanCount,
    centers: centers.length,
    segmentCount: segs.length,
    design: { aspect: design.aspect, meta: design.meta, routePoints: design.route.length, featureStrokes: design.features.map((s) => s.length) },
    top: summary,
  }, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
