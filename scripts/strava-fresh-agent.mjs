import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph, haversineMeters } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const outDir = path.join(root, "tmp-logo-proof", "strava-fresh-agent");
const M = 111320;
const origin = [40.748, -73.994];
const xAxis = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const yAxis = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };

// A semantic, block-logo Strava interpretation: two filled chevrons expressed
// as outline vertices. The algorithm may search placement/scale/orientation,
// but it routes only between these structural anchors, avoiding contour noise.
const motif = {
  top: [
    [0.00, 0.48],
    [0.42, 1.00],
    [0.83, 0.48],
    [0.66, 0.48],
    [0.42, 0.78],
    [0.18, 0.48],
    [0.00, 0.48],
  ],
  lower: [
    [0.44, 0.44],
    [0.64, 0.04],
    [0.98, 0.44],
    [0.80, 0.44],
    [0.64, 0.22],
    [0.54, 0.44],
    [0.44, 0.44],
  ],
};

function toLocal([lat, lng]) {
  const m = M * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M;
  const e = (lng - origin[1]) * m;
  const det = xAxis.e * yAxis.n - yAxis.e * xAxis.n;
  return [(e * yAxis.n - yAxis.e * n) / det, (xAxis.e * n - e * xAxis.n) / det];
}

function toLatLng([x, y]) {
  const e = x * xAxis.e + y * yAxis.e;
  const n = x * xAxis.n + y * yAxis.n;
  const lat = origin[0] + n / M;
  const lng = origin[1] + e / (M * Math.cos((origin[0] * Math.PI) / 180));
  return [lat, lng];
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function boundsLocal(ps) {
  const xs = ps.map((p) => p[0]);
  const ys = ps.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function pointSegDist(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const l2 = vx * vx + vy * vy;
  if (l2 === 0) return Math.hypot(wx, wy);
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / l2));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function buildLocalIndex(graph) {
  const local = graph.nodes.map(toLocal);
  const cellM = 180;
  const cells = new Map();
  for (let i = 0; i < local.length; i++) {
    const p = local[i];
    const key = `${Math.round(p[0] / cellM)}:${Math.round(p[1] / cellM)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  }
  return { local, cells, cellM };
}

function nearestNode(index, target, maxM) {
  const cx = Math.round(target[0] / index.cellM);
  const cy = Math.round(target[1] / index.cellM);
  const rMax = Math.ceil(maxM / index.cellM) + 1;
  let best = -1;
  let bestD = maxM;
  for (let r = 0; r <= rMax; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const list = index.cells.get(`${cx + dx}:${cy + dy}`);
        if (!list) continue;
        for (const n of list) {
          const d = dist(index.local[n], target);
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    if (best >= 0 && bestD < index.cellM * r) break;
  }
  return { node: best, d: bestD };
}

function shortestHug(graph, index, from, to, devWeight, maxVisit = 12000) {
  if (from === to) return { nodes: [from], meters: 0 };
  const a = index.local[from];
  const b = index.local[to];
  const lenAt = new Map([[from, 0]]);
  const costAt = new Map([[from, 0]]);
  const prev = new Map();
  const done = new Set();
  const open = [[dist(a, b), 0, from]];
  while (open.length && done.size < maxVisit) {
    let bestI = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bestI][0]) bestI = i;
    const [, gc, cur] = open.splice(bestI, 1)[0];
    if (cur === to) break;
    if (done.has(cur)) continue;
    done.add(cur);
    const curP = index.local[cur];
    for (const e of graph.adj.get(cur) ?? []) {
      const nextP = index.local[e.to];
      const dev = pointSegDist(nextP, a, b);
      const prevNode = prev.get(cur);
      let turnPenalty = 0;
      if (prevNode !== undefined) {
        const p0 = index.local[prevNode];
        const ux = curP[0] - p0[0];
        const uy = curP[1] - p0[1];
        const vx = nextP[0] - curP[0];
        const vy = nextP[1] - curP[1];
        const ul = Math.hypot(ux, uy);
        const vl = Math.hypot(vx, vy);
        if (ul > 1 && vl > 1) {
          const dot = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (ul * vl)));
          turnPenalty = (1 - dot) * 12;
        }
      }
      const ng = gc + e.len + dev * devWeight + turnPenalty;
      if (ng < (costAt.get(e.to) ?? Infinity)) {
        costAt.set(e.to, ng);
        lenAt.set(e.to, (lenAt.get(cur) ?? 0) + e.len);
        prev.set(e.to, cur);
        open.push([ng + dist(nextP, b), ng, e.to]);
      }
    }
  }
  if (!prev.has(to)) return null;
  const nodes = [];
  let cur = to;
  while (cur !== undefined) {
    nodes.push(cur);
    cur = prev.get(cur);
  }
  nodes.reverse();
  return { nodes, meters: lenAt.get(to) ?? 0 };
}

function appendNodePath(out, graph, nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const node = graph.nodes[nodes[i]];
    if (i > 0) {
      const prev = nodes[i - 1];
      const entry = (graph.adj.get(prev) ?? []).find((e) => e.to === nodes[i]);
      if (entry) for (const v of entry.via ?? []) out.push(v);
    }
    const last = out[out.length - 1];
    if (!last || last[0] !== node[0] || last[1] !== node[1]) out.push(node);
  }
}

function routeAnchors(graph, index, anchors, devWeight) {
  const chain = [];
  const routedNodes = [];
  let meters = 0;
  const legStats = [];
  for (let i = 1; i < anchors.length; i++) {
    const leg = shortestHug(graph, index, anchors[i - 1], anchors[i], devWeight);
    if (!leg) return null;
    const chord = dist(index.local[anchors[i - 1]], index.local[anchors[i]]);
    const detour = leg.meters / Math.max(1, chord);
    if (detour > 2.8) return null;
    appendNodePath(chain, graph, leg.nodes);
    for (const node of leg.nodes) {
      if (routedNodes[routedNodes.length - 1] !== node) routedNodes.push(node);
    }
    meters += leg.meters;
    legStats.push({ chord, meters: leg.meters, detour });
  }
  return { chain, meters, legStats, routedNodes };
}

function transformMotif(poly, center, scale, rotDeg, squeeze) {
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return poly.map(([x, y]) => {
    const px = (x - 0.49) * scale;
    const py = (y - 0.51) * scale * squeeze;
    return [center[0] + px * cos - py * sin, center[1] + px * sin + py * cos];
  });
}

function snapPoly(index, poly, radiusM) {
  const snaps = poly.map((p) => nearestNode(index, p, radiusM));
  if (snaps.some((s) => s.node < 0)) return null;
  const nodes = [];
  let snapErr = 0;
  for (const s of snaps) {
    snapErr += s.d;
    if (nodes[nodes.length - 1] !== s.node) nodes.push(s.node);
  }
  if (nodes.length < 5) return null;
  if (nodes[0] !== nodes[nodes.length - 1]) nodes.push(nodes[0]);
  return { nodes, snapErr };
}

function routeKm(chains) {
  let m = 0;
  for (const chain of chains) for (let i = 1; i < chain.length; i++) m += haversineMeters(chain[i - 1], chain[i]);
  return m / 1000;
}

function turnStats(index, nodeChains) {
  let turns = 0;
  let hardTurns = 0;
  let tinyZigs = 0;
  for (const nodes of nodeChains) {
    for (let i = 1; i < nodes.length - 1; i++) {
      const a = index.local[nodes[i - 1]];
      const b = index.local[nodes[i]];
      const c = index.local[nodes[i + 1]];
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const vx = c[0] - b[0];
      const vy = c[1] - b[1];
      const ul = Math.hypot(ux, uy);
      const vl = Math.hypot(vx, vy);
      if (ul < 1 || vl < 1) continue;
      const dot = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (ul * vl)));
      const deg = (Math.acos(dot) * 180) / Math.PI;
      if (deg > 18) turns++;
      if (deg > 70) hardTurns++;
      if (deg > 35 && Math.min(ul, vl) < 90) tinyZigs++;
    }
  }
  return { turns, hardTurns, tinyZigs };
}

function componentScore(index, topRoute, lowerRoute, snapErr, scale) {
  const all = [...topRoute.chain, ...lowerRoute.chain].map(toLocal);
  const b = boundsLocal(all);
  const aspect = (b.maxX - b.minX) / Math.max(1, b.maxY - b.minY);
  const km = routeKm([topRoute.chain, lowerRoute.chain]);
  const turns = turnStats(index, [topRoute.routedNodes, lowerRoute.routedNodes]);
  const detourPenalty = [...topRoute.legStats, ...lowerRoute.legStats].reduce((sum, l) => sum + Math.max(0, l.detour - 1.65) * 14, 0);
  return (
    100 -
    snapErr / Math.max(1, scale * 0.055) -
    Math.abs(aspect - 0.84) * 20 -
    Math.abs(km - 15) * 0.18 -
    turns.turns * 1.35 -
    turns.hardTurns * 1.25 -
    turns.tinyZigs * 12 -
    detourPenalty
  );
}

function connectSingleRun(graph, index, topChain, lowerChain) {
  const topEnd = nearestNode(index, toLocal(topChain[topChain.length - 1]), 20).node;
  const lowerStart = nearestNode(index, toLocal(lowerChain[0]), 20).node;
  if (topEnd < 0 || lowerStart < 0) return null;
  const leg = shortestHug(graph, index, topEnd, lowerStart, 0.35, 9000);
  if (!leg) return null;
  const connector = [];
  appendNodePath(connector, graph, leg.nodes);
  return { connector, meters: leg.meters };
}

function boundsLatLng(ps) {
  const lats = ps.map((p) => p[0]);
  const lngs = ps.map((p) => p[1]);
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
}

function projectLatLng(ps, w, h, pad = 76) {
  const b = boundsLatLng(ps);
  const mid = (b.minLat + b.maxLat) / 2;
  const mx = M * Math.cos((mid * Math.PI) / 180);
  const spanX = Math.max(1, (b.maxLng - b.minLng) * mx);
  const spanY = Math.max(1, (b.maxLat - b.minLat) * M);
  const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * s) / 2;
  const oy = (h - spanY * s) / 2;
  return (p) => [ox + (p[1] - b.minLng) * mx * s, oy + (b.maxLat - p[0]) * M * s];
}

function svgPath(ps, pr) {
  return ps
    .map((p, i) => {
      const q = pr(p);
      return `${i ? "L" : "M"} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
    })
    .join(" ");
}

