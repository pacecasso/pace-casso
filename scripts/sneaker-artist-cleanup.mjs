import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildGraph, meters } = jiti("./trace-contour.ts");

const root = process.cwd();
const sourceRoot = path.join(root, "tmp-sneaker-raw-georef", "2026-07-18T17-46-40-987Z");
const outDir = path.join(root, "tmp-sneaker-artist-cleanup", new Date().toISOString().replace(/[:.]/g, "-"));
const M_PER_LAT = 111320;
const PROJ = { lat0: 40.718, lng0: -74.002, mPerLng: M_PER_LAT * Math.cos(40.718 * Math.PI / 180) };

const SOURCES = ["compact-071", "compact-076", "compact-082", "exact-001-fit"];
const VARIANTS = [
  { name: "soft", smooth: 1, heelX: 0.90, heelY: 0.80, toeY: 0.90, tongueY: 0.88 },
  { name: "balanced", smooth: 2, heelX: 0.82, heelY: 0.68, toeY: 0.82, tongueY: 0.78 },
  { name: "lean", smooth: 2, heelX: 0.76, heelY: 0.58, toeY: 0.76, tongueY: 0.72 },
  { name: "runner", smooth: 3, heelX: 0.70, heelY: 0.54, toeY: 0.72, tongueY: 0.68 },
];

function parseGpx(s) {
  return [...s.matchAll(/lat="([^"]+)" lon="([^"]+)"/g)].map((m) => [+m[1], +m[2]]);
}
function gpx(name, route) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso artist-cleaned sneaker" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${route.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
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
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function routeKm(route) {
  let m = 0;
  for (let i = 1; i < route.length; i++) m += meters(route[i - 1], route[i]);
  return m / 1000;
}
function movingAverage(points, passes) {
  let out = points.map((p) => p.slice());
  for (let pass = 0; pass < passes; pass++) {
    out = out.map((p, i) => {
      if (i === 0 || i === out.length - 1) return p;
      const prev = out[i - 1], next = out[i + 1];
      return [(prev[0] + p[0] * 2 + next[0]) / 4, (prev[1] + p[1] * 2 + next[1]) / 4];
    });
  }
  return out;
}
function artistClean(route, opts) {
  const local = route.map(llToLocal);
  const b = bounds(local);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const cleaned = local.map(([x, y]) => {
    const u = (x - b.minX) / w;
    const v = (b.maxY - y) / h; // screen-space y: 0 top, 1 bottom
    let sx = x, sy = y;

    const heel = smoothstep(0.18, 0.40, v) * (1 - smoothstep(0.31, 0.42, u));
    if (heel > 0) {
      const cx = b.minX + w * 0.16;
      const cy = b.maxY - h * 0.72;
      sx = lerp(sx, cx + (sx - cx) * opts.heelX, heel);
      sy = lerp(sy, cy + (sy - cy) * opts.heelY, heel);
    }

    const toe = smoothstep(0.70, 0.82, u);
    if (toe > 0) {
      const cy = b.maxY - h * 0.47;
      sy = lerp(sy, cy + (sy - cy) * opts.toeY, toe);
      if (u > 0.88 && v < 0.48) sx = lerp(sx, b.minX + w * 0.93, (u - 0.88) / 0.12 * 0.25);
    }

    const tongue = smoothstep(0.41, 0.48, u) * (1 - smoothstep(0.30, 0.45, v));
    if (tongue > 0) {
      const cy = b.maxY - h * 0.22;
      sy = lerp(sy, cy + (sy - cy) * opts.tongueY, tongue);
    }

    return [sx, sy];
  });
  return movingAverage(cleaned, opts.smooth).map(localToLl);
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
function nearestD(p, segs, radius = 150) {
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
async function renderMap(osm, route, file, label) {
  const local = route.map(llToLocal);
  const b = bounds(local), pad = 140, w = 760, h = 520;
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
  const summary = [], sheet = [];
  for (const source of SOURCES) {
    const route = parseGpx(await fs.readFile(path.join(sourceRoot, source, `${source}-raw.gpx`), "utf8"));
    for (const variant of VARIANTS) {
      const cleaned = artistClean(route, variant);
      const local = cleaned.map(llToLocal);
      const ds = local.map((p) => nearestD(p, segs)).filter(Number.isFinite).sort((a, b) => a - b);
      const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
      const p90 = ds[Math.floor(ds.length * 0.9)] ?? 999;
      const id = `${source}-${variant.name}`;
      const dir = path.join(outDir, id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "route.gpx"), gpx(id, cleaned));
      await renderMap(osm, cleaned, path.join(dir, "preview.png"), `${id} ${(routeKm(cleaned) * 0.621371).toFixed(2)}mi`);
      const row = {
        id,
        source,
        variant: variant.name,
        km: +routeKm(cleaned).toFixed(2),
        miles: +(routeKm(cleaned) * 0.621371).toFixed(2),
        avgStreetM: +avg.toFixed(1),
        p90StreetM: +p90.toFixed(1),
        preview: path.relative(root, path.join(dir, "preview.png")).replace(/\\/g, "/"),
        gpx: path.relative(root, path.join(dir, "route.gpx")).replace(/\\/g, "/"),
      };
      summary.push(row);
      sheet.push({ label: `${row.id} ${row.miles}mi p90${row.p90StreetM}`, file: path.join(dir, "preview.png") });
    }
  }
  await makeSheet(sheet, path.join(outDir, "artist-cleanup-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
