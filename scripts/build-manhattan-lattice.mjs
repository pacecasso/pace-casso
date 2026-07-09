/**
 * Distill the cached Manhattan OSM walk network (tmp-gas-spike/osm-walk-network.json,
 * ~16 MB) into a compact street-junction lattice the production lattice compiler
 * can ship: junction nodes + contracted edges with real walking lengths.
 *
 * Keeps street-class ways (car streets + pedestrian streets) and any named way
 * (park drives, named paths). Drops unnamed sidewalks/crossings — they double
 * every corridor and add no art value. Degree-2 chains are contracted into a
 * single edge that remembers its true length and a DP-simplified "via" geometry
 * so curved edges (park drives, Broadway bends) still trace correctly.
 *
 * Usage: node scripts/build-manhattan-lattice.mjs
 * Output: lib/data/manhattan-lattice.json
 */
import fs from "node:fs/promises";
import path from "node:path";

const SRC = path.join(process.cwd(), "tmp-gas-spike", "osm-walk-network.json");
const OUT = path.join(process.cwd(), "lib", "data", "manhattan-lattice.json");

// Mirrors MANHATTAN_PRESET.searchBounds in lib/cityPresets.ts.
const BOUNDS = { south: 40.698, west: -74.02, north: 40.882, east: -73.958 };

const STREET_HW = new Set([
  "residential",
  "secondary",
  "tertiary",
  "primary",
  "unclassified",
  "pedestrian",
  "living_street",
]);

function haversine(a, b) {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Perpendicular distance (meters, approx) of p from chord a->b. */
function chordDeviation(p, a, b) {
  const mLat = 111320;
  const mLng = 111320 * Math.cos((a[0] * Math.PI) / 180);
  const ax = 0;
  const ay = 0;
  const bx = (b[1] - a[1]) * mLng;
  const by = (b[0] - a[0]) * mLat;
  const px = (p[1] - a[1]) * mLng;
  const py = (p[0] - a[0]) * mLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - (ax + t * bx), py - (ay + t * by));
}

/** Douglas-Peucker on [lat,lng] points, tolerance in meters. */
function dpSimplify(pts, tolM) {
  if (pts.length <= 2) return pts;
  let maxD = -1;
  let idx = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = chordDeviation(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tolM) return [pts[0], pts[pts.length - 1]];
  const left = dpSimplify(pts.slice(0, idx + 1), tolM);
  const right = dpSimplify(pts.slice(idx), tolM);
  return left.slice(0, -1).concat(right);
}

const raw = JSON.parse(await fs.readFile(SRC, "utf8"));
const coords = new Map(); // osm node id -> [lat, lng]
for (const el of raw.elements) {
  if (el.type === "node") coords.set(el.id, [el.lat, el.lon]);
}

const inBounds = ([lat, lng]) =>
  lat >= BOUNDS.south &&
  lat <= BOUNDS.north &&
  lng >= BOUNDS.west &&
  lng <= BOUNDS.east;

// adjacency over kept ways
const adj = new Map(); // id -> Set(neighbor id)
const addAdj = (a, b) => {
  if (!adj.has(a)) adj.set(a, new Set());
  adj.get(a).add(b);
};

let keptWays = 0;
for (const el of raw.elements) {
  if (el.type !== "way" || !el.nodes || el.nodes.length < 2) continue;
  const hw = el.tags?.highway;
  const named = Boolean(el.tags?.name);
  if (!(STREET_HW.has(hw) || named)) continue;
  keptWays++;
  for (let i = 1; i < el.nodes.length; i++) {
    const a = el.nodes[i - 1];
    const b = el.nodes[i];
    const pa = coords.get(a);
    const pb = coords.get(b);
    if (!pa || !pb || !inBounds(pa) || !inBounds(pb)) continue;
    addAdj(a, b);
    addAdj(b, a);
  }
}

// junction = any node whose degree != 2 (crossings, dead-ends)
const isJunction = (id) => (adj.get(id)?.size ?? 0) !== 2;

