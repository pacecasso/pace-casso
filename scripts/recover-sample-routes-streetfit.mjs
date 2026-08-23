#!/usr/bin/env node
/*
 * Recover sample screenshots by fitting their extracted route drawings to real
 * streets, then point-snapping to the nearest street segment.
 *
 * This implements the map-fit idea directly: keep the drawing fixed, search
 * placements/scales/rotations where the most target points already lie close
 * to the street graph, and only then snap each point to the nearest street.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url, { fsCache: false });
const { buildGraph, nearestNode, corridorPath, meters } = jiti("./trace-contour.ts");
const { routeToGpx, routeToGeoJSONFeatureCollection } = jiti("../lib/routeExport.ts");

const ROOT = process.cwd();
const IN_ROOT = path.join(ROOT, "tmp-sample-replication");
const OUT_ROOT = path.join(ROOT, "tmp-sample-recovered-streetfit");
const M_PER_LAT = 111_320;

const CONFIGS = [
  { id: "lion", targetKm: 22.0, rotations: [-24, -12, 0, 12, 24], widthFactors: [0.75, 0.95, 1.15, 1.4] },
  { id: "tiger", targetKm: 21.0, rotations: [-24, -12, 0, 12, 24], widthFactors: [0.85, 1.05, 1.3, 1.6] },
  { id: "witch", targetKm: 23.7, rotations: [-35, -18, 0, 18, 35], widthFactors: [0.9, 1.1, 1.35, 1.65] },
  { id: "love", targetKm: 23.7, rotations: [-24, -12, 0, 12, 24], widthFactors: [0.75, 0.95, 1.2, 1.45] },
  { id: "heart", targetKm: 27.0, rotations: [-24, -12, 0, 12, 24], widthFactors: [0.8, 1.0, 1.25, 1.55] },
  { id: "puma", targetKm: 18.1, rotations: [-18, -8, 0, 8, 18], widthFactors: [0.85, 1.05, 1.3, 1.6] },
  { id: "unicorn", targetKm: 21.1, rotations: [-24, -12, 0, 12, 24], widthFactors: [0.85, 1.05, 1.3, 1.6] },
];
const CENTER_LATLNGS = [
  [40.728, -73.999],
  [40.741, -73.992],
  [40.752, -73.989],
  [40.760, -73.981],
  [40.716, -74.006],
  [40.705, -74.010],
  [40.775, -73.967],
  [40.710, -73.986],
  [40.744, -74.006],
  [40.725, -73.958],
  [40.755, -73.965],
  [40.735, -73.975],
];

function mPerLng(lat) {
  return M_PER_LAT * Math.cos((lat * Math.PI) / 180);
}

function setProjection(bounds) {
  const lat0 = (bounds.s + bounds.n) / 2;
  const lng0 = (bounds.w + bounds.e) / 2;
  return { lat0, lng0, mLng: mPerLng(lat0) };
}

function latLngToLocal([lat, lng], proj) {
  return [(lng - proj.lng0) * proj.mLng, (lat - proj.lat0) * M_PER_LAT];
}

function localToLatLng([x, y], proj) {
  return [proj.lat0 + y / M_PER_LAT, proj.lng0 + x / proj.mLng];
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function pathLength(points) {
  let out = 0;
  for (let i = 1; i < points.length; i++) out += dist(points[i - 1], points[i]);
  return out;
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

function normalizeInput(points) {
  const b = bounds(points);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return points.map(([x, y]) => [x - cx, y - cy]);
}

function rotateScale([x, y], scale, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [scale * (x * c - y * s), scale * (x * s + y * c)];
}

function transformed(points, center, scale, rot) {
  return points.map((p) => {
    const q = rotateScale(p, scale, rot);
    return [center[0] + q[0], center[1] + q[1]];
  });
}

function buildStreetSegments(osm, proj) {
  const segs = [];
  const seen = new Set();
  for (const [from, edges] of osm.adj.entries()) {
    const aLL = osm.coord.get(from);
    if (!aLL) continue;
    const a = latLngToLocal(aLL, proj);
    for (const edge of edges) {
      const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bLL = osm.coord.get(edge.to);
      if (!bLL) continue;
      const b = latLngToLocal(bLL, proj);
      if (dist(a, b) < 3) continue;
      segs.push({ a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
    }
  }
  return segs;
}

function segmentGrid(segs, cell = 180) {
  const grid = new Map();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (let gx = Math.floor(s.minX / cell); gx <= Math.floor(s.maxX / cell); gx++) {
      for (let gy = Math.floor(s.minY / cell); gy <= Math.floor(s.maxY / cell); gy++) {
        const key = `${gx}:${gy}`;
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(i);
      }
    }
  }
  return { grid, cell };
}

function pointToSegment(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 0) return { d: dist(p, a), q: a };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const q = [a[0] + vx * t, a[1] + vy * t];
  return { d: dist(p, q), q };
}

function nearestStreet(p, segs, index, radius = 230) {
  const gx = Math.floor(p[0] / index.cell);
  const gy = Math.floor(p[1] / index.cell);
  const cr = Math.ceil(radius / index.cell) + 1;
  const seen = new Set();
  let best = { d: Infinity, q: null };
  for (let dx = -cr; dx <= cr; dx++) {
    for (let dy = -cr; dy <= cr; dy++) {
      for (const si of index.grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
        if (seen.has(si)) continue;
        seen.add(si);
        const s = segs[si];
        if (p[0] < s.minX - radius || p[0] > s.maxX + radius || p[1] < s.minY - radius || p[1] > s.maxY + radius) continue;
        const hit = pointToSegment(p, s.a, s.b);
        if (hit.d < best.d) best = hit;
      }
    }
  }
  return best;
}

function candidateCenters(osm, proj) {
  const cells = new Map();
  for (const id of osm.adj.keys()) {
    const p = latLngToLocal(osm.coord.get(id), proj);
    const key = `${Math.round(p[0] / 450)}:${Math.round(p[1] / 450)}`;
    const cur = cells.get(key) ?? { sx: 0, sy: 0, count: 0 };
    cur.sx += p[0];
    cur.sy += p[1];
    cur.count++;
    cells.set(key, cur);
  }
  return [...cells.values()].filter((c) => c.count >= 8).map((c) => [c.sx / c.count, c.sy / c.count]);
}

function fitScore(target, segs, index) {
  let sum = 0;
  let near = 0;
  let miss = 0;
  let max = 0;
  for (const p of target) {
    const hit = nearestStreet(p, segs, index, 260);
    const d = Number.isFinite(hit.d) ? hit.d : 400;
    sum += Math.min(400, d);
    max = Math.max(max, d);
    if (d <= 35) near++;
    if (d > 130) miss++;
  }
  return { score: sum / target.length + miss * 5 - (near / target.length) * 32, mean: sum / target.length, max, coverage: near / target.length, miss };
}

function snapTarget(target, segs, index) {
  return target.map((p) => {
    const hit = nearestStreet(p, segs, index, 350);
    return hit.q ?? p;
  });
}

function routeKmLatLng(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += meters(points[i - 1], points[i]);
  return total / 1000;
}

function connectLargeJumps(osm, points, thresholdMeters = 160) {
  if (points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const next = points[i];
    if (meters(prev, next) <= thresholdMeters) {
      out.push(next);
      continue;
    }
    const a = nearestNode(osm, prev);
    const b = nearestNode(osm, next);
    let ids = null;
    if (a >= 0 && b >= 0 && a !== b) {
      ids = corridorPath(osm, a, b, [prev, next], 8, 260) || corridorPath(osm, a, b, [prev, next], 0, 1e7);
    }
    if (ids?.length) {
      for (const id of ids) {
        const p = osm.coord.get(id);
        if (p && meters(out[out.length - 1], p) > 1) out.push(p);
      }
    } else {
      out.push(next);
    }
  }
  return out;
}

function jumpStats(points) {
  let max = 0;
  let jumps = 0;
  for (let i = 1; i < points.length; i++) {
    const d = meters(points[i - 1], points[i]);
    max = Math.max(max, d);
    if (d > 160) jumps++;
  }
  return { maxJumpMeters: max, jumpsOver160m: jumps };
}

function pathD(points, project) {
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function escapeXml(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

async function renderPreview(target, snapped, segs, file, title, meta) {
  const all = [...target, ...snapped];
  const b = bounds(all);
  const pad = 280;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const w = 1100;
  const h = 820;
  const scale = Math.min((w - 80) / Math.max(1, view.maxX - view.minX), (h - 120) / Math.max(1, view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale;
  const usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2;
  const oy = 84 + (h - 120 - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = (s) => !(s.maxX < view.minX || s.minX > view.maxX || s.maxY < view.minY || s.minY > view.maxY);
  const streetSvg = [];
  for (const s of segs) {
    if (!inView(s)) continue;
    streetSvg.push(`<path d="${pathD([s.a, s.b], project)}" fill="none" stroke="#d8d8d2" stroke-width="1.2"/>`);
    if (streetSvg.length > 9000) break;
  }
  const targetD = pathD(target, project);
  const snapD = pathD(snapped, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#f4f2ea"/>
    <rect x="24" y="72" width="${w - 48}" height="${h - 96}" fill="#fff"/>
    <text x="24" y="34" font-family="Arial" font-size="24" font-weight="700" fill="#111827">${escapeXml(title)}</text>
    <text x="24" y="58" font-family="Arial" font-size="14" fill="#4b5563">${escapeXml(meta)}</text>
    ${streetSvg.join("\n")}
    <path d="${targetD}" fill="none" stroke="#2563eb" stroke-width="3" stroke-opacity="0.28" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${snapD}" fill="none" stroke="#7f1d1d" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${snapD}" fill="none" stroke="#ef2727" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function compileSample(cfg, osm, proj, segs, index, centers) {
  const dir = path.join(OUT_ROOT, cfg.id);
  await fs.mkdir(dir, { recursive: true });
  const raw = JSON.parse(await fs.readFile(path.join(IN_ROOT, cfg.id, "route-normalized.json"), "utf8"));
  const normalized = normalizeInput(raw);
  const samples = simplifyByDistance(normalized, 48);
  const baseScale = (cfg.targetKm * 1000) / Math.max(1, pathLength(normalized));
  let best = null;
  for (const factor of cfg.widthFactors) {
    const scale = baseScale * factor;
    for (const rot of cfg.rotations) {
      for (const center of centers) {
        const target = transformed(samples, center, scale, rot);
        const fit = fitScore(target, segs, index);
        const score = fit.score + Math.abs(factor - 1) * 4;
        if (!best || score < best.score) best = { score, fit, center, scale, rot, factor };
      }
    }
  }
  const targetDense = transformed(normalized, best.center, best.scale, best.rot);
  const targetRoute = simplifyByDistance(targetDense, 8);
  const snapped = snapTarget(targetRoute, segs, index);
  const snappedLL = snapped.map((p) => localToLatLng(p, proj));
  const connectedLL = connectLargeJumps(osm, snappedLL);
  const connectedLocal = connectedLL.map((p) => latLngToLocal(p, proj));
  const km = routeKmLatLng(connectedLL);
  const jumps = jumpStats(connectedLL);
  const route = { coordinates: connectedLL, blockWaypoints: connectedLL, distanceMeters: km * 1000 };
  const artworkMatchScore = Math.max(0, Math.min(100, 100 - best.fit.mean * 0.8 - jumps.jumpsOver160m * 1.5));
  await fs.writeFile(path.join(dir, `${cfg.id}.gpx`), routeToGpx(route, [], undefined, { artworkMatchScore }), "utf8");
  await fs.writeFile(path.join(dir, `${cfg.id}.geojson`), JSON.stringify(routeToGeoJSONFeatureCollection(route, [], { artworkMatchScore }), null, 2), "utf8");
  await fs.writeFile(path.join(dir, "route.json"), JSON.stringify({
    id: cfg.id,
    km,
    fit: best.fit,
    center: localToLatLng(best.center, proj),
    scale: best.scale,
    rotation: best.rot,
    factor: best.factor,
    points: connectedLL.length,
    ...jumps,
  }, null, 2), "utf8");
  await renderPreview(
    targetRoute,
    connectedLocal,
    segs,
    path.join(dir, "PREVIEW.png"),
    `${cfg.id} recovered street-fit`,
    `${km.toFixed(2)} km, fit ${best.fit.mean.toFixed(0)} m, coverage ${(best.fit.coverage * 100).toFixed(0)}%, jumps ${jumps.jumpsOver160m}`,
  );
  return {
    id: cfg.id,
    ok: true,
    km: Number(km.toFixed(2)),
    meanStreetFitMeters: Number(best.fit.mean.toFixed(1)),
    coverage: Number(best.fit.coverage.toFixed(3)),
    maxJumpMeters: Number(jumps.maxJumpMeters.toFixed(1)),
    jumpsOver160m: jumps.jumpsOver160m,
    rotation: best.rot,
    center: localToLatLng(best.center, proj).map((n) => Number(n.toFixed(6))),
    preview: path.relative(ROOT, path.join(dir, "PREVIEW.png")).replace(/\\/g, "/"),
    gpx: path.relative(ROOT, path.join(dir, `${cfg.id}.gpx`)).replace(/\\/g, "/"),
    geojson: path.relative(ROOT, path.join(dir, `${cfg.id}.geojson`)).replace(/\\/g, "/"),
  };
}

async function writeSheet(results) {
  const cellW = 560;
  const cellH = 430;
  const cols = 2;
  const rows = Math.ceil(results.length / cols);
  const comps = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const img = await sharp(path.join(ROOT, r.preview)).resize(cellW, cellH, { fit: "contain", background: "#fff" }).png().toBuffer();
    comps.push({ input: img, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH });
  }
  await sharp({ create: { width: cellW * cols, height: cellH * rows, channels: 4, background: "#e5e7eb" } })
    .composite(comps)
    .png()
    .toFile(path.join(OUT_ROOT, "SHEET.png"));
}

async function main() {
  await fs.mkdir(OUT_ROOT, { recursive: true });
  console.log("[streetfit] loading full OSM graph");
  const osm = await buildGraph();
  let s = 90, n = -90, w = 180, e = -180;
  for (const id of osm.adj.keys()) {
    const [lat, lng] = osm.coord.get(id);
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
  }
  const proj = setProjection({ s, w, n, e });
  const segs = buildStreetSegments(osm, proj);
  const index = segmentGrid(segs);
  const centers = CENTER_LATLNGS.map((p) => latLngToLocal(p, proj));
  console.log(`[streetfit] graph ${osm.adj.size} nodes, ${segs.length} street segments, ${centers.length} curated centers`);
  const results = [];
  for (const cfg of CONFIGS) {
    console.log(`[streetfit] fitting ${cfg.id}`);
    results.push(await compileSample(cfg, osm, proj, segs, index, centers));
  }
  await writeSheet(results);
  await fs.writeFile(path.join(OUT_ROOT, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(path.relative(ROOT, OUT_ROOT));
  for (const r of results) console.log(`${r.id.padEnd(8)} ${String(r.km).padStart(5)} km fit=${String(r.meanStreetFitMeters).padStart(5)}m coverage=${Math.round(r.coverage * 100)}% jumps=${r.jumpsOver160m}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});




