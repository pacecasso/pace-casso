import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-sneaker-lower-manhattan-handfit", stamp);

const WALKABLE = new Set([
  "residential", "secondary", "primary", "tertiary", "unclassified",
  "living_street", "pedestrian", "service", "footway", "path", "cycleway",
  "secondary_link", "primary_link", "tertiary_link",
]);
const M_LAT = 111320;
const ORIGIN = [40.715, -74.002];
const BOUNDS = { south: 40.695, west: -74.025, north: 40.730, east: -73.970 };

function mLng(lat = ORIGIN[0]) {
  return M_LAT * Math.cos((lat * Math.PI) / 180);
}
function xy([lat, lng]) {
  return [(lng - ORIGIN[1]) * mLng(), (lat - ORIGIN[0]) * M_LAT];
}
function ll([x, y]) {
  return [ORIGIN[0] + y / M_LAT, ORIGIN[1] + x / mLng()];
}
function hav(a, b) {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180, la2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function inBounds([lat, lng]) {
  return lat >= BOUNDS.south && lat <= BOUNDS.north && lng >= BOUNDS.west && lng <= BOUNDS.east;
}
function distSeg(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-9) return Math.hypot(wx, wy);
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(wx - vx * t, wy - vy * t);
}
function bounds(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

async function loadGraph() {
  const raw = JSON.parse(await fs.readFile(path.join(root, "tmp-gas-spike", "osm-walk-network.json"), "utf8"));
  const coords = new Map();
  for (const el of raw.elements) if (el.type === "node") coords.set(el.id, [el.lat, el.lon]);
  const nodes = [], index = new Map(), adj = new Map();
  const idx = (id) => {
    let i = index.get(id);
    if (i === undefined) {
      const latlng = coords.get(id);
      if (!latlng) return -1;
      i = nodes.length;
      index.set(id, i);
      nodes.push({ id, ll: latlng, xy: xy(latlng) });
      adj.set(i, []);
    }
    return i;
  };
  for (const el of raw.elements) {
    if (el.type !== "way" || !el.nodes || el.nodes.length < 2) continue;
    const hw = el.tags?.highway;
    if (!WALKABLE.has(hw) && !el.tags?.name) continue;
    for (let i = 1; i < el.nodes.length; i++) {
      const aLL = coords.get(el.nodes[i - 1]), bLL = coords.get(el.nodes[i]);
      if (!aLL || !bLL || !inBounds(aLL) || !inBounds(bLL)) continue;
      const a = idx(el.nodes[i - 1]), b = idx(el.nodes[i]);
      if (a < 0 || b < 0) continue;
      const len = hav(nodes[a].ll, nodes[b].ll);
      if (len < 1 || len > 500) continue;
      adj.get(a).push({ to: b, len });
      adj.get(b).push({ to: a, len });
    }
  }
  return buildCells(largest({ nodes, adj }));
}

function largest(graph) {
  const comp = new Map(), sizes = [];
  let cid = 0;
  for (let i = 0; i < graph.nodes.length; i++) {
    if (comp.has(i)) continue;
    const stack = [i];
    comp.set(i, cid);
    let size = 0;
    while (stack.length) {
      const cur = stack.pop();
      size++;
      for (const e of graph.adj.get(cur) ?? []) if (!comp.has(e.to)) {
        comp.set(e.to, cid);
        stack.push(e.to);
      }
    }
    sizes[cid] = size;
    cid++;
  }
  const keep = sizes.indexOf(Math.max(...sizes));
  const remap = new Map(), nodes = [];
  graph.nodes.forEach((n, i) => {
    if (comp.get(i) === keep) {
      remap.set(i, nodes.length);
      nodes.push(n);
    }
  });
  const adj = new Map(nodes.map((_, i) => [i, []]));
  for (const [old, entries] of graph.adj.entries()) {
    const ni = remap.get(old);
    if (ni === undefined) continue;
    for (const e of entries) {
      const to = remap.get(e.to);
      if (to !== undefined) adj.get(ni).push({ to, len: e.len });
    }
  }
  return { nodes, adj };
}

function buildCells(graph, cell = 120) {
  graph.cells = new Map();
  graph.cell = cell;
  graph.nodes.forEach((n, i) => {
    const k = `${Math.floor(n.xy[0] / cell)}:${Math.floor(n.xy[1] / cell)}`;
    const list = graph.cells.get(k);
    if (list) list.push(i);
    else graph.cells.set(k, [i]);
  });
  return graph;
}

function nearest(graph, target, radius = 150) {
  const c = graph.cell;
  const cx = Math.floor(target[0] / c), cy = Math.floor(target[1] / c);
  const r = Math.ceil(radius / c) + 1;
  let best = -1, bd = radius;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    for (const id of graph.cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
      const p = graph.nodes[id].xy;
      const d = Math.hypot(p[0] - target[0], p[1] - target[1]);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
  }
  return best;
}

function astar(graph, from, to, aXY, bXY, devWeight = 0.85) {
  if (from === to) return { ids: [from], len: 0 };
  const g = new Map([[from, 0]]), raw = new Map([[from, 0]]), prev = new Map();
  const open = [[0, from]], done = new Set();
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === to) break;
    if (done.has(cur)) continue;
    done.add(cur);
    for (const e of graph.adj.get(cur) ?? []) {
      const p = graph.nodes[e.to].xy;
      const bend = distSeg(p, aXY, bXY);
      const ng = g.get(cur) + e.len + bend * devWeight;
      if (ng < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, ng);
        raw.set(e.to, raw.get(cur) + e.len);
        prev.set(e.to, cur);
        open.push([ng + Math.hypot(p[0] - graph.nodes[to].xy[0], p[1] - graph.nodes[to].xy[1]), e.to]);
      }
    }
  }
  if (!prev.has(to)) return null;
  const ids = [to];
  let cur = to;
  while (cur !== from) {
    cur = prev.get(cur);
    ids.push(cur);
    if (ids.length > 20000) return null;
  }
  ids.reverse();
  return { ids, len: raw.get(to) };
}

