/**
 * Merge the Manhattan, Brooklyn and Queens packed walk graphs into one
 * NYC-core graph so a design can cross the East River bridges the way the
 * reference lion/tiger routes do. Nodes are OSM coordinates at the same
 * 1e5 scale in every file, so shared nodes merge exactly.
 *
 * Run: node scripts/build-nyc-core-graph.mjs
 * Out: tmp-painter/nyc-core-walk-graph.json (gitignored)
 */
import fs from "node:fs/promises";
import path from "node:path";

const SOURCES = [
  "lib/data/manhattan-walk-graph.json",
  "tmp-wow/brooklyn-walk-graph.json",
  "tmp-wow/queens-walk-graph.json",
];

const index = new Map(); // "lat:lng" -> merged index
const lat = [];
const lng = [];
const edgeSet = new Set();
const edges = [];

for (const src of SOURCES) {
  const g = JSON.parse(await fs.readFile(path.join(process.cwd(), src), "utf8"));
  const local = new Int32Array(g.lat.length);
  for (let i = 0; i < g.lat.length; i++) {
    const key = `${g.lat[i]}:${g.lng[i]}`;
    let k = index.get(key);
    if (k == null) { k = lat.length; index.set(key, k); lat.push(g.lat[i]); lng.push(g.lng[i]); }
    local[i] = k;
  }
  let added = 0;
  for (let e = 0; e < g.edges.length; e += 2) {
    const a = local[g.edges[e]], b = local[g.edges[e + 1]];
    if (a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key); edges.push(a, b); added++;
  }
  console.log(`${src}: ${g.lat.length} nodes, +${added} edges`);
}

await fs.mkdir(path.join(process.cwd(), "tmp-painter"), { recursive: true });
const dest = path.join(process.cwd(), "tmp-painter", "nyc-core-walk-graph.json");
await fs.writeFile(dest, JSON.stringify({ scale: 1e5, lat, lng, edges }));
console.log(`merged: ${lat.length} nodes, ${edges.length / 2} edges -> ${dest}`);
