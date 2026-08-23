import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph, haversineMeters } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const inFile = path.join(
  root,
  "tmp-logo-proof",
  "strava-single-run-from-block",
  "strava-single-run-visible-connector.gpx",
);
const outDir = path.join(root, "tmp-logo-proof", "strava-street-shortcut-clean");
const M = 111320;
const origin = [40.748, -73.994];
const X = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };

function toLocal([lat, lng]) {
  const m = M * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M;
  const e = (lng - origin[1]) * m;
  const det = X.e * Y.n - Y.e * X.n;
  return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det];
}

function parse(xml) {
  const pts = [];
  const re = /<trkpt lat="([^"]+)" lon="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml))) pts.push([+m[1], +m[2]]);
  return pts;
}

function km(ps) {
  let t = 0;
  for (let i = 1; i < ps.length; i++) t += haversineMeters(ps[i - 1], ps[i]);
  return t / 1000;
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function nearestNode(graph, p) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const d = haversineMeters(p, graph.nodes[i]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

function shortest(graph, from, to, maxVisit = 8000) {
  if (from === to) return { path: [from], m: 0 };
  const D = new Map([[from, 0]]);
  const P = new Map();
  const done = new Set();
  const open = [[haversineMeters(graph.nodes[from], graph.nodes[to]), from]];
  while (open.length && done.size < maxVisit) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === to) break;
    if (done.has(cur)) continue;
    done.add(cur);
    const cd = D.get(cur) ?? Infinity;
    for (const e of graph.adj.get(cur) ?? []) {
      const nd = cd + e.len;
      if (nd < (D.get(e.to) ?? Infinity)) {
        D.set(e.to, nd);
        P.set(e.to, cur);
        open.push([nd + haversineMeters(graph.nodes[e.to], graph.nodes[to]), e.to]);
      }
    }
  }
  if (!P.has(to)) return null;
  const path = [];
  let cur = to;
  while (cur !== undefined) {
    path.push(cur);
    cur = P.get(cur);
  }
  path.reverse();
  return { path, m: D.get(to) ?? 0 };
}

function nodeLength(graph, nodes) {
  let total = 0;
  for (let i = 1; i < nodes.length; i++) total += haversineMeters(graph.nodes[nodes[i - 1]], graph.nodes[nodes[i]]);
  return total;
}

function boundsLocal(graph, nodes) {
  const pts = nodes.map((n) => toLocal(graph.nodes[n]));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function insideBounds(graph, nodes, b, pad) {
  return nodes.every((n) => {
    const p = toLocal(graph.nodes[n]);
    return p[0] >= b.minX - pad && p[0] <= b.maxX + pad && p[1] >= b.minY - pad && p[1] <= b.maxY + pad;
  });
}

function turnCost(graph, nodes) {
  let cost = 0;
  for (let i = 1; i < nodes.length - 1; i++) {
    const a = toLocal(graph.nodes[nodes[i - 1]]);
    const b = toLocal(graph.nodes[nodes[i]]);
    const c = toLocal(graph.nodes[nodes[i + 1]]);
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const ul = Math.hypot(ux, uy);
    const vl = Math.hypot(vx, vy);
    if (ul < 1 || vl < 1) continue;
    const dot = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (ul * vl)));
    cost += 1 - dot;
  }
  return cost;
}

function simplifyNodes(graph, original, opts) {
  let nodes = original.slice();
  let changed = true;
  let edits = 0;
  while (changed && edits < 220) {
    changed = false;
    let best = null;
    for (let i = 0; i < nodes.length - 3; i++) {
      const maxJ = Math.min(nodes.length - 1, i + opts.window);
      for (let j = i + 3; j <= maxJ; j++) {
        if (nodes[i] === nodes[j]) continue;
        const old = nodes.slice(i, j + 1);
        const oldLen = nodeLength(graph, old);
        if (oldLen < opts.minOldM) continue;
        const repl = shortest(graph, nodes[i], nodes[j], 3500);
        if (!repl || repl.path.length < 2) continue;
        if (repl.path.length >= old.length) continue;
        const save = oldLen - repl.m;
        const oldTurn = turnCost(graph, old);
        const newTurn = turnCost(graph, repl.path);
        if (save < opts.minSaveM && oldTurn - newTurn < opts.minTurnSave) continue;
        if (repl.m > oldLen * opts.maxRatio) continue;
        if (!insideBounds(graph, repl.path, boundsLocal(graph, old), opts.boundsPadM)) continue;
        const gain = save * opts.saveWeight + (oldTurn - newTurn) * 70 - (repl.path.length - 2) * 3;
        if (!best || gain > best.gain) best = { i, j, repl: repl.path, gain };
      }
    }
    if (best && best.gain > 0) {
      nodes = [...nodes.slice(0, best.i), ...best.repl, ...nodes.slice(best.j + 1)];
      changed = true;
      edits++;
    }
  }
  return { nodes, edits };
}