// contract degree-2 chains between junctions
const edgeKeySeen = new Set();
const edges = []; // {a, b, len, via: [latlng...]}
for (const [start, nbrs] of adj) {
  if (!isJunction(start)) continue;
  for (const first of nbrs) {
    const chain = [start, first];
    let prev = start;
    let cur = first;
    while (!isJunction(cur)) {
      const next = [...adj.get(cur)].find((n) => n !== prev);
      if (next === undefined) break; // degree-2 loop guard
      prev = cur;
      cur = next;
      chain.push(cur);
      if (chain.length > 5000) break; // pathological loop guard
    }
    const end = chain[chain.length - 1];
    if (!isJunction(end)) continue; // unterminated loop
    if (end === start && chain.length <= 3) continue; // trivial self-loop
    const pts = chain.map((id) => coords.get(id)).filter(Boolean);
    if (pts.length < 2) continue;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += haversine(pts[i - 1], pts[i]);
    if (len < 2) continue; // duplicate stacked nodes
    // dedupe both directions; length distinguishes parallel edges
    const key =
      (start < end ? `${start}|${end}` : `${end}|${start}`) +
      `|${Math.round(len)}`;
    if (edgeKeySeen.has(key)) continue;
    edgeKeySeen.add(key);
    const via = dpSimplify(pts, 20).slice(1, -1);
    edges.push({ a: start, b: end, len, via });
  }
}

// keep only the largest connected component (drops stray islands/stubs)
const comp = new Map();
{
  const g = new Map();
  for (const e of edges) {
    if (!g.has(e.a)) g.set(e.a, []);
    if (!g.has(e.b)) g.set(e.b, []);
    g.get(e.a).push(e.b);
    g.get(e.b).push(e.a);
  }
  let cid = 0;
  for (const seed of g.keys()) {
    if (comp.has(seed)) continue;
    cid++;
    const stack = [seed];
    comp.set(seed, cid);
    while (stack.length) {
      const cur = stack.pop();
      for (const n of g.get(cur) ?? []) {
        if (!comp.has(n)) {
          comp.set(n, cid);
          stack.push(n);
        }
      }
    }
  }
  const sizes = new Map();
  for (const c of comp.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  const bigC = [...sizes.entries()].sort((x, y) => y[1] - x[1])[0][0];
  const before = edges.length;
  for (let i = edges.length - 1; i >= 0; i--) {
    if (comp.get(edges[i].a) !== bigC) edges.splice(i, 1);
  }
  console.log(
    `components: kept largest (${sizes.get(bigC)} nodes), dropped ${before - edges.length} edges`,
  );
}

// re-index nodes compactly
const nodeIndex = new Map();
const nodesOut = [];
const idxOf = (osmId) => {
  let i = nodeIndex.get(osmId);
  if (i === undefined) {
    i = nodesOut.length;
    nodeIndex.set(osmId, i);
    const [lat, lng] = coords.get(osmId);
    nodesOut.push([Number(lat.toFixed(6)), Number(lng.toFixed(6))]);
  }
  return i;
};
const edgesOut = edges.map((e) => {
  const via = e.via.map(([lat, lng]) => [
    Number(lat.toFixed(6)),
    Number(lng.toFixed(6)),
  ]);
  return [idxOf(e.a), idxOf(e.b), Math.round(e.len), via];
});

const out = {
  version: 1,
  city: "manhattan",
  bounds: BOUNDS,
  builtFrom: "OSM walk network cache (tmp-gas-spike/osm-walk-network.json)",
  nodes: nodesOut,
  edges: edgesOut,
};

await fs.mkdir(path.dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
await fs.writeFile(OUT, json);
console.log(
  `ways kept: ${keptWays} | junctions: ${nodesOut.length} | edges: ${edgesOut.length} | ${(json.length / 1024 / 1024).toFixed(2)} MB -> ${OUT}`,
);
