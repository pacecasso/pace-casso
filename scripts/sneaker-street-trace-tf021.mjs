import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildGraph, nearestNode, corridorPath, meters, distToSeg } = jiti("./trace-contour.ts");

const root = process.cwd();
const base = path.join(root, "tmp-sneaker-transform-refined", "2026-07-18T17-11-26-635Z");
const outDir = path.join(base, "street-trace-tf021");
const M_PER_LAT = 111320;
const PROJ = { lat0: 40.718, lng0: -74.002, mPerLng: M_PER_LAT * Math.cos((40.718 * Math.PI) / 180) };

function llToLocal([lat, lng]) {
  return [(lng - PROJ.lng0) * PROJ.mPerLng, (lat - PROJ.lat0) * M_PER_LAT];
}
function parseGpx(s) {
  return [...s.matchAll(/lat="([^"]+)" lon="([^"]+)"/g)].map((m) => [+m[1], +m[2]]);
}
function breakSegs(pts, thr = 80) {
  const segs = [];
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (meters(pts[i - 1], pts[i]) > thr) {
      segs.push(pts.slice(start, i));
      start = i;
    }
  }
  segs.push(pts.slice(start));
  return segs.filter((s) => s.length > 1);
}
function oriented(seg, rev) {
  return rev ? [...seg].reverse() : seg;
}
function densify(chain, stepM = 20) {
  const dense = [];
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i];
    const n = Math.max(1, Math.round(meters(a, b) / stepM));
    for (let k = 0; k < n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  dense.push(chain[chain.length - 1]);
  return dense;
}
function anchorsAlong(chain, anchorM) {
  const out = [chain[0]];
  let acc = 0;
  for (let i = 1; i < chain.length; i++) {
    acc += meters(chain[i - 1], chain[i]);
    if (acc >= anchorM) {
      out.push(chain[i]);
      acc = 0;
    }
  }
  if (meters(out[out.length - 1], chain[chain.length - 1]) > 2) out.push(chain[chain.length - 1]);
  return out;
}
function traceOpenStroke(graph, stroke, opts) {
  const dense = densify(stroke, 18);
  const anchors = anchorsAlong(dense, opts.anchorM);
  const out = [];
  let failed = 0;
  for (let i = 1; i < anchors.length; i++) {
    const na = nearestNode(graph, anchors[i - 1]), nb = nearestNode(graph, anchors[i]);
    let ids = na >= 0 && nb >= 0
      ? (corridorPath(graph, na, nb, dense, opts.lambda, opts.corridorM) ||
        corridorPath(graph, na, nb, dense, opts.lambda * 0.5, opts.corridorM * 1.8) ||
        corridorPath(graph, na, nb, dense, 2, opts.corridorM * 3))
      : null;
    if (!ids || ids.length < 2) {
      failed++;
      ids = [na, nb].filter((id) => id >= 0);
    }
    for (const id of ids) {
      const p = graph.coord.get(id);
      if (p && (!out.length || meters(out[out.length - 1], p) > 1)) out.push(p);
    }
  }
  return { chain: simplifyBacktracks(out), failed, anchors: anchors.length };
}
function simplifyBacktracks(chain) {
  const out = chain.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length - 2; i++) {
      let acc = 0;
      for (let j = i + 2; j < out.length && acc < 260; j++) {
        acc += meters(out[j - 1], out[j]);
        if (meters(out[i], out[j]) < 28) {
          out.splice(i + 1, j - i);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return out;
}
function strokeError(chain, target) {
  const dense = densify(target, 20);
  let sum = 0, max = 0;
  for (const p of chain) {
    let best = Infinity;
    for (let i = 1; i < dense.length; i++) {
      const d = distToSeg(p, dense[i - 1], dense[i]);
      if (d < best) best = d;
    }
    sum += best;
    max = Math.max(max, best);
  }
  return { avg: sum / Math.max(1, chain.length), max };
}
function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function routeD(points, project) {
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}
function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
function totalKm(chains) {
  let m = 0;
  for (const chain of chains) for (let i = 1; i < chain.length; i++) m += meters(chain[i - 1], chain[i]);
  return m / 1000;
}
function continuity(chains) {
  let max = 0, g90 = 0;
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      const d = meters(chain[i - 1], chain[i]);
      max = Math.max(max, d);
      if (d > 90) g90++;
    }
  }
  return { maxStep: +max.toFixed(1), gapsOver90: g90 };
}
async function renderBlind(chains, file, label = "") {
  const loc = chains.flat().map(llToLocal);
  const b = bounds(loc);
  const pad = 90, w = 900, h = 560;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - 50) / (view.maxX - view.minX), (h - 50) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const paths = chains.map((c) => `<path d="${routeD(c.map(llToLocal), project)}" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${paths}${label ? `<text x="18" y="34" font-family="Arial" font-size="20" font-weight="700">${label}</text>` : ""}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
async function renderMap(graph, chains, file, label) {
  const loc = chains.flat().map(llToLocal);
  const b = bounds(loc);
  const pad = 260, w = 1200, h = 820;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const streets = [], seen = new Set();
  for (const [from, entries] of graph.adj.entries()) {
    for (const e of entries) {
      const key = edgeKey(from, e.to);
      if (seen.has(key)) continue;
      seen.add(key);
      const a = llToLocal(graph.coord.get(from)), bb = llToLocal(graph.coord.get(e.to));
      if (!inView(a) && !inView(bb)) continue;
      streets.push(`<path d="${routeD([a, bb], project)}" fill="none" stroke="#d7d7d7" stroke-width="1.3"/>`);
    }
  }
  const paths = chains.map((c) => {
    const d = routeD(c.map(llToLocal), project);
    return `<path d="${d}" fill="none" stroke="#111" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#ef1744" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}${paths}<text x="34" y="50" font-family="Arial" font-size="22" font-weight="700">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
async function makeSheet(items, file) {
  const tw = 560, th = 350, comps = [];
  for (let i = 0; i < items.length; i++) {
    const left = (i % 2) * tw, top = Math.floor(i / 2) * th;
    const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><rect width="100%" height="100%" fill="#f7f4ee"/><text x="18" y="30" font-family="Arial" font-size="18" font-weight="700">${items[i].label}</text></svg>`);
    const im = await sharp(items[i].file).resize({ width: tw - 24, height: th - 50, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    comps.push({ input: bg, left, top });
    comps.push({ input: im.data, left: left + Math.round((tw - im.info.width) / 2), top: top + 42 + Math.round((th - 56 - im.info.height) / 2) });
  }
  await sharp({ create: { width: tw * 2, height: th * Math.ceil(items.length / 2), channels: 4, background: "#ece7dd" } }).composite(comps).png().toFile(file);
}
function gpxMulti(name, tracks) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso street-traced sneaker" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name>\n${tracks.map((t) => `<trkseg>\n${t.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg>`).join("\n")}\n</trk></gpx>\n`;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const raw = parseGpx(await fs.readFile(path.join(base, "tf-021", "tf-021.gpx"), "utf8"));
  const segs = breakSegs(raw, 80);
  const order = [2, 1, 0, 3], bits = 9;
  const target = order.map((idx, k) => oriented(segs[idx], (bits >> k) & 1));
  const graph = await buildGraph();
  const optsList = [
    { anchorM: 120, lambda: 35, corridorM: 90 },
    { anchorM: 160, lambda: 35, corridorM: 110 },
    { anchorM: 220, lambda: 28, corridorM: 140 },
    { anchorM: 280, lambda: 24, corridorM: 180 },
    { anchorM: 180, lambda: 55, corridorM: 95 },
    { anchorM: 240, lambda: 45, corridorM: 120 },
  ];
  const summary = [], sheet = [];
  for (let i = 0; i < optsList.length; i++) {
    const opts = optsList[i];
    const chains = [];
    let failed = 0, anchors = 0;
    let errSum = 0, errMax = 0;
    for (const stroke of target) {
      const traced = traceOpenStroke(graph, stroke, opts);
      chains.push(traced.chain);
      failed += traced.failed;
      anchors += traced.anchors;
      const e = strokeError(traced.chain, stroke);
      errSum += e.avg;
      errMax = Math.max(errMax, e.max);
    }
    const id = `trace-${String(i + 1).padStart(2, "0")}`;
    const dir = path.join(outDir, id);
    await fs.mkdir(dir, { recursive: true });
    const km = totalKm(chains);
    const c = continuity(chains);
    await renderBlind(chains, path.join(dir, "blind.png"));
    await renderMap(graph, chains, path.join(dir, "map.png"), `${id} ${km.toFixed(1)}km err ${(errSum / chains.length).toFixed(0)}m fail ${failed}`);
    await fs.writeFile(path.join(dir, "art-strokes.gpx"), gpxMulti(`${id}-art-strokes`, chains));
    const row = {
      id,
      ...opts,
      km: +km.toFixed(2),
      miles: +(km * 0.621371).toFixed(2),
      avgError: +(errSum / chains.length).toFixed(1),
      maxError: +errMax.toFixed(1),
      failed,
      anchors,
      ...c,
      blind: path.relative(root, path.join(dir, "blind.png")).replace(/\\/g, "/"),
      map: path.relative(root, path.join(dir, "map.png")).replace(/\\/g, "/"),
      gpx: path.relative(root, path.join(dir, "art-strokes.gpx")).replace(/\\/g, "/"),
    };
    summary.push(row);
    sheet.push({ label: `${id} ${row.km}km e${row.avgError} f${failed}`, file: path.join(dir, "blind.png") });
  }
  await makeSheet(sheet, path.join(outDir, "street-trace-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