function route(graph, waypoints) {
  const targets = waypoints.map(xy);
  const pins = targets.map((p) => nearest(graph, p, 650));
  const missingPins = pins.filter((p) => p < 0).length;
  if (missingPins) return { ids: [], xy: [], km: 0, failures: 999, missingPins };
  const ids = [];
  let km = 0, failures = 0;
  for (let i = 1; i < pins.length; i++) {
    const seg = astar(graph, pins[i - 1], pins[i], targets[i - 1], targets[i]);
    const chord = Math.hypot(targets[i][0] - targets[i - 1][0], targets[i][1] - targets[i - 1][1]);
    if (!seg || seg.len > chord * 5.5 + 1100) {
      failures++;
      continue;
    }
    for (const id of seg.ids) if (ids[ids.length - 1] !== id) ids.push(id);
    km += seg.len / 1000;
  }
  return { ids, xy: ids.map((id) => graph.nodes[id].xy), km, failures };
}

function variants() {
  const outline = [
    [40.7072, -74.0142], [40.7042, -74.0103], [40.7022, -74.0042], [40.7025, -73.9972],
    [40.7033, -73.9890], [40.7052, -73.9810], [40.7076, -73.9746], [40.7115, -73.9723],
    [40.7165, -73.9744], [40.7202, -73.9822], [40.7225, -73.9912], [40.7225, -74.0005],
    [40.7205, -74.0078], [40.7162, -74.0120], [40.7118, -74.0138], [40.7072, -74.0142],
  ];
  return [
    {
      id: "waterfront-outline-laces",
      pts: [
        ...outline,
        [40.7108, -74.0128], [40.7125, -74.0060], [40.7078, -74.0102],
        [40.7140, -74.0022], [40.7086, -74.0048],
        [40.7160, -73.9978], [40.7095, -73.9990],
        [40.7168, -73.9925], [40.7103, -73.9936],
        [40.7170, -73.9875], [40.7110, -73.9887],
      ],
    },
    {
      id: "clean-outline-two-laces",
      pts: [
        ...outline,
        [40.7110, -74.0127], [40.7142, -74.0030], [40.7085, -74.0060],
        [40.7165, -73.9952], [40.7098, -73.9972],
        [40.7176, -73.9875], [40.7115, -73.9896],
      ],
    },
    {
      id: "sole-first-swoosh",
      pts: [
        [40.7042, -74.0103], [40.7022, -74.0042], [40.7025, -73.9972], [40.7033, -73.9890],
        [40.7052, -73.9810], [40.7076, -73.9746], [40.7115, -73.9723], [40.7165, -73.9744],
        [40.7202, -73.9822], [40.7225, -73.9912], [40.7225, -74.0005], [40.7205, -74.0078],
        [40.7162, -74.0120], [40.7118, -74.0138], [40.7072, -74.0142], [40.7042, -74.0103],
        [40.7095, -74.0075], [40.7128, -73.9990], [40.7155, -73.9890], [40.7150, -73.9810],
        [40.7117, -73.9895], [40.7106, -73.9990], [40.7095, -74.0075],
      ],
    },
  ];
}

