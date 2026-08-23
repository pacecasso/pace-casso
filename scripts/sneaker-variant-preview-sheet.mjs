import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildGraph, meters } = jiti("./trace-contour.ts");

const root = process.cwd();
const sourceRoot = path.join(root, "tmp-sneaker-raw-georef", "2026-07-18T17-46-40-987Z");
const outDir = path.join(root, "tmp-sneaker-variant-preview", new Date().toISOString().replace(/[:.]/g, "-"));
const M_PER_LAT = 111320;
const PROJ = { lat0: 40.718, lng0: -74.002, mPerLng: M_PER_LAT * Math.cos(40.718 * Math.PI / 180) };
const VARIANTS = [
  ["compact-071", "raw"],
  ["compact-071", "snapped"],
  ["compact-076", "raw"],
  ["compact-076", "snapped"],
  ["compact-082", "raw"],
  ["compact-082", "snapped"],
  ["semantic-fit", "raw"],
  ["semantic-fit", "snapped"],
  ["exact-001-fit", "raw"],
  ["exact-001-fit", "snapped"],
];

function parseGpx(s) {
  return [...s.matchAll(/lat="([^"]+)" lon="([^"]+)"/g)].map((m) => [+m[1], +m[2]]);
}
function llToLocal([lat, lng]) {
  return [(lng - PROJ.lng0) * PROJ.mPerLng, (lat - PROJ.lat0) * M_PER_LAT];
}
function bounds(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
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
function km(route) {
  let m = 0;
  for (let i = 1; i < route.length; i++) m += meters(route[i - 1], route[i]);
  return m / 1000;
}
async function renderMap(osm, route, file, opts) {
  const local = route.map(llToLocal);
  const b = bounds(local), pad = opts.pad, w = opts.w, h = opts.h;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - opts.margin * 2) / (view.maxX - view.minX), (h - opts.margin * 2) / (view.maxY - view.minY));
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
    streets.push(`<path d="${routeD([a, bb], project)}" fill="none" stroke="${opts.street}" stroke-width="${opts.streetWidth}"/>`);
  }
  const rd = routeD(local, project);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${opts.bg}"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="${opts.route}" stroke-width="${opts.routeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
  const sheet = [], summary = [];
  for (const [id, kind] of VARIANTS) {
    const gpx = path.join(sourceRoot, id, `${id}-${kind}.gpx`);
    const route = parseGpx(await fs.readFile(gpx, "utf8"));
    const dir = path.join(outDir, `${id}-${kind}`);
    await fs.mkdir(dir, { recursive: true });
    const image = path.join(dir, "preview.png");
    await renderMap(osm, route, image, { w: 760, h: 520, margin: 18, pad: 140, bg: "#eef2f3", street: "#cfd5d8", streetWidth: 0.75, route: "#c36a35", routeWidth: 2.8 });
    const routeKm = km(route);
    sheet.push({ label: `${id} ${kind} ${(routeKm * 0.621371).toFixed(2)}mi`, file: image });
    summary.push({ id, kind, km: +routeKm.toFixed(2), miles: +(routeKm * 0.621371).toFixed(2), image: path.relative(root, image).replace(/\\/g, "/"), gpx: path.relative(root, gpx).replace(/\\/g, "/") });
  }
  await makeSheet(sheet, path.join(outDir, "variant-sheet.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
