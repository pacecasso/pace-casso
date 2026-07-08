/**
 * GAS spike step 2: build a named-corridor lattice from the cached OSM network.
 *
 * Exports (for reuse by the route builder):
 *   loadNetwork() -> { nodes, corridors, intersectionOf, corridorPath, corridorSpan }
 *
 * CLI: node scripts/gas-spike-lattice.mjs <zone>   (zone = les | midtownwest)
 * Prints the intersection matrix for the zone with real spacings + missing cells.
 */
import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.join(process.cwd(), "tmp-gas-spike", "osm-walk-network.json");

export function haversine(a, b) {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function normalizeName(raw) {
  if (!raw) return null;
  let n = raw.toLowerCase().trim();
  n = n.replace(/^west /, "w ").replace(/^east /, "e ");
  n = n.replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave");
  // ordinal words -> digits (OSM NYC mostly uses digits already)
  const words = {
    first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th",
    sixth: "6th", seventh: "7th", eighth: "8th", ninth: "9th", tenth: "10th",
    eleventh: "11th", twelfth: "12th",
  };
  for (const [w, d] of Object.entries(words)) n = n.replace(new RegExp(`\\b${w}\\b`), d);
  if (n === "ave of the americas") n = "6th ave";
  if (n === "union square east") n = "park ave south";
  if (n === "union square east") n = "park ave south";
  if (n === "fashion ave") n = "7th ave";
  if (n === "adam clayton powell jr boulevard") n = "7th ave";
  // numbered cross streets: West/East halves are one physical corridor
  n = n.replace(/^[we] (\d+(?:st|nd|rd|th) st)$/, "$1");
  return n;
}

export async function loadNetwork() {
  const raw = JSON.parse(await fs.readFile(DATA, "utf8"));
  const nodes = new Map(); // id -> [lat, lon]
  for (const el of raw.elements) {
    if (el.type === "node") nodes.set(el.id, [el.lat, el.lon]);
  }

  // corridors: normName -> { edges: Map(nodeId -> Set(nodeId)), nodeIds: Set }
  const corridors = new Map();
  // global walk graph for connector routing
  const graph = new Map(); // nodeId -> Map(nodeId -> meters)

  const addEdge = (map, a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(b);
  };
  const addGraphEdge = (a, b) => {
    const pa = nodes.get(a);
    const pb = nodes.get(b);
    if (!pa || !pb) return;
    const d = haversine(pa, pb);
    if (!graph.has(a)) graph.set(a, new Map());
    if (!graph.has(b)) graph.set(b, new Map());
    graph.get(a).set(b, d);
    graph.get(b).set(a, d);
  };

  for (const el of raw.elements) {
    if (el.type !== "way" || !el.nodes) continue;
    const names = new Set();
    const n1 = normalizeName(el.tags?.name);
    const n2 = normalizeName(el.tags?.alt_name);
    if (n1) names.add(n1);
    if (n2) names.add(n2);
    for (let i = 1; i < el.nodes.length; i++) {
      addGraphEdge(el.nodes[i - 1], el.nodes[i]);
    }
    for (const nm of names) {
      if (!corridors.has(nm)) corridors.set(nm, { edges: new Map(), nodeIds: new Set() });
      const c = corridors.get(nm);
      for (let i = 0; i < el.nodes.length; i++) {
        c.nodeIds.add(el.nodes[i]);
        if (i > 0) {
          addEdge(c.edges, el.nodes[i - 1], el.nodes[i]);
          addEdge(c.edges, el.nodes[i], el.nodes[i - 1]);
        }
      }
    }
  }

  /** Node(s) where two corridors meet; picks the pair closest together. */
  function intersectionOf(nameA, nameB) {
    const a = corridors.get(normalizeName(nameA));
    const b = corridors.get(normalizeName(nameB));
    if (!a || !b) return null;
    const shared = [...a.nodeIds].filter((id) => b.nodeIds.has(id));
    if (shared.length > 0) {
      // multiple shared nodes (wide roads / dual carriageways): return centroid rep
      const pts = shared.map((id) => nodes.get(id)).filter(Boolean);
      const cLat = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cLon = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      let best = shared[0];
      let bestD = Infinity;
      for (const id of shared) {
        const d = haversine(nodes.get(id), [cLat, cLon]);
        if (d < bestD) { bestD = d; best = id; }
      }
      return best;
    }
    // near-miss: nodes within 25 m of each other
    let best = null;
    let bestD = 25;
    for (const ia of a.nodeIds) {
      const pa = nodes.get(ia);
      if (!pa) continue;
      for (const ib of b.nodeIds) {
        const pb = nodes.get(ib);
        if (!pb) continue;
        const d = haversine(pa, pb);
        if (d < bestD) { bestD = d; best = ia; }
      }
    }
    return best;
  }

  /** BFS shortest path along a single named corridor. */
  function corridorPath(name, fromId, toId) {
    const c = corridors.get(normalizeName(name));
    if (!c) return null;
    if (fromId === toId) return [fromId];
    const prev = new Map([[fromId, null]]);
    // Dijkstra-lite (uniform-ish edges): BFS by cumulative distance
    const dist = new Map([[fromId, 0]]);
    const queue = [[0, fromId]];
    while (queue.length) {
      queue.sort((x, y) => x[0] - y[0]);
      const [d, cur] = queue.shift();
      if (cur === toId) break;
      if (d > (dist.get(cur) ?? Infinity)) continue;
      for (const nxt of c.edges.get(cur) ?? []) {
        const pa = nodes.get(cur);
        const pb = nodes.get(nxt);
        if (!pa || !pb) continue;
        const nd = d + haversine(pa, pb);
        if (nd < (dist.get(nxt) ?? Infinity)) {
          dist.set(nxt, nd);
          prev.set(nxt, cur);
          queue.push([nd, nxt]);
        }
      }
    }
    if (!prev.has(toId)) return null;
    const out = [];
    let cur = toId;
    while (cur !== null) {
      out.push(cur);
      cur = prev.get(cur);
    }
    return out.reverse();
  }

  /** General walk-graph A* for connectors (any streets). */
  function walkPath(fromId, toId) {
    const target = nodes.get(toId);
    if (!target) return null;
    const open = [[haversine(nodes.get(fromId), target), 0, fromId]];
    const g = new Map([[fromId, 0]]);
    const prev = new Map([[fromId, null]]);
    const done = new Set();
    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [, gc, cur] = open.shift();
      if (cur === toId) break;
      if (done.has(cur)) continue;
      done.add(cur);
      for (const [nxt, d] of graph.get(cur) ?? []) {
        const ng = gc + d;
        if (ng < (g.get(nxt) ?? Infinity)) {
          g.set(nxt, ng);
          prev.set(nxt, cur);
          open.push([ng + haversine(nodes.get(nxt), target), ng, nxt]);
        }
      }
    }
    if (!prev.has(toId)) return null;
    const out = [];
    let cur = toId;
    while (cur !== null) { out.push(cur); cur = prev.get(cur); }
    return out.reverse();
  }

  return { nodes, corridors, intersectionOf, corridorPath, walkPath, normalizeName };
}

