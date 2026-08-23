import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildGraph, meters } = jiti("./trace-contour.ts");

const root = process.cwd();
const sourceDir = path.join(root, "tmp-sneaker-raw-georef", "2026-07-18T17-46-40-987Z", "semantic-fit");
const outDir = path.join(root, "tmp-sneaker-polished-preview", new Date().toISOString().replace(/[:.]/g, "-"));
const M_PER_LAT = 111320;
const PROJ = { lat0: 40.718, lng0: -74.002, mPerLng: M_PER_LAT * Math.cos(40.718 * Math.PI / 180) };

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
function totalKm(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += meters(points[i - 1], points[i]);
  return m / 1000;
}
function xmlEscape(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
async function mapSvg(osm, route, opts) {
  const local = route.map(llToLocal);
  const b = bounds(local), pad = opts.pad ?? 240, w = opts.w, h = opts.h;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - opts.margin * 2) / (view.maxX - view.minX), (h - opts.margin * 2) / (view.maxY - view.minY));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const streets = [], seen = new Set();
  for (const [from, entries] of osm.adj.entries()) {
    for (const edge of entries) {
      const key = edgeKey(from, edge.to);
      if (seen.has(key)) continue;
      seen.add(key);
      const a = llToLocal(osm.coord.get(from)), bb = llToLocal(osm.coord.get(edge.to));
      if (!inView(a) && !inView(bb)) continue;
      streets.push(`<path d="${routeD([a, bb], project)}" fill="none" stroke="${opts.street}" stroke-width="${opts.streetWidth}"/>`);
    }
  }
  const rd = routeD(local, project);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${opts.bg}"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="${opts.shadow}" stroke-width="${opts.routeWidth + 4}" stroke-linecap="round" stroke-linejoin="round"/><path d="${rd}" fill="none" stroke="${opts.route}" stroke-width="${opts.routeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const route = parseGpx(await fs.readFile(path.join(sourceDir, "semantic-fit-snapped.gpx"), "utf8"));
  const osm = await buildGraph();
  const km = totalKm(route);
  const miles = km * 0.621371;
  const cleanSvg = await mapSvg(osm, route, { w: 1200, h: 820, margin: 34, pad: 250, bg: "#ffffff", street: "#d8d8d8", streetWidth: 1.2, shadow: "#111111", route: "#ef1744", routeWidth: 4 });
  await sharp(Buffer.from(cleanSvg)).png().toFile(path.join(outDir, "clean-map.png"));
  const cardMap = await mapSvg(osm, route, { w: 390, h: 258, margin: 0, pad: 120, bg: "#edf1f3", street: "#cfd5d8", streetWidth: 0.65, shadow: "#b45d2f", route: "#c56b32", routeWidth: 2.2 });
  const cardMapPng = await sharp(Buffer.from(cardMap)).png().toBuffer();
  const header = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="198"><rect width="100%" height="100%" fill="#fff"/><circle cx="35" cy="27" r="16" fill="#e7e0d6"/><text x="60" y="26" font-family="Arial" font-size="13" font-weight="700" fill="#222">PaceCasso Runner</text><text x="60" y="43" font-family="Arial" font-size="11" fill="#555">Today at 11:26 AM · Manhattan, New York</text><text x="23" y="88" font-family="Arial" font-size="20" font-weight="700" fill="#111">PUMA Project 3</text><text x="23" y="116" font-family="Arial" font-size="13" fill="#333">Attempt at FAST-R NITRO Elite 3 GPS art</text><text x="23" y="147" font-family="Arial" font-size="11" fill="#777">Distance</text><text x="156" y="147" font-family="Arial" font-size="11" fill="#777">Pace</text><text x="256" y="147" font-family="Arial" font-size="11" fill="#777">Time</text><text x="23" y="170" font-family="Arial" font-size="18" font-weight="700" fill="#111">${miles.toFixed(2)} mi</text><text x="156" y="170" font-family="Arial" font-size="18" font-weight="700" fill="#111">8:01 /mi</text><text x="256" y="170" font-family="Arial" font-size="18" font-weight="700" fill="#111">1h 30m</text></svg>`;
  const footer = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="72"><rect width="100%" height="100%" fill="#fff"/><circle cx="26" cy="30" r="10" fill="#d0d0d0"/><circle cx="39" cy="30" r="10" fill="#b8c0c8"/><circle cx="52" cy="30" r="10" fill="#d6c3a9"/><text x="74" y="35" font-family="Arial" font-size="11" fill="#555">68 gave kudos</text><text x="304" y="35" font-family="Arial" font-size="11" fill="#555">11 comments</text></svg>`;
  await sharp({ create: { width: 390, height: 528, channels: 4, background: "#fff" } })
    .composite([
      { input: Buffer.from(header), left: 0, top: 0 },
      { input: cardMapPng, left: 0, top: 198 },
      { input: Buffer.from(footer), left: 0, top: 456 },
    ])
    .png()
    .toFile(path.join(outDir, "activity-card.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({
    source: path.relative(root, sourceDir).replace(/\\/g, "/"),
    cleanMap: path.relative(root, path.join(outDir, "clean-map.png")).replace(/\\/g, "/"),
    activityCard: path.relative(root, path.join(outDir, "activity-card.png")).replace(/\\/g, "/"),
    km: +km.toFixed(2),
    miles: +miles.toFixed(2),
  }, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
