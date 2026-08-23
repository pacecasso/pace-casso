import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = process.cwd();
const [gpxRel, city = "dc-core"] = process.argv.slice(2);
if (!gpxRel) {
  console.error("Usage: node scripts/render-gpx-street-preview.mjs <route.gpx> [city]");
  process.exit(1);
}

const presets = {
  manhattan: {
    raw: path.join(root, "tmp-gas-spike", "osm-walk-network.json"),
    bounds: { south: 40.700, west: -74.020, north: 40.770, east: -73.958 },
  },
};

async function citySource(name) {
  if (presets[name]) return presets[name];
  const dir = path.join(root, "tmp-city-osm", name);
  return {
    raw: path.join(dir, "osm-walk-network.json"),
    bounds: JSON.parse(await fs.readFile(path.join(dir, "bounds.json"), "utf8")),
  };
}

const walkable = new Set([
  "residential", "secondary", "primary", "tertiary", "unclassified",
  "living_street", "pedestrian", "service", "footway", "path", "cycleway",
  "secondary_link", "primary_link", "tertiary_link",
]);
const M_LAT = 111320;

function mLng(lat) {
  return M_LAT * Math.cos((lat * Math.PI) / 180);
}

function parseGpx(text) {
  const pts = [];
  const re = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g;
  for (let m; (m = re.exec(text));) pts.push([Number(m[1]), Number(m[2])]);
  return pts;
}

function bounds(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

async function loadStreetSegments(src, origin) {
  const raw = JSON.parse(await fs.readFile(src.raw, "utf8"));
  const nodes = new Map();
  for (const el of raw.elements) if (el.type === "node") nodes.set(el.id, [el.lat, el.lon]);
  const toXY = ([lat, lng]) => [(lng - origin[1]) * mLng(origin[0]), (lat - origin[0]) * M_LAT];
  const inBounds = ([lat, lng]) => lat >= src.bounds.south && lat <= src.bounds.north && lng >= src.bounds.west && lng <= src.bounds.east;
  const segs = [];
  for (const el of raw.elements) {
    if (el.type !== "way" || !el.nodes || el.nodes.length < 2) continue;
    const hw = el.tags?.highway;
    if (!walkable.has(hw) && !el.tags?.name) continue;
    for (let i = 1; i < el.nodes.length; i++) {
      const a = nodes.get(el.nodes[i - 1]), b = nodes.get(el.nodes[i]);
      if (!a || !b || !inBounds(a) || !inBounds(b)) continue;
      segs.push([toXY(a), toXY(b)]);
    }
  }
  return segs;
}

async function main() {
  const gpx = parseGpx(await fs.readFile(path.join(root, gpxRel), "utf8"));
  if (gpx.length < 2) throw new Error("GPX has too few trackpoints.");
  const meanLat = gpx.reduce((s, p) => s + p[0], 0) / gpx.length;
  const meanLng = gpx.reduce((s, p) => s + p[1], 0) / gpx.length;
  const origin = [meanLat, meanLng];
  const toXY = ([lat, lng]) => [(lng - origin[1]) * mLng(origin[0]), (lat - origin[0]) * M_LAT];
  const route = gpx.map(toXY);
  const rb = bounds(route);
  const pad = 320;
  const view = { minX: rb.minX - pad, maxX: rb.maxX + pad, minY: rb.minY - pad, maxY: rb.maxY + pad };
  const w = 1100, h = 760;
  const scale = Math.min((w - 40) / (view.maxX - view.minX), (h - 40) / (view.maxY - view.minY));
  const ox = (w - (view.maxX - view.minX) * scale) / 2;
  const oy = (h - (view.maxY - view.minY) * scale) / 2;
  const pr = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const visible = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;

  const src = await citySource(city);
  const streets = [];
  for (const [a, b] of await loadStreetSegments(src, origin)) {
    if (!visible(a) && !visible(b)) continue;
    const [x1, y1] = pr(a), [x2, y2] = pr(b);
    streets.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="#dddddd" stroke-width="1.2" fill="none" stroke-linecap="round"/>`);
  }
  const d = route.map((p, i) => {
    const [x, y] = pr(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const out = gpxRel.replace(/\.gpx$/i, "-thin-preview.png");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${streets.join("\n")}
    <path d="${d}" stroke="#df7d25" stroke-width="4.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(root, out));
  console.log(out);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
