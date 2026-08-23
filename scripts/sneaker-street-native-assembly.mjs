import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runLabel = process.argv[2] ?? "outline-swoosh";
const M_PER_LAT = 111320;
let ORIGIN = [40.728, -73.998];
const CITY = process.argv[3] ?? "manhattan";
const outDir = path.join(root, "tmp-sneaker-street-native-assembly", `${runLabel}-${CITY}-${stamp}`);
const WALKABLE = new Set([
  "residential",
  "secondary",
  "primary",
  "tertiary",
  "unclassified",
  "living_street",
  "pedestrian",
  "service",
  "footway",
  "path",
  "cycleway",
  "secondary_link",
  "primary_link",
  "tertiary_link",
]);
let BOUNDS = { south: 40.700, west: -74.020, north: 40.770, east: -73.958 };

function metersPerLng(lat = ORIGIN[0]) {
  return M_PER_LAT * Math.cos((lat * Math.PI) / 180);
}

function hav(a, b) {
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

function toXY([lat, lng]) {
  return [(lng - ORIGIN[1]) * metersPerLng(ORIGIN[0]), (lat - ORIGIN[0]) * M_PER_LAT];
}

function fromXY([x, y]) {
  return [ORIGIN[0] + y / M_PER_LAT, ORIGIN[1] + x / metersPerLng(ORIGIN[0])];
}

function distPointSeg(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-9) return Math.hypot(wx, wy);
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function lengthXY(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

function polylineDistance(points, target) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, distPointSeg(target, points[i - 1], points[i]));
  return best;
}

async function loadGraph() {
  let rawPath = path.join(root, "tmp-gas-spike", "osm-walk-network.json");
  if (CITY !== "manhattan") {
    rawPath = path.join(root, "tmp-city-osm", CITY, "osm-walk-network.json");
    BOUNDS = JSON.parse(await fs.readFile(path.join(root, "tmp-city-osm", CITY, "bounds.json"), "utf8"));
    ORIGIN = [(BOUNDS.south + BOUNDS.north) / 2, (BOUNDS.west + BOUNDS.east) / 2];
  }
  const raw = JSON.parse(await fs.readFile(rawPath, "utf8"));
  const coords = new Map();
  for (const el of raw.elements) if (el.type === "node") coords.set(el.id, [el.lat, el.lon]);
  const inBounds = ([lat, lng]) => lat >= BOUNDS.south && lat <= BOUNDS.north && lng >= BOUNDS.west && lng <= BOUNDS.east;
  const nodes = [];
  const index = new Map();
  const adj = new Map();
  function idx(id) {
    let i = index.get(id);
    if (i === undefined) {
      const ll = coords.get(id);
      if (!ll) return -1;
      i = nodes.length;
      index.set(id, i);
      nodes.push({ id, ll, xy: toXY(ll) });
      adj.set(i, []);
    }
    return i;
  }
  for (const el of raw.elements) {
    if (el.type !== "way" || !el.nodes || el.nodes.length < 2) continue;
    const hw = el.tags?.highway;
    if (!WALKABLE.has(hw) && !el.tags?.name) continue;
    for (let i = 1; i < el.nodes.length; i++) {
      const pa = coords.get(el.nodes[i - 1]);
      const pb = coords.get(el.nodes[i]);
      if (!pa || !pb || !inBounds(pa) || !inBounds(pb)) continue;
      const a = idx(el.nodes[i - 1]);
      const b = idx(el.nodes[i]);
      if (a < 0 || b < 0) continue;
      const len = hav(nodes[a].ll, nodes[b].ll);
      if (!Number.isFinite(len) || len < 1 || len > 800) continue;
      adj.get(a).push({ to: b, len });
      adj.get(b).push({ to: a, len });
    }
  }
  return { nodes, adj };
}

