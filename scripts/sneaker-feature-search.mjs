import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const city = process.argv[2] ?? "dc-core";
const outDir = path.join(root, "tmp-sneaker-feature-search", `${city}-${stamp}`);

const M_LAT = 111320;
const WALKABLE = new Set([
  "residential", "secondary", "primary", "tertiary", "unclassified",
  "living_street", "pedestrian", "service", "footway", "path", "cycleway",
  "secondary_link", "primary_link", "tertiary_link",
]);

const presets = {
  manhattan: {
    raw: path.join(root, "tmp-gas-spike", "osm-walk-network.json"),
    bounds: { south: 40.700, west: -74.020, north: 40.770, east: -73.958 },
  },
  brooklyn: {
    raw: path.join(root, "tmp-city-osm", "brooklyn", "osm-walk-network.json"),
    bounds: { south: 40.57, west: -74.03, north: 40.74, east: -73.855 },
  },
  chicago: {
    raw: path.join(root, "tmp-city-osm", "chicago", "osm-walk-network.json"),
    bounds: { south: 41.79, west: -87.74, north: 41.99, east: -87.58 },
  },
  sf: {
    raw: path.join(root, "tmp-city-osm", "sf", "osm-walk-network.json"),
    bounds: { south: 37.73, west: -122.52, north: 37.81, east: -122.385 },
  },
  dc: {
    raw: path.join(root, "tmp-city-osm", "dc", "osm-walk-network.json"),
    bounds: { south: 38.82, west: -77.12, north: 38.99, east: -76.91 },
  },
};

function metersPerLng(lat) {
  return M_LAT * Math.cos((lat * Math.PI) / 180);
}

function hav(a, b) {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function bounds(points) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return { minX, maxX, minY, maxY };
}

function pointSegDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const l2 = vx * vx + vy * vy;
  if (l2 < 1e-6) return Math.hypot(wx, wy);
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / l2));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

async function sourceForCity(name) {
  if (presets[name]) return presets[name];
  const dir = path.join(root, "tmp-city-osm", name);
  const bounds = JSON.parse(await fs.readFile(path.join(dir, "bounds.json"), "utf8"));
  return { raw: path.join(dir, "osm-walk-network.json"), bounds };
}

async function loadGraph(name) {
  const src = await sourceForCity(name);
  const origin = [(src.bounds.south + src.bounds.north) / 2, (src.bounds.west + src.bounds.east) / 2];
  const toXY = ([lat, lng]) => [(lng - origin[1]) * metersPerLng(origin[0]), (lat - origin[0]) * M_LAT];
  const raw = JSON.parse(await fs.readFile(src.raw, "utf8"));
  const coords = new Map();
  for (const el of raw.elements) if (el.type === "node") coords.set(el.id, [el.lat, el.lon]);
  const inBounds = ([lat, lng]) => lat >= src.bounds.south && lat <= src.bounds.north && lng >= src.bounds.west && lng <= src.bounds.east;
  const nodes = [], index = new Map(), adj = new Map();
  const idx = (id) => {
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
  };
  for (const el of raw.elements) {
    if (el.type !== "way" || !el.nodes || el.nodes.length < 2) continue;
    const hw = el.tags?.highway;
    if (!WALKABLE.has(hw) && !el.tags?.name) continue;
    if (el.tags?.access === "private" || el.tags?.foot === "no") continue;
    for (let i = 1; i < el.nodes.length; i++) {
      const aLL = coords.get(el.nodes[i - 1]), bLL = coords.get(el.nodes[i]);
      if (!aLL || !bLL || !inBounds(aLL) || !inBounds(bLL)) continue;
      const a = idx(el.nodes[i - 1]), b = idx(el.nodes[i]);
      if (a < 0 || b < 0) continue;
      const len = hav(nodes[a].ll, nodes[b].ll);
      if (!Number.isFinite(len) || len < 1 || len > 500) continue;
      adj.get(a).push({ to: b, len });
      adj.get(b).push({ to: a, len });
    }
  }
  return buildCells(largestComponent({ nodes, adj, origin }), 160);
}

function largestComponent(graph) {
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
  const nodes = [], remap = new Map();
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
  return { nodes, adj, origin: graph.origin };
}

