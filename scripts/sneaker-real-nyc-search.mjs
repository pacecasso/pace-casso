import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph, compileContourToLattice } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-real-sneaker-search", stamp);
const M_PER_LAT = 111320;
const BASE = [40.744061, -74.006811];
const X = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };

function arc(cx, cy, rx, ry, a0, a1, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}
function densify(points, max = 30) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    out.push(a);
    const b = points[i + 1];
    if (!b) continue;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(d / max));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
function sneakerGrammar() {
  const outsole = [[0, 210], [180, 135], [520, 105], [900, 112], [1280, 160], [1620, 255]];
  const toe = arc(1560, 335, 175, 125, -0.55, 1.25, 16);
  const upper = [[1395, 505], [1110, 570], [870, 665], [690, 835], [525, 890], [390, 780], [305, 555], [140, 380], [0, 210]];
  const ankleOpening = [[525, 890], [620, 675], [835, 695], [690, 835]];
  const heelCup = [[305, 555], [230, 790], [390, 780]];
  const soleLine = [[80, 190], [460, 175], [850, 185], [1240, 220], [1540, 295]];
  const sidePanel = [[430, 365], [700, 285], [1120, 330], [1430, 455], [1040, 390], [720, 405], [430, 365]];
  const laceRows = [[650, 680], [710, 510], [800, 690], [875, 505], [960, 655], [1040, 525], [1130, 610]];
  return densify([...outsole, ...toe, ...upper, ...ankleOpening, ...heelCup, ...soleLine, ...sidePanel, ...laceRows], 30);
}
function bounds(pts) {
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function normalize(points) {
  const b = bounds(points);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  return points.map(([x, y]) => [(x - b.minX) / w, (y - b.minY) / h]);
}
function localToLatLng([x, y]) {
  const e = x * X.e + y * Y.e;
  const n = x * X.n + y * Y.n;
  const mPerLng = M_PER_LAT * Math.cos((BASE[0] * Math.PI) / 180);
  return [BASE[0] + n / M_PER_LAT, BASE[1] + e / mPerLng];
}
function latLngToLocal([lat, lng]) {
  const mPerLng = M_PER_LAT * Math.cos((BASE[0] * Math.PI) / 180);
  const n = (lat - BASE[0]) * M_PER_LAT;
  const e = (lng - BASE[1]) * mPerLng;
  const det = X.e * Y.n - Y.e * X.n;
  return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det];
}
function place(unitPts, center, widthM, heightRatio = 0.46, flipY = false) {
  const heightM = widthM * heightRatio;
  return unitPts.map(([u, v]) => {
    const x = center[0] + (u - 0.5) * widthM;
    const yy = flipY ? 1 - v : v;
    const y = center[1] + (yy - 0.5) * heightM;
    return localToLatLng([x, y]);
  });
}
function localBoundsLatLng(chain) { return bounds(chain.map(latLngToLocal)); }
function routeD(chain, project) {
  return chain.map((p, i) => { const [x, y] = project(p); return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ");
}
async function renderCandidate(chain, graph, file, label = "") {
  const route = chain.map(latLngToLocal);
  const rb = bounds(route);
  const pad = 260;
  const view = { minX: rb.minX - pad, maxX: rb.maxX + pad, minY: rb.minY - pad, maxY: rb.maxY + pad };
  const w = 1100, h = 820;
  const s = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * s, usedH = (view.maxY - view.minY) * s;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * s, oy + (view.maxY - y) * s];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const seen = new Set();
  const streets = [];
  for (const [from, entries] of graph.adj.entries()) {
    for (const edge of entries) {
      const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(latLngToLocal);
      if (!pts.some(inView)) continue;
      streets.push(`<path d="${routeD(pts, project)}" fill="none" stroke="#dadada" stroke-width="2"/>`);
    }
  }
  const rd = routeD(route, project);
  const labelText = label ? `<text x="32" y="44" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w-48}" height="${h-48}" fill="#fff"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="#771225" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><path d="${rd}" fill="none" stroke="#ef1744" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>${labelText}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso real sneaker search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}
async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const lattice = JSON.parse(await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8"));
  const graph = buildLatticeGraph(lattice);
  const unit = normalize(sneakerGrammar());
  const centersLatLng = [
    [40.721, -74.004], [40.733, -74.002], [40.744, -74.006], [40.754, -73.997],
    [40.764, -73.991], [40.775, -73.982], [40.786, -73.975], [40.801, -73.965],
    [40.712, -73.990], [40.728, -73.985], [40.742, -73.982], [40.758, -73.975],
  ];
  const centers = centersLatLng.map(latLngToLocal);
  const widths = [2100, 2600, 3100, 3600, 4300, 5000, 5800];
  const heightRatios = [0.34, 0.40, 0.46, 0.54];
  const all = [];
  let idx = 0;
  for (const center of centers) for (const widthM of widths) for (const hr of heightRatios) for (const flipY of [false, true]) {
    const placed = place(unit, center, widthM, hr, flipY);
    const res = compileContourToLattice(placed, graph, { sampleMeters: 28, pinRadiusMeters: 165, maxLegDetourRatio: 2.8, maxLegDetourSlackMeters: 240 });
    if (!res) continue;
    const rb = localBoundsLatLng(res.chain);
    const aspect = (rb.maxX - rb.minX) / Math.max(1, rb.maxY - rb.minY);
    const routeLenPenalty = Math.abs(res.km - 18) * 1.3;
    const aspectPenalty = Math.abs(aspect - 3.1) * 18;
    const score = res.meanDeviationMeters + res.skippedPins * 180 + routeLenPenalty + aspectPenalty;
    all.push({ id: `cand-${String(++idx).padStart(3, "0")}`, score, center, widthM, hr, flipY, km: res.km, meanDeviationMeters: res.meanDeviationMeters, maxDeviationMeters: res.maxDeviationMeters, skippedPins: res.skippedPins, legCount: res.legCount, aspect, chain: res.chain });
  }
  all.sort((a, b) => a.score - b.score);
  const top = all.slice(0, 12);
  const summary = [];
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const dir = path.join(outDir, c.id);
    await fs.mkdir(dir, { recursive: true });
    await renderCandidate(c.chain, graph, path.join(dir, "route-blind.png"));
    await renderCandidate(c.chain, graph, path.join(dir, "route-labeled.png"), `${c.id} ${c.km.toFixed(1)} km`);
    await fs.writeFile(path.join(dir, `${c.id}.gpx`), gpx(c.id, c.chain), "utf8");
    const clean = { ...c };
    delete clean.chain;
    summary.push({ ...clean, blindImage: path.relative(root, path.join(dir, "route-blind.png")).replace(/\\/g, "/"), gpx: path.relative(root, path.join(dir, `${c.id}.gpx`)).replace(/\\/g, "/") });
  }
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(path.relative(root, outDir));
}
main().catch(e => { console.error(e); process.exit(1); });