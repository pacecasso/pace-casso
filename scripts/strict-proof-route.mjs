#!/usr/bin/env node
/* Strict proof route: one sample, no straight-line fake links.
 * Every exported coordinate comes from an OSM graph node, and every consecutive
 * pair is validated as an actual OSM graph edge from tmp-gas-spike/osm-walk-network.json.
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
const SAMPLE = process.argv[2] ?? "lion";
const OUT_ROOT = path.join(ROOT, "tmp-strict-proof-route", SAMPLE);
const M_PER_LAT = 111_320;

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

function transform(points, centerLocal, scale, rot) {
  return points.map((p) => {
    const q = rotateScale(p, scale, rot);
    return [centerLocal[0] + q[0], centerLocal[1] + q[1]];
  });
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
  if (tail && out.length && dist(out[out.length - 1], tail) > 1) out.push(tail);
  return out;
}

function routeKm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += meters(points[i - 1], points[i]);
  return total / 1000;
}

function edgeSet(osm) {
  const set = new Set();
  for (const [from, edges] of osm.adj.entries()) {
    for (const e of edges) set.add(`${from}:${e.to}`);
  }
  return set;
}

function validateNodePath(nodeIds, osm) {
  const edges = edgeSet(osm);
  let missingEdges = 0;
  let duplicateSteps = 0;
  let maxEdgeMeters = 0;
  for (let i = 1; i < nodeIds.length; i++) {
    const a = nodeIds[i - 1];
    const b = nodeIds[i];
    if (a === b) {
      duplicateSteps++;
      continue;
    }
    if (!edges.has(`${a}:${b}`)) missingEdges++;
    const pa = osm.coord.get(a);
    const pb = osm.coord.get(b);
    if (pa && pb) maxEdgeMeters = Math.max(maxEdgeMeters, meters(pa, pb));
  }
  return { missingEdges, duplicateSteps, maxEdgeMeters };
}

function pointToSegmentLocal(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const q = [a[0] + vx * t, a[1] + vy * t];
  return dist(p, q);
}

function deviationMeters(targetLocal, routeLocal) {
  let sum = 0;
  let max = 0;
  let count = 0;
  for (const p of simplifyByDistance(targetLocal, 35)) {
    let best = Infinity;
    for (let i = 1; i < routeLocal.length; i++) {
      const d = pointToSegmentLocal(p, routeLocal[i - 1], routeLocal[i]);
      if (d < best) best = d;
      if (best < 2) break;
    }
    sum += best;
    max = Math.max(max, best);
    count++;
  }
  return { mean: sum / Math.max(1, count), max };
}

function routeThroughGraph(osm, anchors) {
  const nodeIds = [];
  let failedLegs = 0;
  let fallbackLegs = 0;
  for (let i = 1; i < anchors.length; i++) {
    const a = nearestNode(osm, anchors[i - 1]);
    const b = nearestNode(osm, anchors[i]);
    if (a < 0 || b < 0 || a === b) continue;
    const segment = [anchors[i - 1], anchors[i]];
    let ids = corridorPath(osm, a, b, segment, 12, 220);
    if (!ids) ids = corridorPath(osm, a, b, segment, 8, 420);
    if (!ids) {
      ids = corridorPath(osm, a, b, segment, 0, 1e7);
      fallbackLegs++;
    }
    if (!ids) {
      failedLegs++;
      continue;
    }
    for (const id of ids) {
      if (!nodeIds.length || nodeIds[nodeIds.length - 1] !== id) nodeIds.push(id);
    }
  }
  return { nodeIds, failedLegs, fallbackLegs };
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

async function renderPreview(targetLocal, routeLocal, file, title, meta) {
  const all = [...targetLocal, ...routeLocal];
  const b = bounds(all);
  const pad = 250;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const w = 1200;
  const h = 900;
  const scale = Math.min((w - 80) / Math.max(1, view.maxX - view.minX), (h - 120) / Math.max(1, view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale;
  const usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2;
  const oy = 84 + (h - 120 - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const targetD = pathD(targetLocal, project);
  const routeD = pathD(routeLocal, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#f4f2ea"/>
    <rect x="24" y="72" width="${w - 48}" height="${h - 96}" fill="#fff"/>
    <text x="24" y="34" font-family="Arial" font-size="25" font-weight="700" fill="#111827">${escapeXml(title)}</text>
    <text x="24" y="58" font-family="Arial" font-size="14" fill="#4b5563">${escapeXml(meta)}</text>
    <path d="${targetD}" fill="none" stroke="#2563eb" stroke-width="3" stroke-opacity="0.28" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${routeD}" fill="none" stroke="#7f1d1d" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${routeD}" fill="none" stroke="#ef2727" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function main() {
  await fs.mkdir(OUT_ROOT, { recursive: true });
  const osm = await buildGraph();
  let s = 90, n = -90, w = 180, e = -180;
  for (const id of osm.adj.keys()) {
    const [lat, lng] = osm.coord.get(id);
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lng); e = Math.max(e, lng);
  }
  const proj = setProjection({ s, w, n, e });
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, "tmp-sample-replication", SAMPLE, "route-normalized.json"), "utf8"));
  const normalized = normalizeInput(raw);
  let fit;
  let centerLocal;
  let targetScale;
  let targetRotation;
  if ((process.argv[4] ?? "") === "fullgraph") {
    fit = JSON.parse(await fs.readFile(path.join(ROOT, "tmp-sample-runnable-fullgraph", SAMPLE, "route.json"), "utf8"));
    const b = bounds(raw);
    targetScale = fit.widthM / Math.max(1, b.maxX - b.minX);
    targetRotation = fit.rotation;
    centerLocal = latLngToLocal(fit.center, proj);
  } else {
    fit = JSON.parse(await fs.readFile(path.join(ROOT, "tmp-sample-recovered-streetfit", SAMPLE, "route.json"), "utf8"));
    targetScale = fit.scale;
    targetRotation = fit.rotation;
    centerLocal = latLngToLocal(fit.center, proj);
  }
  const targetLocal = transform(normalized, centerLocal, targetScale, targetRotation);
  const anchorLocal = simplifyByDistance(targetLocal, Number(process.argv[3] ?? 85));
  const anchors = anchorLocal.map((p) => localToLatLng(p, proj));
  const routed = routeThroughGraph(osm, anchors);
  const validation = validateNodePath(routed.nodeIds, osm);
  const chain = routed.nodeIds.map((id) => osm.coord.get(id));
  const chainLocal = chain.map((p) => latLngToLocal(p, proj));
  const km = routeKm(chain);
  const dev = deviationMeters(targetLocal, chainLocal);
  const route = { coordinates: chain, blockWaypoints: chain, distanceMeters: km * 1000 };
  const artworkMatchScore = Math.max(0, Math.min(100, 100 - dev.mean / 1.5 - routed.failedLegs * 10 - validation.missingEdges * 100));
  await fs.writeFile(path.join(OUT_ROOT, `${SAMPLE}.gpx`), routeToGpx(route, [], undefined, { artworkMatchScore }), "utf8");
  await fs.writeFile(path.join(OUT_ROOT, `${SAMPLE}.geojson`), JSON.stringify(routeToGeoJSONFeatureCollection(route, [], { artworkMatchScore }), null, 2), "utf8");
  const summary = {
    sample: SAMPLE,
    strictRunnable: validation.missingEdges === 0 && routed.failedLegs === 0,
    km: Number(km.toFixed(2)),
    routePoints: chain.length,
    anchors: anchors.length,
    failedLegs: routed.failedLegs,
    fallbackLegs: routed.fallbackLegs,
    validation: {
      missingEdges: validation.missingEdges,
      duplicateSteps: validation.duplicateSteps,
      maxEdgeMeters: Number(validation.maxEdgeMeters.toFixed(1)),
    },
    deviation: {
      meanMeters: Number(dev.mean.toFixed(1)),
      maxMeters: Number(dev.max.toFixed(1)),
    },
    sourceFit: {
      center: fit.center,
      scale: targetScale,
      rotation: targetRotation,
    },
  };
  await fs.writeFile(path.join(OUT_ROOT, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await renderPreview(targetLocal, chainLocal, path.join(OUT_ROOT, "PREVIEW.png"), `${SAMPLE} strict OSM route`, `${summary.km} km, edges missing ${validation.missingEdges}, failed legs ${routed.failedLegs}, mean dev ${summary.deviation.meanMeters} m`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