async function render(graph, cand, file) {
  const w = 1200, h = 820;
  const rb = bounds(cand.xy), pad = 220;
  const view = { minX: rb.minX - pad, maxX: rb.maxX + pad, minY: rb.minY - pad, maxY: rb.maxY + pad };
  const s = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const ox = (w - (view.maxX - view.minX) * s) / 2, oy = (h - (view.maxY - view.minY) * s) / 2;
  const pr = ([x, y]) => [ox + (x - view.minX) * s, oy + (view.maxY - y) * s];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const seen = new Set(), streets = [];
  for (const [from, entries] of graph.adj.entries()) for (const e of entries) {
    const key = from < e.to ? `${from}:${e.to}` : `${e.to}:${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = graph.nodes[from].xy, b = graph.nodes[e.to].xy;
    if (!inView(a) && !inView(b)) continue;
    const [x1, y1] = pr(a), [x2, y2] = pr(b);
    streets.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="#d8d8d8" stroke-width="1.7" stroke-linecap="round"/>`);
  }
  const d = cand.xy.map((p, i) => {
    const [x, y] = pr(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#f6f4ef"/>
    <rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>
    ${streets.join("\n")}
    <path d="${d}" fill="none" stroke="#823" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="#e9441b" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="36" y="54" font-family="Arial" font-size="18" font-weight="700" fill="#222">${cand.id} · ${cand.km.toFixed(1)} km</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function gpx(name, graph, ids) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso lower Manhattan handfit" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${ids.map((id) => {
    const [lat, lng] = graph.nodes[id].ll;
    return `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`;
  }).join("\n")}\n</trkseg></trk></gpx>\n`;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const graph = await loadGraph();
  const summary = [];
  for (const v of variants()) {
    const cand = route(graph, v.pts);
    if (!cand || cand.missingPins || cand.xy.length < 2) {
      summary.push({ id: v.id, ok: false, missingPins: cand?.missingPins ?? null, graphNodes: graph.nodes.length });
      continue;
    }
    cand.id = v.id;
    await render(graph, cand, path.join(outDir, `${v.id}.png`));
    await fs.writeFile(path.join(outDir, `${v.id}.gpx`), gpx(v.id, graph, cand.ids), "utf8");
    summary.push({ id: v.id, ok: true, km: +cand.km.toFixed(2), failures: cand.failures, png: path.relative(root, path.join(outDir, `${v.id}.png`)).replace(/\\/g, "/") });
  }
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(path.relative(root, outDir));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});