function appendNodePath(out, graph, nodePath) {
  for (let i = 0; i < nodePath.length; i++) {
    const node = graph.nodes[nodePath[i]];
    if (i > 0) {
      const prev = nodePath[i - 1];
      const entry = (graph.adj.get(prev) ?? []).find((e) => e.to === nodePath[i]);
      if (entry) for (const v of entry.via ?? []) out.push(v);
    }
    const last = out[out.length - 1];
    if (!last || last[0] !== node[0] || last[1] !== node[1]) out.push(node);
  }
}

function toChain(graph, nodes) {
  const out = [];
  appendNodePath(out, graph, nodes);
  return out;
}

function splitByRatio(chain) {
  return [chain.slice(0, 642), chain.slice(642, 644), chain.slice(644)];
}

function bounds(ps) {
  const lats = ps.map((p) => p[0]);
  const lngs = ps.map((p) => p[1]);
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
}

function project(ps, w, h, pad = 70) {
  const b = bounds(ps);
  const mid = (b.minLat + b.maxLat) / 2;
  const mx = 111320 * Math.cos((mid * Math.PI) / 180);
  const spanX = Math.max(1, (b.maxLng - b.minLng) * mx);
  const spanY = Math.max(1, (b.maxLat - b.minLat) * 111320);
  const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * s) / 2;
  const oy = (h - spanY * s) / 2;
  return (p) => [ox + (p[1] - b.minLng) * mx * s, oy + (b.maxLat - p[0]) * 111320 * s];
}

function d(ps, pr) {
  return ps
    .map((p, i) => {
      const q = pr(p);
      return `${i ? "L" : "M"} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
    })
    .join(" ");
}

async function render(parts, file, label) {
  const all = parts.flat();
  const w = 1100;
  const h = 850;
  const pr = project(all, w, h);
  const paths = parts
    .map(
      (seg, i) =>
        `<path d="${d(seg, pr)}" fill="none" stroke="${i === 1 ? "#666" : i === 2 ? "#ff9b70" : "#fc4c02"}" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/><path d="${d(seg, pr)}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".65"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${paths}<text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toFile(file);
}

function gpx(name, ps) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso Strava street shortcut clean" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>
${ps.map(([la, ln]) => `<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}
</trkseg></trk></gpx>
`;
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const graph = buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8")));
  const pts = parse(await fs.readFile(inFile, "utf8"));
  const baseNodes = [];
  for (const p of pts) {
    const n = nearestNode(graph, p);
    if (baseNodes[baseNodes.length - 1] !== n) baseNodes.push(n);
  }
  const variants = [
    { id: "mild", window: 8, minOldM: 120, minSaveM: 45, minTurnSave: 1.2, maxRatio: 0.96, boundsPadM: 35, saveWeight: 1 },
    { id: "medium", window: 12, minOldM: 150, minSaveM: 70, minTurnSave: 1.0, maxRatio: 0.98, boundsPadM: 55, saveWeight: 1 },
    { id: "strong", window: 18, minOldM: 180, minSaveM: 85, minTurnSave: 0.8, maxRatio: 1.0, boundsPadM: 75, saveWeight: 1 },
    { id: "visual", window: 24, minOldM: 180, minSaveM: 55, minTurnSave: 0.6, maxRatio: 1.03, boundsPadM: 90, saveWeight: 0.6 },
  ];
  const rows = [];
  for (const opts of variants) {
    const { nodes, edits } = simplifyNodes(graph, baseNodes, opts);
    const chain = toChain(graph, nodes);
    const parts = splitByRatio(chain);
    const file = path.join(outDir, `strava-shortcut-${opts.id}.jpg`);
    await render(parts, file, `${opts.id} ${km(chain).toFixed(1)} km edits ${edits}`);
    await fs.writeFile(path.join(outDir, `strava-shortcut-${opts.id}.gpx`), gpx(`Strava shortcut ${opts.id}`, chain));
    rows.push({
      id: opts.id,
      edits,
      km: +km(chain).toFixed(2),
      points: chain.length,
      image: path.relative(root, file).replace(/\\/g, "/"),
      gpx: path.relative(root, path.join(outDir, `strava-shortcut-${opts.id}.gpx`)).replace(/\\/g, "/"),
    });
  }
  const comps = [];
  for (const row of rows) {
    const input = await sharp(path.join(root, row.image)).resize(550, 425, { fit: "contain", background: "#fff" }).jpeg().toBuffer();
    comps.push({ input, left: (comps.length % 2) * 550, top: Math.floor(comps.length / 2) * 425 });
  }
  await sharp({ create: { width: 1100, height: Math.ceil(comps.length / 2) * 425, channels: 3, background: "#fff" } })
    .composite(comps)
    .jpeg({ quality: 92 })
    .toFile(path.join(outDir, "candidate-sheet.jpg"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify({ sheet: path.relative(root, path.join(outDir, "candidate-sheet.jpg")).replace(/\\/g, "/"), rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