const ZONES = {
  les: {
    // columns west -> east (N-S streets), rows south -> north (E-W streets)
    cols: ["Bowery", "Chrystie Street", "Forsyth Street", "Eldridge Street", "Allen Street",
           "Orchard Street", "Ludlow Street", "Essex Street", "Norfolk Street",
           "Suffolk Street", "Clinton Street", "Attorney Street", "Ridge Street",
           "Pitt Street", "Columbia Street"],
    rows: ["Canal Street", "Hester Street", "Grand Street", "Broome Street",
           "Delancey Street", "Rivington Street", "Stanton Street", "East Houston Street"],
  },
  eastvillage: {
    cols: ["Bowery", "2nd Avenue", "1st Avenue", "Avenue A", "Avenue B", "Avenue C", "Avenue D"],
    rows: ["East Houston Street", "East 1st Street", "East 2nd Street", "East 3rd Street",
           "East 4th Street", "East 5th Street", "East 6th Street", "East 7th Street",
           "East 8th Street", "East 9th Street", "East 10th Street", "East 11th Street",
           "East 12th Street", "East 13th Street", "East 14th Street"],
  },
  midtownwest: {
    cols: ["11th Avenue", "10th Avenue", "9th Avenue", "8th Avenue", "7th Avenue",
           "6th Avenue", "5th Avenue"],
    rows: Array.from({ length: 24 }, (_, i) => `West ${34 + i}th Street`).map((s) =>
      s.replace("34th", "34th").replace(/\b(\d+)th\b/, (m, d) => {
        const n = Number(d);
        const suf = n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
        return `${n}${suf}`;
      }),
    ),
  },
};

