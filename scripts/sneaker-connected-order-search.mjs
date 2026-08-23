import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildGraph, nearestNode, corridorPath, meters, distToSeg } = jiti("./trace-contour.ts");

const root = process.cwd();
const base = path.join(root, "tmp-sneaker-transform-refined", "2026-07-18T17-11-26-635Z");
const outDir = path.join(base, "connected-order-search");
const sourceId = "tf-021";
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
function permutations(items) {
  if (items.length < 2) return [items];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (const tail of permutations(items.filter((_, k) => k !== i))) out.push([items[i], ...tail]);
  }
  return out;
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
function totalKm(chain) {
  let m = 0;
  for (let i = 1; i < chain.length; i++) m += meters(chain[i - 1], chain[i]);
  return m / 1000;
}
function continuity(chain) {
  let max = 0;
  let g90 = 0;
  for (let i = 1; i < chain.length; i++) {
    const d = meters(chain[i - 1], chain[i]);
    max = Math.max(max, d);
    if (d > 90) g90++;
  }
  return { maxStep: +max.toFixed(1), gapsOver90: g90 };
}
function artDistance(p, artDense) {
  let best = Infinity;
  for (let i = 1; i < artDense.length; i++) {
    const d = distToSeg(p, artDense[i - 1], artDense[i]);
    if (d < best) best = d;
  }
  return best;
}
function densify(chains) {
  const dense = [];
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i];
      const n = Math.max(1, Math.round(meters(a, b) / 20));
      for (let k = 0; k < n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    dense.push(chain[chain.length - 1]);
  }
  return dense;
}
async function renderBlind(chain, file, label = "") {
  const loc = chain.map(llToLocal);
  const b = bounds(loc);
  const pad = 90, w = 900, h = 560;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - 50) / (view.maxX - view.minX), (h - 50) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${routeD(loc, project)}" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${label ? `<text x="18" y="34" font-family="Arial" font-size="20" font-weight="700">${label}</text>` : ""}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
async function renderMap(graph, chain, file, label) {
  const loc = chain.map(llToLocal);
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
  const d = routeD(loc, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}<path d="${d}" fill="none" stroke="#111" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#ef1744" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><text x="34" y="50" font-family="Arial" font-size="22" font-weight="700">${label}</text></svg>`;
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
function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso connected sneaker order search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const raw = parseGpx(await fs.readFile(path.join(base, sourceId, `${sourceId}.gpx`), "utf8"));
  const sourceSegs = breakSegs(raw, 80);
  const graph = await buildGraph();
  const rows = [];
  for (const order of permutations([0, 1, 2, 3])) {
    for (let bits = 0; bits < 16; bits++) {
      const chains = order.map((idx, k) => oriented(sourceSegs[idx], (bits >> k) & 1));
      const artDense = densify(chains);
      const full = [];
      const connectors = [];
      let failed = 0;
      for (let i = 0; i < chains.length; i++) {
        if (i > 0) {
          const a = full[full.length - 1], b = chains[i][0];
          const na = nearestNode(graph, a), nb = nearestNode(graph, b);
          const ids = na >= 0 && nb >= 0
            ? (corridorPath(graph, na, nb, artDense, 28, 90) || corridorPath(graph, na, nb, artDense, 18, 140) || corridorPath(graph, na, nb, artDense, 8, 260) || corridorPath(graph, na, nb, raw, 2, 500))
            : null;
          if (!ids || ids.length < 2) {
            failed++;
            full.push(b);
            connectors.push([a, b]);
          } else {
            const conn = ids.map((id) => graph.coord.get(id)).filter(Boolean);
            connectors.push(conn);
            for (const p of conn) if (!full.length || meters(full[full.length - 1], p) > 1) full.push(p);
          }
        }
        for (const p of chains[i]) if (!full.length || meters(full[full.length - 1], p) > 1) full.push(p);
      }
      const connectorKm = totalKm(connectors.flatMap((c, i) => (i ? [c[0], ...c] : c)));
      const offArt = connectors.flat().reduce((sum, p) => sum + artDistance(p, artDense), 0) / Math.max(1, connectors.flat().length);
      const km = totalKm(full);
      const c = continuity(full);
      rows.push({ order, bits, chains, full, connectors, failed, connectorKm, offArt, km, ...c });
    }
  }
  rows.sort((a, b) => (a.failed * 10000 + a.connectorKm * 650 + a.offArt * 8 + a.maxStep * 5) - (b.failed * 10000 + b.connectorKm * 650 + b.offArt * 8 + b.maxStep * 5));
  const summary = [];
  const sheet = [];
  for (let i = 0; i < Math.min(24, rows.length); i++) {
    const r = rows[i];
    const id = `candidate-${String(i + 1).padStart(2, "0")}`;
    const dir = path.join(outDir, id);
    await fs.mkdir(dir, { recursive: true });
    await renderBlind(r.full, path.join(dir, "blind.png"));
    await renderMap(graph, r.full, path.join(dir, "map.png"), `${id} ${r.km.toFixed(1)}km conn ${r.connectorKm.toFixed(2)}km off ${r.offArt.toFixed(0)}m`);
    await fs.writeFile(path.join(dir, "route.gpx"), gpx(`${sourceId}-${id}`, r.full));
    summary.push({
      id,
      km: +r.km.toFixed(2),
      miles: +(r.km * 0.621371).toFixed(2),
      connectorKm: +r.connectorKm.toFixed(2),
      offArt: +r.offArt.toFixed(1),
      maxStep: r.maxStep,
      gapsOver90: r.gapsOver90,
      failed: r.failed,
      order: r.order,
      bits: r.bits,
      blind: path.relative(root, path.join(dir, "blind.png")).replace(/\\/g, "/"),
      map: path.relative(root, path.join(dir, "map.png")).replace(/\\/g, "/"),
      gpx: path.relative(root, path.join(dir, "route.gpx")).replace(/\\/g, "/"),
    });
    sheet.push({ label: `${id} conn${r.connectorKm.toFixed(2)} off${r.offArt.toFixed(0)} max${r.maxStep}`, file: path.join(dir, "blind.png") });
  }
  await makeSheet(sheet, path.join(outDir, "connected-order-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
