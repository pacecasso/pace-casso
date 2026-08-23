import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildGraph, meters } = jiti("./trace-contour.ts");

const root = process.cwd();
const sourceDir = path.join(root, "tmp-sneaker-street-artist", "2026-07-18T20-25-45-911Z");
const outDir = path.join(root, "tmp-sneaker-street-artist-snap", new Date().toISOString().replace(/[:.]/g, "-"));
const M_PER_LAT = 111320;
const PROJ = { lat0: 40.718, lng0: -74.002, mPerLng: M_PER_LAT * Math.cos(40.718 * Math.PI / 180) };

function parseGpx(s) {
  return [...s.matchAll(/lat="([^"]+)" lon="([^"]+)"/g)].map((m) => [+m[1], +m[2]]);
}
function gpx(name, route) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso street-artist snapped sneaker" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${route.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}
function llToLocal([lat, lng]) {
  return [(lng - PROJ.lng0) * PROJ.mPerLng, (lat - PROJ.lat0) * M_PER_LAT];
}
function localToLl([x, y]) {
  return [PROJ.lat0 + y / M_PER_LAT, PROJ.lng0 + x / PROJ.mPerLng];
}
function bounds(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
function buildSegments(osm) {
  const seen = new Set(), segs = [];
  for (const [from, entries] of osm.adj.entries()) for (const edge of entries) {
    const key = edgeKey(from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    const a = llToLocal(osm.coord.get(from)), b = llToLocal(osm.coord.get(edge.to));
    segs.push({ a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
  }
  return segs;
}
function projectPoint(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], len2 = vx * vx + vy * vy;
  if (len2 <= 0) return { q: a, d: Math.hypot(p[0] - a[0], p[1] - a[1]) };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const q = [a[0] + vx * t, a[1] + vy * t];
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}
function nearestProjection(p, segs, radius = 180) {
  let best = { q: p, d: Infinity };
  for (const s of segs) {
    if (p[0] < s.minX - radius || p[0] > s.maxX + radius || p[1] < s.minY - radius || p[1] > s.maxY + radius) continue;
    const hit = projectPoint(p, s.a, s.b);
    if (hit.d < best.d) best = hit;
  }
  return best;
}
function routeKm(route) {
  let m = 0;
  for (let i = 1; i < route.length; i++) m += meters(route[i - 1], route[i]);
  return m / 1000;
}
function continuity(route) {
  let max = 0, g50 = 0, g100 = 0;
  for (let i = 1; i < route.length; i++) {
    const d = meters(route[i - 1], route[i]);
    max = Math.max(max, d);
    if (d > 50) g50++;
    if (d > 100) g100++;
  }
  return { maxStep: +max.toFixed(1), gapsOver50: g50, gapsOver100: g100 };
}
function routeD(points, project) {
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}
async function render(osm, route, file, label) {
  const local = route.map(llToLocal);
  const b = bounds(local), pad = 150, w = 760, h = 520;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - 36) / (view.maxX - view.minX), (h - 36) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const streets = [], seen = new Set();
  for (const [from, entries] of osm.adj.entries()) for (const edge of entries) {
    const key = edgeKey(from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    const a = llToLocal(osm.coord.get(from)), bb = llToLocal(osm.coord.get(edge.to));
    if (!inView(a) && !inView(bb)) continue;
    streets.push(`<path d="${routeD([a, bb], project)}" fill="none" stroke="#cfd5d8" stroke-width="0.75"/>`);
  }
  const rd = routeD(local, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#eef2f3"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="#c36a35" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><text x="16" y="30" font-family="Arial" font-size="18" font-weight="700" fill="#111">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
async function makeSheet(items, file) {
  const tw = 520, th = 330, comps = [];
  for (let i = 0; i < items.length; i++) {
    const left = (i % 2) * tw, top = Math.floor(i / 2) * th;
    const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><rect width="100%" height="100%" fill="#f7f4ee"/><text x="16" y="28" font-family="Arial" font-size="18" font-weight="700">${items[i].label}</text></svg>`);
    const im = await sharp(items[i].file).resize({ width: tw - 26, height: th - 48, fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    comps.push({ input: bg, left, top });
    comps.push({ input: im.data, left: left + Math.round((tw - im.info.width) / 2), top: top + 40 + Math.round((th - 50 - im.info.height) / 2) });
  }
  await sharp({ create: { width: tw * 2, height: th * Math.ceil(items.length / 2), channels: 4, background: "#ece7dd" } }).composite(comps).png().toFile(file);
}
async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const osm = await buildGraph();
  const segs = buildSegments(osm);
  const ids = ["clean-4lace", "clean-5lace", "low-4lace", "long-5lace"];
  const sheet = [], summary = [];
  for (const id of ids) {
    const raw = parseGpx(await fs.readFile(path.join(sourceDir, id, "route.gpx"), "utf8"));
    const hits = raw.map((p) => nearestProjection(llToLocal(p), segs));
    const snapped = hits.map((h) => localToLl(h.q));
    const ds = hits.map((h) => h.d).sort((a, b) => a - b);
    const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
    const p90 = ds[Math.floor(ds.length * 0.9)] ?? 999;
    const dir = path.join(outDir, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "snapped.gpx"), gpx(`${id}-snapped`, snapped));
    await render(osm, snapped, path.join(dir, "snapped-preview.png"), `${id} snapped ${(routeKm(snapped) * 0.621371).toFixed(2)}mi`);
    const row = { id, km: +routeKm(snapped).toFixed(2), miles: +(routeKm(snapped) * 0.621371).toFixed(2), avg: +avg.toFixed(1), p90: +p90.toFixed(1), ...continuity(snapped), preview: path.relative(root, path.join(dir, "snapped-preview.png")).replace(/\\/g, "/"), gpx: path.relative(root, path.join(dir, "snapped.gpx")).replace(/\\/g, "/") };
    summary.push(row);
    sheet.push({ label: `${id} ${row.miles}mi p90${row.p90} max${row.maxStep}`, file: path.join(dir, "snapped-preview.png") });
  }
  await makeSheet(sheet, path.join(outDir, "snapped-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