function buildCells(graph, cell) {
  const cells = new Map();
  graph.nodes.forEach((n, i) => {
    const [x, y] = n.xy;
    const key = `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  });
  graph.cell = cell;
  graph.cells = cells;
  return graph;
}

function nearest(graph, xy, radius = 180) {
  const cx = Math.floor(xy[0] / graph.cell), cy = Math.floor(xy[1] / graph.cell);
  const cr = Math.ceil(radius / graph.cell) + 1;
  let best = -1, bd = radius;
  for (let dx = -cr; dx <= cr; dx++) for (let dy = -cr; dy <= cr; dy++) {
    for (const id of graph.cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
      const d = dist(graph.nodes[id].xy, xy);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
  }
  return best;
}

function astar(graph, from, to, a, b, devWeight = 0.85, maxSettle = 14000) {
  if (from === to) return { ids: [from], len: 0 };
  const g = new Map([[from, 0]]), raw = new Map([[from, 0]]), prev = new Map();
  const open = [[dist(graph.nodes[from].xy, graph.nodes[to].xy), from]];
  const done = new Set();
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === to) break;
    if (done.has(cur)) continue;
    done.add(cur);
    if (done.size > maxSettle) return null;
    for (const e of graph.adj.get(cur) ?? []) {
      const p = graph.nodes[e.to].xy;
      const dev = pointSegDist(p, a, b);
      const ng = (g.get(cur) ?? Infinity) + e.len + dev * devWeight;
      if (ng < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, ng);
        raw.set(e.to, (raw.get(cur) ?? 0) + e.len);
        prev.set(e.to, cur);
        open.push([ng + dist(p, graph.nodes[to].xy), e.to]);
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

function shapeFromSole(a, b, heightRatio, toeOutRatio, heelRiseRatio) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len = Math.hypot(vx, vy);
  const ux = [vx / len, vy / len];
  const up = [-ux[1], ux[0]];
  const P = (x, y) => [a[0] + ux[0] * len * x + up[0] * len * y, a[1] + ux[1] * len * x + up[1] * len * y];
  return [
    P(0.00, 0.00), P(0.20, -0.018), P(0.50, -0.012), P(0.77, 0.00), P(0.95, 0.025),
    P(1.05 + toeOutRatio, 0.075), P(1.10 + toeOutRatio, 0.14), P(1.05, 0.205), P(0.92, 0.245),
    P(0.72, 0.245 * heightRatio), P(0.53, 0.31 * heightRatio), P(0.37, 0.40 * heightRatio),
    P(0.26, 0.48 * heightRatio), P(0.15, 0.42 * heightRatio), P(0.06, 0.24 * heightRatio),
    P(-0.015, 0.085 * heelRiseRatio), P(0.00, 0.00),
  ];
}

function routeCandidate(graph, anchors) {
  const pins = anchors.map((p) => nearest(graph, p, 190));
  if (pins.some((p) => p < 0)) return null;
  const ids = [];
  let len = 0, failures = 0;
  const devs = [];
  for (let i = 1; i < pins.length; i++) {
    const chord = dist(anchors[i - 1], anchors[i]);
    const seg = astar(graph, pins[i - 1], pins[i], anchors[i - 1], anchors[i]);
    if (!seg || seg.len > chord * 3.15 + 240) {
      failures++;
      continue;
    }
    for (const id of seg.ids) if (ids[ids.length - 1] !== id) ids.push(id);
    len += seg.len;
  }
  const route = ids.map((id) => graph.nodes[id].xy);
  for (const a of anchors) {
    let best = Infinity;
    for (let i = 1; i < route.length; i++) best = Math.min(best, pointSegDist(a, route[i - 1], route[i]));
    devs.push(best);
  }
  return {
    ids,
    xy: route,
    km: len / 1000,
    failures,
    meanDev: devs.reduce((s, v) => s + v, 0) / devs.length,
    maxDev: Math.max(...devs),
  };
}

function visualScore(c) {
  const b = bounds(c.xy);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const aspect = w / Math.max(1, h);
  const aspectPenalty = Math.abs(aspect - 2.75) * 190;
  const lenPenalty = Math.abs(c.km - 11.2) * 35;
  return c.meanDev * 3 + c.maxDev * 1.1 + c.failures * 800 + aspectPenalty + lenPenalty;
}

function sampleSoles(graph) {
  const nodes = graph.nodes;
  const b = bounds(nodes.map((n) => n.xy));
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const stride = span < 4200 ? 5 : span > 12000 ? 29 : 17;
  const minLen = span < 4200 ? 850 : 1450;
  const maxLen = span < 4200 ? 1750 : 2450;
  const margin = span < 4200 ? 180 : 550;
  const coarse = nodes.filter((_, i) => i % stride === 0);
  const out = [];
  for (const aNode of coarse) {
    for (const bNode of coarse) {
      const dx = bNode.xy[0] - aNode.xy[0], dy = bNode.xy[1] - aNode.xy[1];
      const d = Math.hypot(dx, dy);
      if (d < minLen || d > maxLen) continue;
      const angle = Math.atan2(dy, dx);
      const abs = Math.abs(Math.sin(angle));
      if (abs > 0.60) continue;
      if (aNode.xy[0] > bNode.xy[0]) continue;
      if (aNode.xy[0] < b.minX + margin || bNode.xy[0] > b.maxX - margin) continue;
      out.push([aNode.xy, bNode.xy]);
      if (out.length >= (span > 12000 ? 700 : 1800)) return out;
    }
  }
  return out;
}

async function render(graph, cand, file) {
  const w = 1200, h = 800;
  const rb = bounds(cand.xy);
  const pad = 360;
  const view = { minX: rb.minX - pad, maxX: rb.maxX + pad, minY: rb.minY - pad, maxY: rb.maxY + pad };
  const scale = Math.min((w - 70) / (view.maxX - view.minX), (h - 70) / (view.maxY - view.minY));
  const ox = (w - (view.maxX - view.minX) * scale) / 2, oy = (h - (view.maxY - view.minY) * scale) / 2;
  const pr = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const visible = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const seen = new Set(), streets = [];
  for (const [from, entries] of graph.adj.entries()) for (const e of entries) {
    const key = from < e.to ? `${from}:${e.to}` : `${e.to}:${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = graph.nodes[from].xy, b = graph.nodes[e.to].xy;
    if (!visible(a) && !visible(b)) continue;
    const [x1, y1] = pr(a), [x2, y2] = pr(b);
    streets.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="#d8d8d8" stroke-width="1.4" fill="none" stroke-linecap="round"/>`);
  }
  const rd = cand.xy.map((p, i) => {
    const [x, y] = pr(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${streets.join("\n")}
    <path d="${rd}" stroke="#bc1838" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${rd}" stroke="#f04437" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="28" y="38" font-family="Arial" font-size="17" font-weight="700" fill="#222">${cand.id} · ${cand.km.toFixed(1)} km · score ${Math.round(cand.score)}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function gpx(graph, ids, name) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso feature search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${ids.map((id) => {
    const [lat, lng] = graph.nodes[id].ll;
    return `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`;
  }).join("\n")}\n</trkseg></trk></gpx>\n`;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const graph = await loadGraph(city);
  const best = [];
  let tested = 0;
  for (const [a, b] of sampleSoles(graph)) {
    for (const height of [0.56, 0.66, 0.78]) {
      for (const toe of [-0.02, 0.03, 0.08]) {
        for (const heel of [0.80, 1.05, 1.25]) {
          tested++;
          const anchors = shapeFromSole(a, b, height, toe, heel);
          const c = routeCandidate(graph, anchors);
          if (!c || c.ids.length < 30 || c.failures > 0) continue;
          c.score = visualScore(c);
          c.height = height;
          c.toe = toe;
          c.heel = heel;
          best.push(c);
          best.sort((x, y) => x.score - y.score);
          if (best.length > 16) best.length = 16;
        }
      }
    }
  }
  const summary = { city, tested, kept: best.length, graphNodes: graph.nodes.length, candidates: [] };
  for (let i = 0; i < best.length; i++) {
    const c = best[i];
    c.id = `feature-${String(i + 1).padStart(2, "0")}`;
    const png = path.join(outDir, `${c.id}.png`);
    await render(graph, c, png);
    await fs.writeFile(path.join(outDir, `${c.id}.gpx`), gpx(graph, c.ids, c.id), "utf8");
    summary.candidates.push({
      id: c.id,
      km: +c.km.toFixed(2),
      score: +c.score.toFixed(1),
      meanDev: +c.meanDev.toFixed(1),
      maxDev: +c.maxDev.toFixed(1),
      height: c.height,
      toe: c.toe,
      heel: c.heel,
      png: path.relative(root, png).replace(/\\/g, "/"),
      gpx: path.relative(root, path.join(outDir, `${c.id}.gpx`)).replace(/\\/g, "/"),
    });
  }
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(path.relative(root, outDir));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