async function renderCandidate(parts, file, label, source = false) {
  const all = parts.flat();
  const w = 1080;
  const h = 820;
  const pr = projectLatLng(all, w, h);
  const strokes = parts
    .map((seg, i) => {
      const color = i === 1 ? "#555" : i === 2 ? "#ff9b70" : "#fc4c02";
      return `<path d="${svgPath(seg, pr)}" fill="none" stroke="${color}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><path d="${svgPath(seg, pr)}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".72"/>`;
    })
    .join("");
  const marker = source ? `<text x="24" y="74" font-family="Arial" font-size="17" fill="#555">structural vertices, then lattice routed</text>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${strokes}<text x="24" y="38" font-family="Arial" font-size="20" font-weight="700" fill="#111">${label}</text>${marker}</svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toFile(file);
}

function gpx(name, parts) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso Strava fresh agent scratch" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name>
${parts
  .map(
    (seg) => `<trkseg>
${seg.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}
</trkseg>`,
  )
  .join("\n")}
</trk></gpx>
`;
}

function singleGpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso Strava fresh agent scratch" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>
${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}
</trkseg></trk></gpx>
`;
}

async function makeSheet(rows) {
  const cells = [];
  for (const row of rows.slice(0, 12)) {
    const input = await sharp(path.join(root, row.image)).resize(540, 410, { fit: "contain", background: "#fff" }).jpeg().toBuffer();
    cells.push({ input, left: (cells.length % 2) * 540, top: Math.floor(cells.length / 2) * 410 });
  }
  await sharp({ create: { width: 1080, height: Math.max(820, Math.ceil(cells.length / 2) * 410), channels: 3, background: "#fff" } })
    .composite(cells)
    .jpeg({ quality: 92 })
    .toFile(path.join(outDir, "candidate-sheet.jpg"));
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const graph = buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8")));
  const index = buildLocalIndex(graph);
  const centerPool = index.local
    .map((p, node) => ({ p, node }))
    .filter(({ p }) => p[0] > 200 && p[0] < 4600 && p[1] > -2600 && p[1] < 5200);
  const candidates = [];
  let checked = 0;
  for (let i = 0; i < centerPool.length; i += 22) {
    const center = centerPool[i].p;
    for (const scale of [980, 1220, 1500, 1780, 2100]) {
      for (const rot of [-18, -10, 0, 10, 18]) {
        for (const squeeze of [0.9, 1.0, 1.12]) {
          checked++;
          const topTarget = transformMotif(motif.top, center, scale, rot, squeeze);
          const lowerTarget = transformMotif(motif.lower, center, scale, rot, squeeze);
          const bb = boundsLocal([...topTarget, ...lowerTarget]);
          if (bb.minX < -700 || bb.maxX > 5600 || bb.minY < -4300 || bb.maxY > 7100) continue;
          const topSnap = snapPoly(index, topTarget, Math.max(130, scale * 0.18));
          const lowerSnap = snapPoly(index, lowerTarget, Math.max(130, scale * 0.18));
          if (!topSnap || !lowerSnap) continue;
          const topRoute = routeAnchors(graph, index, topSnap.nodes, 1.9);
          const lowerRoute = routeAnchors(graph, index, lowerSnap.nodes, 1.9);
          if (!topRoute || !lowerRoute) continue;
          const km = routeKm([topRoute.chain, lowerRoute.chain]);
          if (km < 5 || km > 35) continue;
          const snapErr = topSnap.snapErr + lowerSnap.snapErr;
          const score = componentScore(index, topRoute, lowerRoute, snapErr, scale);
          candidates.push({ score, km, scale, rot, squeeze, topSnap, lowerSnap, topRoute, lowerRoute, snapErr });
        }
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const withConnectors = [];
  for (const c of candidates.slice(0, 120)) {
    const connector = connectSingleRun(graph, index, c.topRoute.chain, c.lowerRoute.chain);
    const connectorKm = connector ? connector.meters / 1000 : 99;
    withConnectors.push({ ...c, connector, finalScore: c.score - connectorKm * 5 });
  }
  withConnectors.sort((a, b) => b.finalScore - a.finalScore);

  const rows = [];
  let n = 0;
  for (const c of withConnectors.slice(0, 18)) {
    const id = `fresh-${String(++n).padStart(2, "0")}`;
    const parts = c.connector ? [c.topRoute.chain, c.connector.connector, c.lowerRoute.chain] : [c.topRoute.chain, c.lowerRoute.chain];
    const chain = c.connector ? [...c.topRoute.chain, ...c.connector.connector, ...c.lowerRoute.chain] : [...c.topRoute.chain, ...c.lowerRoute.chain];
    const image = path.join(outDir, `${id}.jpg`);
    await renderCandidate(parts, image, `${id} ${routeKm([chain]).toFixed(1)} km score ${c.finalScore.toFixed(1)}`, true);
    await fs.writeFile(path.join(outDir, `${id}-segments.gpx`), gpx(`${id} Strava segmented`, [c.topRoute.chain, c.lowerRoute.chain]));
    await fs.writeFile(path.join(outDir, `${id}-single-run.gpx`), singleGpx(`${id} Strava single run`, chain));
    rows.push({
      id,
      score: +c.finalScore.toFixed(2),
      rawScore: +c.score.toFixed(2),
      km: +routeKm([chain]).toFixed(2),
      componentKm: +c.km.toFixed(2),
      connectorKm: c.connector ? +(c.connector.meters / 1000).toFixed(2) : null,
      scale: c.scale,
      rot: c.rot,
      squeeze: c.squeeze,
      snapErr: +c.snapErr.toFixed(1),
      image: path.relative(root, image).replace(/\\/g, "/"),
      segmentedGpx: path.relative(root, path.join(outDir, `${id}-segments.gpx`)).replace(/\\/g, "/"),
      singleRunGpx: path.relative(root, path.join(outDir, `${id}-single-run.gpx`)).replace(/\\/g, "/"),
    });
  }
  await makeSheet(rows);
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({ checked, candidates: candidates.length, rows }, null, 2));
  console.log(JSON.stringify({ checked, candidates: candidates.length, best: rows[0], sheet: path.relative(root, path.join(outDir, "candidate-sheet.jpg")).replace(/\\/g, "/") }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});




