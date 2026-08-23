import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildGraph, nearestNode, corridorPath, meters } = jiti("./trace-contour.ts");

const root = process.cwd();
const sourceDir = path.join(root, "tmp-sneaker-transform", "2026-07-18T17-05-12-343Z", "tf-012");
const outDir = path.join(root, "tmp-sneaker-transform-gap-routed", new Date().toISOString().replace(/[:.]/g, "-"));
const M_PER_LAT = 111320;
const PROJ = { lat0: 40.718, lng0: -74.002, mPerLng: M_PER_LAT * Math.cos(40.718 * Math.PI / 180) };
function llToLocal([lat, lng]) { return [(lng - PROJ.lng0) * PROJ.mPerLng, (lat - PROJ.lat0) * M_PER_LAT]; }
function bounds(points) { const xs = points.map(p => p[0]); const ys = points.map(p => p[1]); return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }; }
function parseGpx(s) { return [...s.matchAll(/lat="([^"]+)" lon="([^"]+)"/g)].map(m => [+m[1], +m[2]]); }
function totalKm(chain) { let m = 0; for (let i = 1; i < chain.length; i++) m += meters(chain[i - 1], chain[i]); return m / 1000; }
function routeD(points, project) { return points.map((p, i) => { const [x, y] = project(p); return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" "); }
function edgeKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }
async function renderBlind(chain, file) {
  const route = chain.map(llToLocal), b = bounds(route), pad = 90, w = 900, h = 560;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - 50) / (view.maxX - view.minX), (h - 50) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${routeD(route, project)}" fill="none" stroke="#111" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
async function renderMap(g, chain, file, label) {
  const route = chain.map(llToLocal), b = bounds(route), pad = 260, w = 1200, h = 820;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const streets = [], seen = new Set();
  for (const [from, entries] of g.adj.entries()) for (const e of entries) {
    const key = edgeKey(from, e.to); if (seen.has(key)) continue; seen.add(key);
    const a = llToLocal(g.coord.get(from)), b2 = llToLocal(g.coord.get(e.to));
    if (!inView(a) && !inView(b2)) continue;
    streets.push(`<path d="${routeD([a, b2], project)}" fill="none" stroke="#d7d7d7" stroke-width="1.4"/>`);
  }
  const rd = routeD(route, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><path d="${rd}" fill="none" stroke="#ef1744" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><text x="34" y="50" font-family="Arial" font-size="22" font-weight="700">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
function gpx(name, chain) { return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso gap-routed sneaker" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`; }
function continuity(chain) { let maxStep = 0, gaps = 0; for (let i = 1; i < chain.length; i++) { const d = meters(chain[i - 1], chain[i]); maxStep = Math.max(maxStep, d); if (d > 80) gaps++; } return { maxStep: +maxStep.toFixed(1), gapsOver80: gaps }; }
async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const raw = parseGpx(await fs.readFile(path.join(sourceDir, "tf-012.gpx"), "utf8"));
  const graph = await buildGraph();
  const variants = [80, 120, 180, 260];
  const summary = [];
  for (const threshold of variants) {
    const chain = [raw[0]];
    let routedGaps = 0, failed = 0;
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1], b = raw[i];
      const d = meters(a, b);
      if (d <= threshold) { chain.push(b); continue; }
      const na = nearestNode(graph, a), nb = nearestNode(graph, b);
      const ids = na >= 0 && nb >= 0 ? (corridorPath(graph, na, nb, raw, 12, 180) || corridorPath(graph, na, nb, raw, 4, 420) || corridorPath(graph, na, nb, raw, 0, 1e7)) : null;
      if (!ids || ids.length < 2) { failed++; chain.push(b); continue; }
      routedGaps++;
      for (const id of ids) {
        const p = graph.coord.get(id);
        if (!p) continue;
        if (!chain.length || meters(chain[chain.length - 1], p) > 1) chain.push(p);
      }
    }
    const id = `gap-route-${threshold}`;
    const dir = path.join(outDir, id); await fs.mkdir(dir, { recursive: true });
    const km = totalKm(chain), cont = continuity(chain);
    await renderBlind(chain, path.join(dir, "route-blind.png"));
    await renderMap(graph, chain, path.join(dir, "route-map.png"), `${id} ${km.toFixed(1)}km max ${cont.maxStep}m gaps ${cont.gapsOver80}`);
    await fs.writeFile(path.join(dir, `${id}.gpx`), gpx(id, chain));
    summary.push({ id, km: +km.toFixed(2), miles: +(km * 0.621371).toFixed(2), routedGaps, failed, ...cont, blind: path.relative(root, path.join(dir, "route-blind.png")).replace(/\\/g, "/"), map: path.relative(root, path.join(dir, "route-map.png")).replace(/\\/g, "/"), gpx: path.relative(root, path.join(dir, `${id}.gpx`)).replace(/\\/g, "/") });
  }
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}
main().catch(e => { console.error(e); process.exit(1); });