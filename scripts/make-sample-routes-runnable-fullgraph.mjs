#!/usr/bin/env node
/*
 * Full-graph runnable sample compiler.
 *
 * This is the replacement for the failed coarse-lattice pass. It keeps the
 * extracted sample route as the visual target and routes through the full OSM
 * walk graph with a corridor penalty, so legal streets are chosen because they
 * hug the drawing instead of because they quantize to a block lattice.
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
const OUT_ROOT = path.join(ROOT, "tmp-sample-runnable-fullgraph");
const M_PER_LAT = 111_320;

const CONFIGS = [
  { id: "lion", targetKm: 22.0, widths: [1900, 2400, 3000], rotations: [-18, 0, 14] },
  { id: "tiger", targetKm: 21.0, widths: [2300, 3000, 3800], rotations: [-12, 0, 12] },
  { id: "witch", targetKm: 23.7, widths: [2400, 3200, 4100], rotations: [-25, 0, 18] },
  { id: "love", targetKm: 23.7, widths: [1800, 2400, 3200], rotations: [-12, 0, 12] },
  { id: "heart", targetKm: 27.0, widths: [2200, 2900, 3800], rotations: [-12, 0, 12] },
  { id: "puma", targetKm: 18.1, widths: [1700, 2300, 3000], rotations: [-12, 0, 12] },
  { id: "unicorn", targetKm: 21.1, widths: [2200, 3000, 3900], rotations: [-16, 0, 16] },
];

const CENTERS = [
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
];

const PARAMS = [
  { anchorM: 95, lambda: 7, corridorM: 140 },
  { anchorM: 125, lambda: 9, corridorM: 190 },
  { anchorM: 160, lambda: 11, corridorM: 250 },
];

function mPerLng(lat) {
  return M_PER_LAT * Math.cos((lat * Math.PI) / 180);
}

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function normalizeToMeters(points, widthM, rotateDeg) {
  const b = bounds(points);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const scale = widthM / Math.max(1, b.maxX - b.minX);
  const r = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return points.map(([x, y]) => {
    const px = (x - cx) * scale;
    const py = (y - cy) * scale;
    return [px * cos - py * sin, px * sin + py * cos];
  });
}

function localToLatLng(local, center) {
  return local.map(([x, y]) => [center[0] + y / M_PER_LAT, center[1] + x / mPerLng(center[0])]);
}

function latLngToLocal([lat, lng], center) {
  return [(lng - center[1]) * mPerLng(center[0]), (lat - center[0]) * M_PER_LAT];
}

function pathKm(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += meters(points[i - 1], points[i]);
  return m / 1000;
}

function simplifyLatLng(points, minMeters) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || meters(last, p) >= minMeters) {
      out.push(p);
      last = p;
    }
  }
  const tail = points[points.length - 1];
  if (tail && out.length && meters(out[out.length - 1], tail) > 1) out.push(tail);
  return out;
}

function dedupeChain(points) {
  const out = [];
  for (const p of points) {
    if (!out.length || meters(out[out.length - 1], p) > 1) out.push(p);
  }
  return out;
}

function routeThroughOsm(osm, target, params) {
  const anchors = simplifyLatLng(target, params.anchorM);
  const chain = [];
  let failed = 0;
  let detours = 0;
  let legs = 0;
  for (let i = 1; i < anchors.length; i++) {
    const a = nearestNode(osm, anchors[i - 1]);
    const b = nearestNode(osm, anchors[i]);
    if (a < 0 || b < 0 || a === b) continue;
    const direct = meters(anchors[i - 1], anchors[i]);
    const segmentTarget = [anchors[i - 1], anchors[i]];
    let ids = corridorPath(osm, a, b, segmentTarget, params.lambda, params.corridorM);
    if (!ids) ids = corridorPath(osm, a, b, segmentTarget, params.lambda, params.corridorM * 2.2);
    if (!ids) ids = corridorPath(osm, a, b, segmentTarget, 0, 1e7);
    if (!ids) {
      failed++;
      continue;
    }
    let len = 0;
    for (let k = 1; k < ids.length; k++) len += meters(osm.coord.get(ids[k - 1]), osm.coord.get(ids[k]));
    if (len > direct * 3.0 + 380 || len > 1200) detours++;
    for (const id of ids) chain.push(osm.coord.get(id));
    legs++;
  }
  return { chain: dedupeChain(chain), anchors: anchors.length, failed, detours, legs };
}

function pointToSegmentLocal(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const qx = a[0] + vx * t;
  const qy = a[1] + vy * t;
  return Math.hypot(p[0] - qx, p[1] - qy);
}

function deviationMeters(targetLocal, chain, center) {
  const routeLocal = chain.map((p) => latLngToLocal(p, center));
  if (routeLocal.length < 2) return { mean: Infinity, max: Infinity };
  const samples = [];
  let carry = 0;
  for (let i = 1; i < targetLocal.length; i++) {
    const a = targetLocal[i - 1];
    const b = targetLocal[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.round((carry + len) / 45));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    carry = (carry + len) % 45;
  }
  let sum = 0;
  let max = 0;
  for (const s of samples) {
    let best = Infinity;
    for (let i = 1; i < routeLocal.length; i++) {
      const d = pointToSegmentLocal(s, routeLocal[i - 1], routeLocal[i]);
      if (d < best) best = d;
      if (best < 2) break;
    }
    sum += best;
    if (best > max) max = best;
  }
  return { mean: sum / Math.max(1, samples.length), max };
}

function routeObject(chain, km) {
  return { coordinates: chain, blockWaypoints: chain, distanceMeters: km * 1000 };
}

function pathD(points, project) {
  if (points.length < 2) return "";
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function escapeXml(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

async function renderPreview(osm, chain, targetLocal, center, file, title, meta) {
  const routeLocal = chain.map((p) => latLngToLocal(p, center));
  const all = [...routeLocal, ...targetLocal];
  const b = bounds(all);
  const pad = 300;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const w = 1100;
  const h = 820;
  const scale = Math.min((w - 80) / Math.max(1, view.maxX - view.minX), (h - 120) / Math.max(1, view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale;
  const usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2;
  const oy = 84 + (h - 120 - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;

  const streets = [];
  const seen = new Set();
  for (const [from, edges] of osm.adj.entries()) {
    const aLL = osm.coord.get(from);
    if (!aLL) continue;
    const a = latLngToLocal(aLL, center);
    for (const edge of edges) {
      const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bLL = osm.coord.get(edge.to);
      if (!bLL) continue;
      const bb = latLngToLocal(bLL, center);
      if (!inView(a) && !inView(bb)) continue;
      streets.push(`<path d="${pathD([a, bb], project)}" fill="none" stroke="#d7d7d2" stroke-width="1.2"/>`);
      if (streets.length > 9000) break;
    }
    if (streets.length > 9000) break;
  }

  const targetD = pathD(targetLocal, project);
  const routeD = pathD(routeLocal, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#f4f2ea"/>
    <rect x="24" y="72" width="${w - 48}" height="${h - 96}" fill="#fff"/>
    <text x="24" y="34" font-family="Arial" font-size="24" font-weight="700" fill="#111827">${escapeXml(title)}</text>
    <text x="24" y="58" font-family="Arial" font-size="14" fill="#4b5563">${escapeXml(meta)}</text>
    ${streets.join("\n")}
    <path d="${targetD}" fill="none" stroke="#2563eb" stroke-width="3" stroke-opacity="0.35" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${routeD}" fill="none" stroke="#7f1d1d" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${routeD}" fill="none" stroke="#ef2727" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function scoreCandidate(candidate, cfg) {
  const distancePenalty = Math.abs(candidate.km - cfg.targetKm) * 28;
  return candidate.dev.mean * 2.2 + candidate.dev.max * 0.08 + distancePenalty + candidate.failed * 120 + candidate.detours * 45 - Math.min(candidate.legs, 160) * 0.05;
}

async function compileSample(osm, cfg) {
  const inputPath = path.join(IN_ROOT, cfg.id, "route-normalized.json");
  const points = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const outDir = path.join(OUT_ROOT, cfg.id);
  await fs.mkdir(outDir, { recursive: true });
  let best = null;
  for (const widthM of cfg.widths) {
    for (const rotation of cfg.rotations) {
      const local = normalizeToMeters(points, widthM, rotation);
      for (const center of CENTERS) {
        const target = localToLatLng(local, center);
        for (const params of PARAMS) {
          const routed = routeThroughOsm(osm, target, params);
          if (routed.chain.length < 8 || routed.legs < 4) continue;
          const km = pathKm(routed.chain);
          if (km < 3 || km > 45) continue;
          const dev = deviationMeters(local, routed.chain, center);
          const candidate = { ...routed, km, dev, widthM, rotation, center, params, local };
          const score = scoreCandidate(candidate, cfg);
          if (!best || score < best.score) best = { ...candidate, score };
        }
      }
    }
  }
  if (!best) return { id: cfg.id, ok: false, error: "no full-graph route found" };

  const route = routeObject(best.chain, best.km);
  const score = Math.max(0, Math.min(100, 100 - best.dev.mean / 1.8 - Math.abs(best.km - cfg.targetKm) * 1.5));
  await fs.writeFile(path.join(outDir, `${cfg.id}.gpx`), routeToGpx(route, [], undefined, { artworkMatchScore: score }), "utf8");
  await fs.writeFile(path.join(outDir, `${cfg.id}.geojson`), JSON.stringify(routeToGeoJSONFeatureCollection(route, [], { artworkMatchScore: score }), null, 2), "utf8");
  await fs.writeFile(path.join(outDir, "route.json"), JSON.stringify({
    chain: best.chain,
    km: best.km,
    meanDeviationMeters: best.dev.mean,
    maxDeviationMeters: best.dev.max,
    legs: best.legs,
    anchors: best.anchors,
    failed: best.failed,
    detours: best.detours,
    widthM: best.widthM,
    rotation: best.rotation,
    center: best.center,
    params: best.params,
    score: best.score,
  }, null, 2), "utf8");
  await renderPreview(
    osm,
    best.chain,
    best.local,
    best.center,
    path.join(outDir, "PREVIEW.png"),
    `${cfg.id} full-graph runnable`,
    `${best.km.toFixed(2)} km, mean dev ${best.dev.mean.toFixed(0)} m, width ${best.widthM} m, rot ${best.rotation} deg`,
  );
  return {
    id: cfg.id,
    ok: true,
    km: Number(best.km.toFixed(2)),
    meanDeviationMeters: Number(best.dev.mean.toFixed(1)),
    maxDeviationMeters: Number(best.dev.max.toFixed(1)),
    legs: best.legs,
    anchors: best.anchors,
    failed: best.failed,
    detours: best.detours,
    widthM: best.widthM,
    rotation: best.rotation,
    center: best.center,
    params: best.params,
    preview: path.relative(ROOT, path.join(outDir, "PREVIEW.png")).replace(/\\/g, "/"),
    gpx: path.relative(ROOT, path.join(outDir, `${cfg.id}.gpx`)).replace(/\\/g, "/"),
    geojson: path.relative(ROOT, path.join(outDir, `${cfg.id}.geojson`)).replace(/\\/g, "/"),
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
    let img;
    if (r.ok) {
      img = await sharp(path.join(ROOT, r.preview)).resize(cellW, cellH, { fit: "contain", background: "#fff" }).png().toBuffer();
    } else {
      img = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${cellH}"><rect width="100%" height="100%" fill="#fff"/><text x="24" y="40" font-family="Arial" font-size="22" fill="#991b1b">${escapeXml(r.id)} failed</text><text x="24" y="72" font-family="Arial" font-size="14" fill="#4b5563">${escapeXml(r.error)}</text></svg>`);
    }
    comps.push({ input: img, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH });
  }
  await sharp({ create: { width: cellW * cols, height: cellH * rows, channels: 4, background: "#e5e7eb" } })
    .composite(comps)
    .png()
    .toFile(path.join(OUT_ROOT, "SHEET.png"));
}

async function main() {
  await fs.mkdir(OUT_ROOT, { recursive: true });
  console.log("[fullgraph] loading OSM walk graph");
  const osm = await buildGraph();
  const results = [];
  for (const cfg of CONFIGS) {
    console.log(`[fullgraph] compiling ${cfg.id}`);
    results.push(await compileSample(osm, cfg));
  }
  await writeSheet(results);
  await fs.writeFile(path.join(OUT_ROOT, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(path.relative(ROOT, OUT_ROOT));
  for (const r of results) {
    if (!r.ok) console.log(`${r.id.padEnd(8)} failed: ${r.error}`);
    else console.log(`${r.id.padEnd(8)} ${String(r.km).padStart(5)} km meanDev=${String(r.meanDeviationMeters).padStart(5)}m detours=${r.detours} preview=${r.preview}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