const isMain = (process.argv[1] ?? "").includes("gas-spike-lattice");
const zoneArg = isMain ? process.argv[2] : null;
if (zoneArg) {
  const zone = ZONES[zoneArg];
  if (!zone) {
    console.error(`unknown zone ${zoneArg}; options: ${Object.keys(ZONES).join(", ")}`);
    process.exit(1);
  }
  const net = await loadNetwork();
  const { intersectionOf, corridorPath, nodes } = net;

  console.log(`zone=${zoneArg}`);
  // intersection matrix
  const matrix = [];
  for (const row of zone.rows) {
    const line = [];
    for (const col of zone.cols) {
      const id = intersectionOf(col, row);
      line.push(id);
    }
    matrix.push(line);
  }

  // print col spacing along the middle row & row spacing along middle col
  const midRow = Math.floor(zone.rows.length / 2);
  const midCol = Math.floor(zone.cols.length / 2);
  console.log("\ncolumn spacing (m) along " + zone.rows[midRow] + ":");
  for (let c = 1; c < zone.cols.length; c++) {
    const a = matrix[midRow][c - 1];
    const b = matrix[midRow][c];
    const d = a && b ? haversine(nodes.get(a), nodes.get(b)).toFixed(0) : "??";
    console.log(`  ${zone.cols[c - 1]} -> ${zone.cols[c]}: ${d}`);
  }
  console.log("\nrow spacing (m) along " + zone.cols[midCol] + ":");
  for (let r = 1; r < zone.rows.length; r++) {
    const a = matrix[r - 1][midCol];
    const b = matrix[r][midCol];
    const d = a && b ? haversine(nodes.get(a), nodes.get(b)).toFixed(0) : "??";
    console.log(`  ${zone.rows[r - 1]} -> ${zone.rows[r]}: ${d}`);
  }

  // grid completeness + corridor continuity (can you walk each row across all cols?)
  console.log("\nmatrix (X = intersection found, . = missing):");
  for (let r = zone.rows.length - 1; r >= 0; r--) {
    const cells = matrix[r].map((id) => (id ? "X" : "."));
    console.log(`  ${cells.join(" ")}  ${zone.rows[r]}`);
  }
  console.log("  cols: " + zone.cols.join(" | "));

  console.log("\nrow continuity (corridor path across full width):");
  for (let r = 0; r < zone.rows.length; r++) {
    const ids = matrix[r].filter(Boolean);
    if (ids.length < 2) { console.log(`  ${zone.rows[r]}: too few nodes`); continue; }
    const p = corridorPath(zone.rows[r], ids[0], ids[ids.length - 1]);
    console.log(`  ${zone.rows[r]}: ${p ? "OK (" + p.length + " nodes)" : "BROKEN"}`);
  }
  console.log("\ncol continuity (corridor path across full height):");
  for (let c = 0; c < zone.cols.length; c++) {
    const ids = matrix.map((row) => row[c]).filter(Boolean);
    if (ids.length < 2) { console.log(`  ${zone.cols[c]}: too few nodes`); continue; }
    const p = corridorPath(zone.cols[c], ids[0], ids[ids.length - 1]);
    console.log(`  ${zone.cols[c]}: ${p ? "OK (" + p.length + " nodes)" : "BROKEN"}`);
  }
}
