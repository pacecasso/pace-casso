#!/usr/bin/env node
/*
 * Compile extracted sample route language into runnable Manhattan routes.
 *
 * Input comes from tmp-sample-replication/<id>/route-normalized.json, produced
 * by scripts/learn-from-route-samples.mjs. Output is a runnable street chain,
 * GPX, GeoJSON, and preview image for each sample.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url, { fsCache: false });
const { buildLatticeGraph, compileContourToLattice, haversineMeters } = jiti("../lib/latticeCompiler.ts");
const { routeToGpx, routeToGeoJSONFeatureCollection } = jiti("../lib/routeExport.ts");

const ROOT = process.cwd();
const IN_ROOT = path.join(ROOT, "tmp-sample-replication");
const OUT_ROOT = path.join(ROOT, "tmp-sample-runnable");
const LATTICE_PATH = path.join(ROOT, "lib", "data", "manhattan-lattice.json");

const M_PER_LAT = 111_320;
const STREET_BEARING = 119;
const AVENUE_BEARING = 29;
const X_AXIS = unit(STREET_BEARING);
const Y_AXIS = unit(AVENUE_BEARING);

const SAMPLE_CONFIGS = [
  { id: "lion", targetKm: 22, widths: [1200, 1700, 2300, 3000], rotations: [-25, -10, 0, 12, 25] },
  { id: "tiger", targetKm: 22, widths: [1500, 2200, 3000, 3900], rotations: [-15, 0, 12, 25] },
  { id: "witch", targetKm: 23.7, widths: [1700, 2300, 3000, 3900], rotations: [-35, -15, 0, 15, 35] },
  { id: "love", targetKm: 18, widths: [1400, 2000, 2800, 3800], rotations: [-12, 0, 12, 24] },
  { id: "heart", targetKm: 18, widths: [1300, 1900, 2600, 3600], rotations: [-20, 0, 20] },
  { id: "puma", targetKm: 18.1, widths: [1100, 1600, 2200, 3000, 3900], rotations: [-12, 0, 12] },
  { id: "unicorn", targetKm: 21.1, widths: [1800, 2400, 3200, 4100], rotations: [-20, 0, 20] },
];

const CENTERS = [
  [40.752, -73.989],
  [40.741, -73.992],
  [40.764, -73.981],
  [40.729, -73.986],
  [40.776, -73.977],
  [40.716, -74.006],
  [40.786, -73.968],
  [40.748, -73.969],
  [40.707, -74.011],
  [40.801, -73.955],
];

function unit(deg) {
  const r = (deg * Math.PI) / 180;
  return { e: Math.sin(r), n: Math.cos(r) };
}

function mPerLng(lat) {
  return M_PER_LAT * Math.cos((lat * Math.PI) / 180);
}

function meters(a, b) {
  return haversineMeters(a, b);
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

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function normalizeToMeters(points, widthM, rotateDeg = 0) {
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

function placeAtCenter(local, center) {
  const b = bounds(local);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const offset = toLatLngFrom(center, [cx, cy]);
  const origin = [center[0] - (offset[0] - center[0]), center[1] - (offset[1] - center[1])];
  return { origin, latLngs: local.map((p) => toLatLngFrom(origin, p)) };
}

function routeKm(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += meters(coords[i - 1], coords[i]);
  return total / 1000;
}

function scoreResult(result, cfg) {
  const km = result.km;
  return (
    result.meanDeviationMeters * 1.4 +
    result.maxDeviationMeters * 0.1 +
    result.skippedPins * 500 +
    Math.abs(km - cfg.targetKm) * 130 -
    Math.min(result.legCount, 180) * 0.25
  );
}

async function renderStreetRoute(graph, chain, targetLocal, origin, file, title, meta) {
  const routeLocal = chain.map((p) => toLocalFrom(origin, p));
  const all = [...routeLocal, ...targetLocal];
  const b = bounds(all);
  const pad = 280;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const w = 1100;
  const h = 820;
  const scale = Math.min((w - 70) / Math.max(1, view.maxX - view.minX), (h - 110) / Math.max(1, view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale;
  const usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2;
  const oy = 84 + (h - 110 - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;

  const seen = new Set();
  const streets = [];
  for (const [from, entries] of graph.adj.entries()) {
    for (const edge of entries) {
      const k = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map((p) => toLocalFrom(origin, p));
      if (!pts.some(inView)) continue;
      const d = pathD(pts, project);
      streets.push(`<path d="${d}" fill="none" stroke="#d7d7d2" stroke-width="1.6"/>`);
    }
  }
  const targetD = pathD(targetLocal, project);
  const routeD = pathD(routeLocal, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#f4f2ea"/>
    <rect x="24" y="72" width="${w - 48}" height="${h - 96}" fill="#fff"/>
    <text x="24" y="34" font-family="Arial" font-size="24" font-weight="700" fill="#111827">${escapeXml(title)}</text>
    <text x="24" y="58" font-family="Arial" font-size="14" fill="#4b5563">${escapeXml(meta)}</text>
    ${streets.join("\n")}
    <path d="${targetD}" fill="none" stroke="#2563eb" stroke-width="4" stroke-opacity="0.35" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${routeD}" fill="none" stroke="#771225" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${routeD}" fill="none" stroke="#ef2727" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
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

async function compileSample(cfg, graph) {
  const inputPath = path.join(IN_ROOT, cfg.id, "route-normalized.json");
  const points = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const outDir = path.join(OUT_ROOT, cfg.id);
  await fs.mkdir(outDir, { recursive: true });
  let best = null;
  for (const widthM of cfg.widths) {
    for (const rotation of cfg.rotations) {
      const local = normalizeToMeters(points, widthM, rotation);
      for (const center of CENTERS) {
        const placed = placeAtCenter(local, center);
        for (const pinRadiusMeters of [130, 165, 205, 250]) {
          const result = compileContourToLattice(placed.latLngs, graph, {
            sampleMeters: 32,
            pinRadiusMeters,
            minPinSpacingMeters: 45,
            maxLegDetourRatio: 3.25,
            maxLegDetourSlackMeters: 310,
          });
          if (!result) continue;
          const score = scoreResult(result, cfg);
          if (!best || score < best.score) {
            best = { result, score, widthM, rotation, center, pinRadiusMeters, local, origin: placed.origin };
          }
        }
      }
    }
  }
  if (!best) return { id: cfg.id, ok: false, error: "no compilable placement" };

  const route = {
    coordinates: best.result.chain,
    blockWaypoints: best.result.junctions,
    distanceMeters: best.result.km * 1000,
  };
  const gpx = routeToGpx(route, [], undefined, { artworkMatchScore: Math.max(0, 100 - best.result.meanDeviationMeters / 2) });
  const geojson = routeToGeoJSONFeatureCollection(route, [], { artworkMatchScore: Math.max(0, 100 - best.result.meanDeviationMeters / 2) });
  await fs.writeFile(path.join(outDir, `${cfg.id}.gpx`), gpx, "utf8");
  await fs.writeFile(path.join(outDir, `${cfg.id}.geojson`), JSON.stringify(geojson, null, 2), "utf8");
  await fs.writeFile(path.join(outDir, "route.json"), JSON.stringify(best.result, null, 2), "utf8");
  await renderStreetRoute(
    graph,
    best.result.chain,
    best.local,
    best.origin,
    path.join(outDir, "PREVIEW.png"),
    `${cfg.id} runnable replication`,
    `${best.result.km.toFixed(2)} km, mean dev ${best.result.meanDeviationMeters.toFixed(0)} m, width ${best.widthM} m, rot ${best.rotation} deg`,
  );
  return {
    id: cfg.id,
    ok: true,
    km: Number(best.result.km.toFixed(2)),
    inputKm: Number(best.result.inputKm.toFixed(2)),
    meanDeviationMeters: Number(best.result.meanDeviationMeters.toFixed(1)),
    maxDeviationMeters: Number(best.result.maxDeviationMeters.toFixed(1)),
    legCount: best.result.legCount,
    skippedPins: best.result.skippedPins,
    widthM: best.widthM,
    rotation: best.rotation,
    center: best.center,
    pinRadiusMeters: best.pinRadiusMeters,
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
  const lattice = JSON.parse(await fs.readFile(LATTICE_PATH, "utf8"));
  const graph = buildLatticeGraph(lattice);
  const results = [];
  for (const cfg of SAMPLE_CONFIGS) {
    console.log(`[runnable] compiling ${cfg.id}`);
    results.push(await compileSample(cfg, graph));
  }
  await writeSheet(results);
  await fs.writeFile(path.join(OUT_ROOT, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(path.relative(ROOT, OUT_ROOT));
  for (const r of results) {
    if (!r.ok) console.log(`${r.id.padEnd(8)} failed: ${r.error}`);
    else console.log(`${r.id.padEnd(8)} ${String(r.km).padStart(5)} km meanDev=${String(r.meanDeviationMeters).padStart(5)}m skipped=${r.skippedPins} preview=${r.preview}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


