import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildGraph, meters } = jiti("./trace-contour.ts");

const root = process.cwd();
const outDir = path.join(root, "tmp-sneaker-street-artist", new Date().toISOString().replace(/[:.]/g, "-"));
const M_PER_LAT = 111320;
const PROJ = { lat0: 40.718, lng0: -74.002, mPerLng: M_PER_LAT * Math.cos(40.718 * Math.PI / 180) };
const sourceGpx = path.join(root, "tmp-sneaker-raw-georef", "2026-07-18T17-46-40-987Z", "exact-001-fit", "exact-001-fit-raw.gpx");

function parseGpx(s) {
  return [...s.matchAll(/lat="([^"]+)" lon="([^"]+)"/g)].map((m) => [+m[1], +m[2]]);
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
function bez(p0, p1, p2, p3, n = 26) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
      u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1],
    ]);
  }
  return out;
}
function line(a, b, n = 12) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
  return out;
}
function routeKm(route) {
  let m = 0;
  for (let i = 1; i < route.length; i++) m += meters(route[i - 1], route[i]);
  return m / 1000;
}
function normToLocalFactory(baseRoute, xPad = 0, yPad = 0) {
  const local = baseRoute.map(llToLocal);
  const b = bounds(local);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  return ([u, v]) => [b.minX + w * (xPad + u * (1 - xPad * 2)), b.maxY - h * (yPad + v * (1 - yPad * 2))];
}
function makeStrokes(style) {
  const outline = [
    ...bez([0.08, 0.50], [0.10, 0.28], [0.15, 0.20], [0.22, 0.21], 18),
    ...bez([0.22, 0.21], [0.28, 0.22], [0.33, 0.28], [0.39, 0.30], 12).slice(1),
    ...bez([0.39, 0.30], [0.46, 0.18], [0.48, 0.10], [0.52, 0.10], 13).slice(1),
    ...bez([0.52, 0.10], [0.62, 0.14], [0.72, 0.24], [0.82, 0.31], 16).slice(1),
    ...bez([0.82, 0.31], [0.93, 0.33], [0.98, 0.39], [0.96, 0.51], 16).slice(1),
    ...bez([0.96, 0.51], [0.94, 0.64], [0.86, 0.67], [0.72, 0.67], 18).slice(1),
    ...bez([0.72, 0.67], [0.54, 0.69], [0.37, 0.75], [0.24, 0.75], 20).slice(1),
    ...bez([0.24, 0.75], [0.15, 0.75], [0.09, 0.67], [0.08, 0.50], 18).slice(1),
  ];
  const sole = [
    ...bez([0.10, 0.68], [0.28, 0.65], [0.48, 0.61], [0.71, 0.57], 22),
    ...bez([0.71, 0.57], [0.84, 0.55], [0.94, 0.50], [0.97, 0.45], 14).slice(1),
  ];
  const upper = [
    ...line([0.10, 0.42], [0.38, 0.41], 14),
    ...bez([0.38, 0.41], [0.46, 0.37], [0.54, 0.36], [0.62, 0.39], 14).slice(1),
    ...line([0.62, 0.39], [0.82, 0.42], 12).slice(1),
  ];
  const collar = [
    ...bez([0.38, 0.30], [0.43, 0.31], [0.47, 0.35], [0.50, 0.42], 10),
    ...bez([0.50, 0.42], [0.54, 0.36], [0.56, 0.29], [0.58, 0.22], 10).slice(1),
  ];
  const heelLines = [
    line([0.09, 0.34], [0.34, 0.34], 12),
    line([0.09, 0.48], [0.34, 0.49], 12),
  ];
  const laces = [];
  const laceCount = style.laces;
  for (let i = 0; i < laceCount; i++) {
    const x = 0.50 + i * 0.055;
    laces.push([
      ...bez([x, 0.31], [x + 0.01, 0.38], [x - 0.02, 0.43], [x - 0.05, 0.45], 8),
      ...bez([x - 0.05, 0.45], [x - 0.01, 0.49], [x + 0.04, 0.45], [x + 0.06, 0.37], 8).slice(1),
    ]);
  }
  return [outline, sole, upper, collar, ...heelLines, ...laces];
}
function connectStrokes(strokes) {
  const remaining = strokes.map((s) => s.slice());
  const route = remaining.shift();
  while (remaining.length) {
    const last = route[route.length - 1];
    let best = 0, rev = false, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      const d0 = Math.hypot(last[0] - s[0][0], last[1] - s[0][1]);
      const d1 = Math.hypot(last[0] - s[s.length - 1][0], last[1] - s[s.length - 1][1]);
      if (d0 < bd) { bd = d0; best = i; rev = false; }
      if (d1 < bd) { bd = d1; best = i; rev = true; }
    }
    const next = remaining.splice(best, 1)[0];
    if (rev) next.reverse();
    route.push(...next);
  }
  return route;
}
function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
function pointToSeg(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], len2 = vx * vx + vy * vy;
  if (len2 <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
}
function buildSegments(osm) {
  const segs = [], seen = new Set();
  for (const [from, entries] of osm.adj.entries()) for (const edge of entries) {
    const key = edgeKey(from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    const a = llToLocal(osm.coord.get(from)), b = llToLocal(osm.coord.get(edge.to));
    segs.push({ a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
  }
  return segs;
}
function nearestD(p, segs, radius = 180) {
  let best = Infinity;
  for (const s of segs) {
    if (p[0] < s.minX - radius || p[0] > s.maxX + radius || p[1] < s.minY - radius || p[1] > s.maxY + radius) continue;
    best = Math.min(best, pointToSeg(p, s.a, s.b));
  }
  return best;
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
function gpx(name, route) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso street-artist sneaker" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${route.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}
async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const baseRoute = parseGpx(await fs.readFile(sourceGpx, "utf8"));
  const osm = await buildGraph();
  const segs = buildSegments(osm);
  const sheet = [], summary = [];
  const styles = [
    { id: "clean-4lace", laces: 4, xPad: 0.03, yPad: 0.06 },
    { id: "clean-5lace", laces: 5, xPad: 0.03, yPad: 0.06 },
    { id: "low-4lace", laces: 4, xPad: 0.05, yPad: 0.12 },
    { id: "long-5lace", laces: 5, xPad: 0.00, yPad: 0.08 },
  ];
  for (const style of styles) {
    const mapPoint = normToLocalFactory(baseRoute, style.xPad, style.yPad);
    const localRoute = connectStrokes(makeStrokes(style)).map(mapPoint);
    const route = localRoute.map(localToLl);
    const ds = localRoute.map((p) => nearestD(p, segs)).filter(Number.isFinite).sort((a, b) => a - b);
    const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
    const p90 = ds[Math.floor(ds.length * 0.9)] ?? 999;
    const dir = path.join(outDir, style.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "route.gpx"), gpx(style.id, route));
    await render(osm, route, path.join(dir, "preview.png"), `${style.id} ${(routeKm(route) * 0.621371).toFixed(2)}mi`);
    const row = {
      id: style.id,
      km: +routeKm(route).toFixed(2),
      miles: +(routeKm(route) * 0.621371).toFixed(2),
      avgStreetM: +avg.toFixed(1),
      p90StreetM: +p90.toFixed(1),
      preview: path.relative(root, path.join(dir, "preview.png")).replace(/\\/g, "/"),
      gpx: path.relative(root, path.join(dir, "route.gpx")).replace(/\\/g, "/"),
    };
    summary.push(row);
    sheet.push({ label: `${row.id} ${row.miles}mi p90${row.p90StreetM}`, file: path.join(dir, "preview.png") });
  }
  await makeSheet(sheet, path.join(outDir, "street-artist-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
