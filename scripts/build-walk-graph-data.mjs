/**
 * Prune the cached OSM walk network (tmp-gas-spike/osm-walk-network.json,
 * gitignored, ~16 MB) into the compact street graph the production
 * street-trace path ships with (lib/data/manhattan-walk-graph.json).
 *
 * Format: { lat: int[], lng: int[], edges: int[] } — coordinates scaled by
 * 1e5 (±1.1 m), edges as flat [aIndex, bIndex, ...] pairs. Only road-type
 * ways (the same set the etch-a-sketch tracer proved out).
 *
 * Run: node scripts/build-walk-graph-data.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";

const ROAD = new Set([
  "residential", "secondary", "primary", "tertiary", "unclassified",
  "living_street", "pedestrian", "footway", "path", "cycleway",
  "secondary_link", "primary_link", "tertiary_link",
]);

const src = JSON.parse(
  await fs.readFile(path.join(process.cwd(), "tmp-gas-spike", "osm-walk-network.json"), "utf8"),
);

const coord = new Map();
for (const e of src.elements) if (e.type === "node") coord.set(e.id, [e.lat, e.lon]);

const used = new Map(); // osm id -> compact index
const lat = [];
const lng = [];
const edgeSet = new Set();
const edges = [];
const indexOf = (id) => {
  let i = used.get(id);
  if (i == null) {
    const c = coord.get(id);
    if (!c) return -1;
    i = lat.length;
    used.set(id, i);
    lat.push(Math.round(c[0] * 1e5));
    lng.push(Math.round(c[1] * 1e5));
  }
  return i;
};

for (const e of src.elements) {
  if (e.type !== "way" || !e.tags?.highway || !ROAD.has(e.tags.highway)) continue;
  for (let i = 1; i < e.nodes.length; i++) {
    const a = indexOf(e.nodes[i - 1]);
    const b = indexOf(e.nodes[i]);
    if (a < 0 || b < 0 || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);
    edges.push(a, b);
  }
}

const out = { scale: 1e5, lat, lng, edges };
const dest = path.join(process.cwd(), "lib", "data", "manhattan-walk-graph.json");
await fs.writeFile(dest, JSON.stringify(out));
const stat = await fs.stat(dest);
console.log(`nodes=${lat.length} edges=${edges.length / 2} -> ${dest} (${(stat.size / 1e6).toFixed(1)} MB)`);