function filterLargestComponent(graph) {
  const comp = new Map();
  const sizes = [];
  let cid = 0;
  for (let i = 0; i < graph.nodes.length; i++) {
    if (comp.has(i)) continue;
    const stack = [i];
    comp.set(i, cid);
    let size = 0;
    while (stack.length) {
      const cur = stack.pop();
      size++;
      for (const e of graph.adj.get(cur) ?? []) {
        if (!comp.has(e.to)) {
          comp.set(e.to, cid);
          stack.push(e.to);
        }
      }
    }
    sizes[cid] = size;
    cid++;
  }
  const keep = sizes.indexOf(Math.max(...sizes));
  const remap = new Map();
  const nodes = [];
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

function buildCells(graph, cell = 180) {
  const cells = new Map();
  for (let i = 0; i < graph.nodes.length; i++) {
    const [x, y] = graph.nodes[i].xy;
    const key = `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  }
  graph.cells = cells;
  graph.cellSize = cell;
  return graph;
}

function nearest(graph, xy, radius = 140) {
  let best = -1, bd = radius;
  const cell = graph.cellSize ?? radius;
  const cx = Math.floor(xy[0] / cell), cy = Math.floor(xy[1] / cell);
  const r = Math.ceil(radius / cell) + 1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const list = graph.cells?.get(`${cx + dx}:${cy + dy}`) ?? [];
      for (const i of list) {
        const p = graph.nodes[i].xy;
        const d = Math.hypot(p[0] - xy[0], p[1] - xy[1]);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    }
  }
  return best;
}

function astar(graph, from, to, chordA, chordB, devWeight = 1.1, visitedPenalty = null) {
  if (from === to) return { ids: [from], len: 0 };
  const g = new Map([[from, 0]]);
  const rawLen = new Map([[from, 0]]);
  const prev = new Map();
  const open = [[0, from]];
  const done = new Set();
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === to) break;
    if (done.has(cur)) continue;
    done.add(cur);
    for (const e of graph.adj.get(cur) ?? []) {
      const p = graph.nodes[e.to].xy;
      const dev = distPointSeg(p, chordA, chordB);
      const reuse = visitedPenalty?.has(e.to) ? visitedPenalty.get(e.to) : 0;
      const ng = g.get(cur) + e.len + dev * devWeight + reuse;
      if (ng < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, ng);
        rawLen.set(e.to, rawLen.get(cur) + e.len);
        prev.set(e.to, cur);
        const h = Math.hypot(p[0] - graph.nodes[to].xy[0], p[1] - graph.nodes[to].xy[1]);
        open.push([ng + h, e.to]);
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
  return { ids, len: rawLen.get(to) };
}

function transform(point, origin, ux, uy, sx, sy) {
  return [
    origin[0] + point[0] * sx * ux[0] + point[1] * sy * uy[0],
    origin[1] + point[0] * sx * ux[1] + point[1] * sy * uy[1],
  ];
}

function sneakerAnchors(origin, angle, scaleX, scaleY, motif = "outline-swoosh") {
  motif = runLabel ?? motif;
  const ux = [Math.cos(angle), Math.sin(angle)];
  const uy = [-Math.sin(angle), Math.cos(angle)];
  const P = (p) => transform(p, origin, ux, uy, scaleX, scaleY);
  const outline = [
    P([0, 0]), P([360, -28]), P([790, -28]), P([1230, 0]), P([1580, 60]), P([1800, 165]),
    P([1840, 255]), P([1735, 340]), P([1480, 405]),
    P([1180, 450]), P([900, 525]), P([670, 660]), P([500, 620]), P([350, 445]), P([155, 265]), P([0, 0]),
  ];
  const swoosh = [P([430, 250]), P([760, 155]), P([1220, 210]), P([1580, 340]), P([1090, 285]), P([760, 300]), P([430, 250])];
  const collar = [P([610, 650]), P([720, 500]), P([910, 520]), P([820, 560])];
  const soleInset = [P([260, 55]), P([700, 70]), P([1160, 95]), P([1530, 190])];
  const laceSpurs = [
    P([760, 575]), P([820, 435]), P([760, 575]),
    P([910, 520]), P([980, 405]), P([910, 520]),
    P([1060, 482]), P([1135, 395]), P([1060, 482]),
  ];
  const heelTab = [P([160, 265]), P([145, 120]), P([245, 95]), P([310, 160])];
  if (motif === "outline") return outline;
  if (motif === "outline-collar") return [...outline, ...collar];
  if (motif === "outline-sole") return [...outline, ...soleInset];
  if (motif === "outline-swoosh") return [...outline, ...swoosh];
  if (motif === "outline-swoosh-collar") return [...outline, ...swoosh, ...collar];
  if (motif === "outline-lace-spurs") return [...outline, ...laceSpurs];
  if (motif === "outline-lace-spurs-heel") return [...outline, ...laceSpurs, ...heelTab];
  return [...outline, ...swoosh, ...collar, ...soleInset];
}

function routeFromAnchors(graph, anchors) {
  const anchorIds = anchors.map((xy) => nearest(graph, xy, 170));
  if (anchorIds.some((id) => id < 0)) return null;
  const route = [];
  const visitedPenalty = new Map();
  let total = 0;
  let failures = 0;
  let reuse = 0;
  const deviations = [];
  for (let i = 1; i < anchorIds.length; i++) {
    const a = anchorIds[i - 1], b = anchorIds[i];
    const seg = astar(graph, a, b, anchors[i - 1], anchors[i], 1.4, visitedPenalty);
    if (!seg || seg.len > Math.hypot(anchors[i][0] - anchors[i - 1][0], anchors[i][1] - anchors[i - 1][1]) * 3.2 + 260) {
      failures++;
      continue;
    }
    for (const id of seg.ids) {
      if (visitedPenalty.has(id)) reuse++;
      visitedPenalty.set(id, 220);
      if (route[route.length - 1] !== id) route.push(id);
    }
    total += seg.len;
  }
  const xy = route.map((id) => graph.nodes[id].xy);
  for (const a of anchors) deviations.push(polylineDistance(xy, a));
  return { ids: route, xy, total, failures, reuse, anchorIds, meanAnchorDev: deviations.reduce((s, v) => s + v, 0) / deviations.length, maxAnchorDev: Math.max(...deviations) };
}

function scoreCandidate(c) {
  const b = bounds(c.xy);
  const width = b.maxX - b.minX;
  const height = b.maxY - b.minY;
  const aspectPenalty = Math.abs(width / Math.max(1, height) - 2.15) * 220;
  const lenPenalty = Math.abs(c.total / 1000 - 11.5) * 45;
  return c.meanAnchorDev * 3 + c.maxAnchorDev * 1.2 + c.failures * 700 + c.reuse * 1.3 + aspectPenalty + lenPenalty;
}

function candidateOrigins(graph) {
  const pts = graph.nodes.map((n) => n.xy);
  const b = bounds(pts);
  const out = [];
  for (let x = b.minX + 1200; x < b.maxX - 2200; x += 420) {
    for (let y = b.minY + 700; y < b.maxY - 1400; y += 420) out.push([x, y]);
  }
  return out;
}

async function render(graph, cand, file, title) {
  const w = 1200, h = 820;
  const rb = bounds(cand.xy);
  const padM = 360;
  const view = { minX: rb.minX - padM, maxX: rb.maxX + padM, minY: rb.minY - padM, maxY: rb.maxY + padM };
  const s = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const ox = (w - (view.maxX - view.minX) * s) / 2;
  const oy = (h - (view.maxY - view.minY) * s) / 2;
  const pr = ([x, y]) => [ox + (x - view.minX) * s, oy + (view.maxY - y) * s];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const seen = new Set();
  const streets = [];
  for (const [from, entries] of graph.adj.entries()) {
    for (const e of entries) {
      const key = from < e.to ? `${from}:${e.to}` : `${e.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = graph.nodes[from].xy, b = graph.nodes[e.to].xy;
      if (!inView(a) && !inView(b)) continue;
      const [x1, y1] = pr(a), [x2, y2] = pr(b);
      streets.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="#d9d9d9" stroke-width="1.8" stroke-linecap="round"/>`);
    }
  }
  const rd = cand.xy.map((p, i) => {
    const [x, y] = pr(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#f6f4ef"/>
    <rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="#fff"/>
    ${streets.join("\n")}
    <path d="${rd}" fill="none" stroke="#7b1024" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>
    <path d="${rd}" fill="none" stroke="#ef1744" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="36" y="54" font-family="Arial" font-size="18" font-weight="700" fill="#222">${title}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function gpx(name, graph, ids) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso street-native assembly" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${ids.map((id) => {
    const [lat, lng] = graph.nodes[id].ll;
    return `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`;
  }).join("\n")}\n</trkseg></trk></gpx>\n`;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const graph = buildCells(filterLargestComponent(await loadGraph()));
  const origins = candidateOrigins(graph);
  const angles = [-0.28, -0.12, 0.02, 0.16, 0.32, 0.48, 1.22, 1.38, 1.54, 1.7, 1.86];
  const scales = [
    [0.82, 0.72], [0.92, 0.78], [1.02, 0.82], [1.1, 0.9], [1.22, 0.96],
  ];
  const best = [];
  let tested = 0;
  for (const origin of origins) {
    for (const angle of angles) {
      for (const [sx, sy] of scales) {
        tested++;
        const anchors = sneakerAnchors(origin, angle, sx, sy);
        const cand = routeFromAnchors(graph, anchors);
        if (!cand || cand.ids.length < 20) continue;
        cand.origin = origin;
        cand.angle = angle;
        cand.scaleX = sx;
        cand.scaleY = sy;
        cand.score = scoreCandidate(cand);
        best.push(cand);
        best.sort((a, b) => a.score - b.score);
        if (best.length > 12) best.length = 12;
      }
    }
  }
  const summary = { tested, kept: best.length, graphNodes: graph.nodes.length, candidates: [] };
  for (let i = 0; i < best.length; i++) {
    const c = best[i];
    const id = `candidate-${String(i + 1).padStart(2, "0")}`;
    const file = path.join(outDir, `${id}.png`);
    await render(graph, c, file, `${id} · ${(c.total / 1000).toFixed(1)} km · score ${Math.round(c.score)}`);
    await fs.writeFile(path.join(outDir, `${id}.gpx`), gpx(id, graph, c.ids), "utf8");
    summary.candidates.push({
      id,
      km: +(c.total / 1000).toFixed(2),
      score: +c.score.toFixed(1),
      failures: c.failures,
      reuse: c.reuse,
      meanAnchorDev: +c.meanAnchorDev.toFixed(1),
      maxAnchorDev: +c.maxAnchorDev.toFixed(1),
      angle: +c.angle.toFixed(3),
      scaleX: c.scaleX,
      scaleY: c.scaleY,
      motif: c.motif,
      png: path.relative(root, file).replace(/\\/g, "/"),
      gpx: path.relative(root, path.join(outDir, `${id}.gpx`)).replace(/\\/g, "/"),
    });
  }
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(path.relative(root, outDir));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});













