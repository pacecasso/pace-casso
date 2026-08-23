import fs from "node:fs/promises";
import path from "node:path";

const PRESETS = {
  manhattan: { south: 40.698, west: -74.02, north: 40.882, east: -73.958 },
  brooklyn: { south: 40.57, west: -74.03, north: 40.74, east: -73.855 },
  chicago: { south: 41.79, west: -87.74, north: 41.99, east: -87.58 },
  sf: { south: 37.73, west: -122.52, north: 37.81, east: -122.385 },
  dc: { south: 38.82, west: -77.12, north: 38.99, east: -76.91 },
};
const STREET_HW = new Set(["residential", "secondary", "tertiary", "primary", "unclassified", "pedestrian", "living_street", "service"]);
const city = process.argv[2];
if (!city) {
  console.error(`Usage: node scripts/build-city-lattice.mjs <city-or-bounds-name>`);
  process.exit(1);
}
const SRC = city === "manhattan" ? path.join(process.cwd(), "tmp-gas-spike", "osm-walk-network.json") : path.join(process.cwd(), "tmp-city-osm", city, "osm-walk-network.json");
const OUT = path.join(process.cwd(), "tmp-city-lattice", `${city}-lattice.json`);
let BOUNDS = PRESETS[city];
if (!BOUNDS) {
  BOUNDS = JSON.parse(await fs.readFile(path.join(process.cwd(), "tmp-city-osm", city, "bounds.json"), "utf8"));
}
function haversine(a, b) {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function chordDeviation(p, a, b) {
  const mLat = 111320;
  const mLng = 111320 * Math.cos((a[0] * Math.PI) / 180);
  const bx = (b[1] - a[1]) * mLng;
  const by = (b[0] - a[0]) * mLat;
  const px = (p[1] - a[1]) * mLng;
  const py = (p[0] - a[0]) * mLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}
function dpSimplify(pts, tolM) {
  if (pts.length <= 2) return pts;
  let maxD = -1, best = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = chordDeviation(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; best = i; }
  }
  if (maxD <= tolM) return [pts[0], pts[pts.length - 1]];
  const left = dpSimplify(pts.slice(0, best + 1), tolM);
  const right = dpSimplify(pts.slice(best), tolM);
  return left.slice(0, -1).concat(right);
}
const raw = JSON.parse(await fs.readFile(SRC, "utf8"));
const coords = new Map();
for (const el of raw.elements) if (el.type === "node") coords.set(el.id, [el.lat, el.lon]);
const inBounds = ([lat, lng]) => lat >= BOUNDS.south && lat <= BOUNDS.north && lng >= BOUNDS.west && lng <= BOUNDS.east;
const adj = new Map();
function addAdj(a, b) { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); }
let keptWays = 0;
for (const el of raw.elements) {
  if (el.type !== "way" || !el.nodes || el.nodes.length < 2) continue;
  const hw = el.tags?.highway;
  const named = Boolean(el.tags?.name);
  if (!(STREET_HW.has(hw) || named)) continue;
  keptWays++;
  for (let i = 1; i < el.nodes.length; i++) {
    const a = el.nodes[i - 1], b = el.nodes[i];
    const pa = coords.get(a), pb = coords.get(b);
    if (!pa || !pb || !inBounds(pa) || !inBounds(pb)) continue;
    addAdj(a, b); addAdj(b, a);
  }
}
const isJunction = (id) => (adj.get(id)?.size ?? 0) !== 2;
const edgeKeySeen = new Set();
let edges = [];
for (const [start, nbrs] of adj) {
  if (!isJunction(start)) continue;
  for (const first of nbrs) {
    const chain = [start, first];
    let prev = start, cur = first;
    while (!isJunction(cur)) {
      const next = [...adj.get(cur)].find((n) => n !== prev);
      if (next === undefined) break;
      prev = cur; cur = next; chain.push(cur);
      if (chain.length > 5000) break;
    }
    const end = chain[chain.length - 1];
    if (!isJunction(end) || (end === start && chain.length <= 3)) continue;
    const pts = chain.map((id) => coords.get(id)).filter(Boolean);
    if (pts.length < 2) continue;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += haversine(pts[i - 1], pts[i]);
    if (len < 2) continue;
    const key = (start < end ? `${start}|${end}` : `${end}|${start}`) + `|${Math.round(len)}`;
    if (edgeKeySeen.has(key)) continue;
    edgeKeySeen.add(key);
    edges.push({ a: start, b: end, len, via: dpSimplify(pts, 20).slice(1, -1) });
  }
}
const g = new Map();
for (const e of edges) {
  if (!g.has(e.a)) g.set(e.a, []);
  if (!g.has(e.b)) g.set(e.b, []);
  g.get(e.a).push(e.b); g.get(e.b).push(e.a);
}
const comp = new Map();
let cid = 0;
for (const seed of g.keys()) {
  if (comp.has(seed)) continue;
  cid++;
  const stack = [seed]; comp.set(seed, cid);
  while (stack.length) {
    const cur = stack.pop();
    for (const n of g.get(cur) ?? []) if (!comp.has(n)) { comp.set(n, cid); stack.push(n); }
  }
}
const sizes = new Map();
for (const c of comp.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
const bigC = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const before = edges.length;
edges = edges.filter((e) => comp.get(e.a) === bigC && comp.get(e.b) === bigC);
const nodeIndex = new Map();
const nodesOut = [];
function idxOf(osmId) {
  let i = nodeIndex.get(osmId);
  if (i === undefined) {
    i = nodesOut.length;
    nodeIndex.set(osmId, i);
    const [lat, lng] = coords.get(osmId);
    nodesOut.push([Number(lat.toFixed(6)), Number(lng.toFixed(6))]);
  }
  return i;
}
const edgesOut = edges.map((e) => [idxOf(e.a), idxOf(e.b), Math.round(e.len), e.via.map(([lat, lng]) => [Number(lat.toFixed(6)), Number(lng.toFixed(6))])]);
const out = { version: 1, city, bounds: BOUNDS, builtFrom: path.relative(process.cwd(), SRC).replace(/\\/g, "/"), nodes: nodesOut, edges: edgesOut };
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(out));
console.log(JSON.stringify({ city, keptWays, components: sizes.size, keptComponentNodes: sizes.get(bigC), droppedEdges: before - edges.length, nodes: nodesOut.length, edges: edgesOut.length, out: OUT }, null, 2));

