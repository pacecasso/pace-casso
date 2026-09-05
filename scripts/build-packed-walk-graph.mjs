/**
 * Prune an Overpass walk-network dump into the packed graph format used by
 * lib/data/manhattan-walk-graph.json ({ scale, lat[], lng[], edges[] }).
 * Generic version of build-walk-graph-data.mjs: takes input and output paths.
 *
 * Run: node scripts/build-packed-walk-graph.mjs <osm-walk-network.json> <out.json>
 */
import fs from "node:fs/promises";

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error("usage: node scripts/build-packed-walk-graph.mjs <osm-walk-network.json> <out.json>");
  process.exit(1);
}
const ROAD = new Set([
  "residential", "secondary", "primary", "tertiary", "unclassified",
  "living_street", "pedestrian", "footway", "path", "cycleway",
  "secondary_link", "primary_link", "tertiary_link",
]);
const data = JSON.parse(await fs.readFile(src, "utf8"));
const coord = new Map();
for (const e of data.elements) if (e.type === "node") coord.set(e.id, [e.lat, e.lon]);
const used = new Map();
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
for (const e of data.elements) {
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
await fs.writeFile(dest, JSON.stringify({ scale: 1e5, lat, lng, edges }));
console.log(`${dest}: ${lat.length} nodes, ${edges.length / 2} edges`);
