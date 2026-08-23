import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph, compileContourToLattice } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const outDir = path.join(root, "tmp-logo-proof", "fresh-three");
const M_PER_LAT = 111320;
const origin = [40.744061, -74.006811];
const X = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };

function toLatLng([x, y]) {
  const e = x * X.e + y * Y.e;
  const n = x * X.n + y * Y.n;
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng];
}
function toLocal([lat, lng]) {
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng;
  const det = X.e * Y.n - Y.e * X.n;
  return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det];
}
function densify(points, maxStep = 50) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]; out.push(a);
    const b = points[i + 1]; if (!b) continue;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(d / maxStep));
    for (let s = 1; s < n; s++) {
      const t = s / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
function arc(cx, cy, rx, ry, a0, a1, n = 28) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}
function bounds(points) {
  const xs = points.map(p => p[0]); const ys = points.map(p => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function routeD(points, project) {
  return points.map((p,i) => { const [x,y] = project(p); return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ");
}
function projectFactory(points, w, h, pad = 40) {
  const b = bounds(points);
  const sx = (w - pad * 2) / Math.max(1, b.maxX - b.minX);
  const sy = (h - pad * 2) / Math.max(1, b.maxY - b.minY);
  const s = Math.min(sx, sy);
  const usedW = (b.maxX - b.minX) * s;
  const usedH = (b.maxY - b.minY) * s;
  const ox = (w - usedW) / 2;
  const oy = (h - usedH) / 2;
  return ([x,y]) => [ox + (x - b.minX) * s, oy + (b.maxY - y) * s];
}
function stairs(a, b, steps = 6, startHorizontal = true) {
  const pts = [a];
  let cur = [...a];
  for (let i = 1; i <= steps; i++) {
    const nx = a[0] + ((b[0] - a[0]) * i) / steps;
    const ny = a[1] + ((b[1] - a[1]) * i) / steps;
    if ((i % 2 === 1) === startHorizontal) {
      cur = [nx, cur[1]]; pts.push([...cur]);
      cur = [cur[0], ny]; pts.push([...cur]);
    } else {
      cur = [cur[0], ny]; pts.push([...cur]);
      cur = [nx, cur[1]]; pts.push([...cur]);
    }
  }
  return pts;
}
function stravaSketch() {
  const upper = [[180, 0], [360, 360], [540, 720], [700, 1080], [820, 1440], [960, 1080], [1120, 720], [1300, 360], [1480, 0]];
  const connector = [[1480, 0], [1160, 0], [1040, -210]];
  const lower = [[1040, -210], [880, -520], [760, -900], [640, -520], [480, -210], [1040, -210]];
  return densify([...upper, ...connector, ...lower].map(([x, y]) => [x + 950, y + 1900]), 42);
}

function chanelSketch() {
  const leftC = arc(760, 760, 540, 390, Math.PI * 0.22, Math.PI * 1.78, 34);
  const bridge = [[585, 390], [980, 760], [585, 1130]];
  const rightC = arc(1120, 760, 540, 390, Math.PI * 1.22, Math.PI * -0.22, 34);
  return densify([...leftC, ...bridge, ...rightC], 48);
}

function stonesSketch() {
  const lip = [
    [220, 900], [440, 1240], [780, 1460], [1080, 1380], [1340, 1500], [1740, 1320], [2040, 960],
    [1920, 690], [1630, 535], [1300, 515], [1040, 625], [780, 530], [470, 610], [220, 900],
    [330, 520], [650, 250], [1040, 145], [1440, 215], [1780, 500], [2040, 960]
  ];
  const mouth = [[500, 900], [820, 1040], [1080, 980], [1360, 1050], [1680, 900]];
  const tongue = [[1080, 980], [930, 680], [800, 310], [850, -120], [1060, -520], [1330, -700], [1540, -510], [1480, -60], [1360, 360], [1360, 1050]];
  return densify([...lip, ...mouth, ...tongue], 46);
}

const designs = [
  { id: "strava", source: "strava.png", title: "Strava", sketch: stravaSketch(), opts: { sampleMeters: 30, pinRadiusMeters: 230, minPinSpacingMeters: 34, maxLegDetourRatio: 9.0, maxLegDetourSlackMeters: 900 } },
  { id: "chanel", source: "chanel.webp", title: "Chanel", sketch: chanelSketch(), opts: { sampleMeters: 30, pinRadiusMeters: 175, minPinSpacingMeters: 44, maxLegDetourRatio: 3.2, maxLegDetourSlackMeters: 300 } },
  { id: "stones", source: "stones.webp", title: "Stones", sketch: stonesSketch(), opts: { sampleMeters: 32, pinRadiusMeters: 185, minPinSpacingMeters: 44, maxLegDetourRatio: 3.4, maxLegDetourSlackMeters: 340 } },
];

function nearestGraphNode(graph, ll, maxM = 360) {
  let best = -1, bestD = maxM;
  for (let i = 0; i < graph.nodes.length; i++) {
    const a = toLocal(graph.nodes[i]);
    const b = toLocal(ll);
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
function shortestNodePath(graph, from, to) {
  if (from === to) return { path: [from], meters: 0 };
  const target = graph.nodes[to];
  const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  const open = [[0, from]];
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === to) break;
    if (done.has(cur)) continue;
    done.add(cur);
    const cd = dist.get(cur) ?? Infinity;
    for (const e of graph.adj.get(cur) ?? []) {
      const nd = cd + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd); prev.set(e.to, cur);
        const h = Math.hypot(...toLocal(graph.nodes[e.to]).map((v, i) => v - toLocal(target)[i]));
        open.push([nd + h, e.to]);
      }
    }
  }
  if (!prev.has(to)) return null;
  const path = [];
  let cur = to;
  while (cur !== undefined) { path.push(cur); cur = prev.get(cur); }
  path.reverse();
  return { path, meters: dist.get(to) ?? 0 };
}
function appendNodePath(chain, graph, nodePath) {
  for (let i = 0; i < nodePath.length; i++) {
    const node = graph.nodes[nodePath[i]];
    if (i > 0) {
      const from = nodePath[i - 1];
      const entry = (graph.adj.get(from) ?? []).find(e => e.to === nodePath[i]);
      if (entry) for (const v of entry.via ?? []) chain.push(v);
    }
    const last = chain[chain.length - 1];
    if (!last || last[0] !== node[0] || last[1] !== node[1]) chain.push(node);
  }
}
function forcedRoute(points, graph) {
  const targets = [];
  for (const p of points) {
    const n = nearestGraphNode(graph, toLatLng(p));
    if (n < 0) continue;
    if (targets[targets.length - 1] !== n) targets.push(n);
  }
  const chain = [];
  let total = 0, legCount = 0, failed = 0;
  if (!targets.length) return null;
  chain.push(graph.nodes[targets[0]]);
  for (let i = 1; i < targets.length; i++) {
    const leg = shortestNodePath(graph, targets[i - 1], targets[i]);
    if (!leg) { failed++; continue; }
    appendNodePath(chain, graph, leg.path);
    total += leg.meters; legCount++;
  }
  if (legCount < 3) return null;
  return { chain, km: total / 1000, legCount, skippedPins: failed, meanDeviationMeters: 0, maxDeviationMeters: 0 };
}

async function renderBlind(points, file, label = "") {
  const w = 1000, h = 760, pr = projectFactory(points, w, h, 56), d = routeD(points, pr);
  const text = label ? `<text x="28" y="42" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="none" stroke="#111" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>${text}</svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toFile(file);
}
async function renderMap(chain, graph, file, label) {
  const route = chain.map(toLocal), rb = bounds(route), padM = 300;
  const w = 1180, h = 860;
  const view = { minX: rb.minX - padM, maxX: rb.maxX + padM, minY: rb.minY - padM, maxY: rb.maxY + padM };
  const s = Math.min((w - 72) / Math.max(1, view.maxX - view.minX), (h - 72) / Math.max(1, view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * s, usedH = (view.maxY - view.minY) * s;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x,y]) => [ox + (x - view.minX) * s, oy + (view.maxY - y) * s];
  const inView = ([x,y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const seen = new Set(), streets = [];
  for (const [from, entries] of graph.adj.entries()) for (const edge of entries) {
    const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
    if (seen.has(key)) continue; seen.add(key);
    const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(toLocal);
    if (!pts.some(inView)) continue;
    streets.push(`<path d="${routeD(pts, project)}" fill="none" stroke="#d7d7d7" stroke-width="1.7"/>`);
  }
  const d = routeD(route, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w-48}" height="${h-48}" fill="#fff"/>${streets.join("\n")}<path d="${d}" fill="none" stroke="#771225" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#ef1744" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><text x="34" y="52" font-family="Arial" font-size="22" font-weight="700" fill="#111">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toFile(file);
}
async function comparison(source, routeFile, file, title, metrics) {
  const w = 1600, h = 760;
  const src = await sharp(path.join(root, source)).resize(720, 560, { fit: "contain", background: "#fff" }).png().toBuffer();
  const rte = await sharp(routeFile).resize(720, 560, { fit: "contain", background: "#fff" }).png().toBuffer();
  const base = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f8f5ef"/><text x="40" y="46" font-family="Arial" font-size="28" font-weight="700" fill="#111">${title}</text><text x="40" y="78" font-family="Arial" font-size="16" fill="#555">${metrics}</text><text x="40" y="705" font-family="Arial" font-size="15" fill="#555">source logo</text><text x="840" y="705" font-family="Arial" font-size="15" fill="#555">generated runnable Manhattan route</text></svg>`);
  await sharp(base).composite([{ input: src, left: 40, top: 110 }, { input: rte, left: 840, top: 110 }]).jpeg({ quality: 94 }).toFile(file);
}
function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso logo proof" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}
async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const graph = buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8")));
  const summary = [];
  for (const d of designs) {
    const dir = path.join(outDir, d.id); await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(path.join(root, d.source), path.join(dir, `source${path.extname(d.source)}`));
    await renderBlind(d.sketch, path.join(dir, "1-intended-sketch.jpg"), `${d.title} intended sketch`);
    let best = null;
    for (const scale of [0.9, 1.05, 1.22, 1.42]) {
      const b = bounds(d.sketch);
      const pts = d.sketch.map(([x,y]) => [(x - (b.minX+b.maxX)/2) * scale + (b.minX+b.maxX)/2, (y - (b.minY+b.maxY)/2) * scale + (b.minY+b.maxY)/2]);
      const result = forcedRoute(pts, graph) ?? compileContourToLattice(pts.map(toLatLng), graph, d.opts);
      if (!result) continue;
      const score = (result.meanDeviationMeters ?? 0) + result.skippedPins * 95 + Math.max(0, (result.maxDeviationMeters ?? 0) - 210) * 0.6;
      if (!best || score < best.score) best = { result, pts, scale, score };
    }
    if (!best) { summary.push({ id: d.id, ok: false }); continue; }
    const blind = path.join(dir, "2-route-blind.jpg");
    const map = path.join(dir, "3-route-map.jpg");
    await renderBlind(best.result.chain.map(toLocal), blind, `${d.title} ${best.result.km.toFixed(1)} km`);
    await renderMap(best.result.chain, graph, map, `${d.title} ${best.result.km.toFixed(1)} km`);
    const metrics = `${best.result.km.toFixed(1)} km, ${best.result.legCount} street legs, forced street waypoints, skipped pins ${best.result.skippedPins}`;
    await comparison(d.source, blind, path.join(dir, "4-source-vs-route.jpg"), d.title, metrics);
    await fs.writeFile(path.join(dir, `${d.id}.gpx`), gpx(d.title, best.result.chain));
    await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(best.result, null, 2));
    summary.push({ id: d.id, ok: true, km: +best.result.km.toFixed(2), meanDeviationMeters: +(best.result.meanDeviationMeters ?? 0).toFixed(1), maxDeviationMeters: +(best.result.maxDeviationMeters ?? 0).toFixed(1), legCount: best.result.legCount, skippedPins: best.result.skippedPins, blindImage: path.relative(root, blind).replace(/\\/g,"/"), mapImage: path.relative(root, map).replace(/\\/g,"/"), comparisonImage: path.relative(root, path.join(dir, "4-source-vs-route.jpg")).replace(/\\/g,"/") });
  }
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
