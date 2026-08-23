import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const outDir = path.join(root, "tmp-logo-proof", "strava-motif-search");
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
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function angle(a, b) { return Math.atan2(b[1] - a[1], b[0] - a[0]); }
function angleDiff(a, b) { let d = Math.abs(a - b); while (d > Math.PI) d = Math.abs(d - Math.PI * 2); return d; }
function project(points, w, h, pad = 70) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const b = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const s = Math.min((w - pad * 2) / Math.max(1, b.maxX - b.minX), (h - pad * 2) / Math.max(1, b.maxY - b.minY));
  const ox = (w - (b.maxX - b.minX) * s) / 2;
  const oy = (h - (b.maxY - b.minY) * s) / 2;
  return p => [ox + (p[0] - b.minX) * s, oy + (b.maxY - p[1]) * s];
}
function pathD(points, pr) { return points.map((p, i) => { const [x, y] = pr(p); return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" "); }
function edgeKey(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function appendEdgePath(chain, graph, a, b) {
  const e = (graph.adj.get(a) ?? []).find(x => x.to === b);
  if (!e) return;
  const nodeA = graph.nodes[a];
  const last = chain[chain.length - 1];
  if (!last || last[0] !== nodeA[0] || last[1] !== nodeA[1]) chain.push(nodeA);
  for (const v of e.via ?? []) chain.push(v);
  chain.push(graph.nodes[b]);
}
function shortest(graph, from, to) {
  if (from === to) return { nodes: [from], m: 0 };
  const D = new Map([[from, 0]]), P = new Map(), done = new Set(), open = [[0, from]];
  const target = toLocal(graph.nodes[to]);
  while (open.length) {
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
        D.set(e.to, nd); P.set(e.to, cur);
        open.push([nd + dist(toLocal(graph.nodes[e.to]), target), e.to]);
      }
    }
  }
  if (!P.has(to)) return null;
  const nodes = [];
  let c = to;
  while (c !== undefined) { nodes.push(c); c = P.get(c); }
  nodes.reverse();
  return { nodes, m: D.get(to) ?? 0 };
}
function appendNodePath(chain, graph, nodes) {
  for (let i = 1; i < nodes.length; i++) appendEdgePath(chain, graph, nodes[i - 1], nodes[i]);
}
function pathLength(chain) {
  let m = 0;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i];
    const la = toLocal(a), lb = toLocal(b);
    m += dist(la, lb);
  }
  return m / 1000;
}
function buildMotifs(graph) {
  const motifs = [];
  const local = graph.nodes.map(toLocal);
  for (let apex = 0; apex < graph.nodes.length; apex++) {
    const entries = graph.adj.get(apex) ?? [];
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i].to, b = entries[j].to;
      const pa = local[a], pp = local[apex], pb = local[b];
      const la = dist(pa, pp), lb = dist(pb, pp);
      if (la < 70 || lb < 70 || la > 360 || lb > 360) continue;
      const ratio = Math.min(la, lb) / Math.max(la, lb);
      if (ratio < 0.45) continue;
      const open = angleDiff(angle(pp, pa), angle(pp, pb));
      if (open < 0.65 || open > 2.45) continue;
      const baseMid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      const heightVec = [pp[0] - baseMid[0], pp[1] - baseMid[1]];
      const height = Math.hypot(heightVec[0], heightVec[1]);
      if (height < 85) continue;
      const up = heightVec[1] > 0;
      const width = dist(pa, pb);
      const score = Math.abs(ratio - 1) * 1.5 + Math.abs(width / height - 1.25) * 0.55;
      motifs.push({ apex, a, b, pa, pp, pb, up, width, height, center: baseMid, score });
    }
  }
  motifs.sort((a, b) => a.score - b.score);
  return motifs;
}
function compose(graph, upper, lower) {
  const chain = [];
  appendEdgePath(chain, graph, upper.a, upper.apex);
  appendEdgePath(chain, graph, upper.apex, upper.b);
  const conn = shortest(graph, upper.b, lower.a);
  if (!conn) return null;
  appendNodePath(chain, graph, conn.nodes);
  appendEdgePath(chain, graph, lower.a, lower.apex);
  appendEdgePath(chain, graph, lower.apex, lower.b);
  return chain;
}
async function render(chain, file, label) {
  const loc = chain.map(toLocal);
  const w = 980, h = 760, pr = project(loc, w, h);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${pathD(loc, pr)}" fill="none" stroke="#111" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toFile(file);
}
function gpx(name, chain) { return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso motif search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`; }
async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const graph = buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root, "lib/data/manhattan-lattice.json"), "utf8")));
  const motifs = buildMotifs(graph);
  const ups = motifs.filter(m => m.up).slice(0, 900);
  const downs = motifs.filter(m => !m.up).slice(0, 900);
  const candidates = [];
  for (const u of ups) for (const l of downs) {
    const dx = Math.abs(u.center[0] - l.center[0]);
    const dy = u.center[1] - l.center[1];
    if (dx > Math.max(260, u.width * 0.85)) continue;
    if (dy < 120 || dy > 900) continue;
    if (l.width > u.width * 1.25 || l.width < u.width * 0.35) continue;
    const chain = compose(graph, u, l);
    if (!chain) continue;
    const km = pathLength(chain);
    if (km < 1.2 || km > 10) continue;
    const connectorPenalty = Math.max(0, km - (u.width + u.height + l.width + l.height) / 650);
    const score = u.score + l.score + dx / 320 + Math.abs(dy / u.height - 0.82) + connectorPenalty * 0.25;
    candidates.push({ u, l, chain, km, score });
  }
  candidates.sort((a, b) => a.score - b.score);
  const summary = [];
  let n = 0;
  for (const c of candidates.slice(0, 40)) {
    const id = `motif-${String(++n).padStart(2, "0")}`;
    const file = path.join(outDir, `${id}.jpg`);
    await render(c.chain, file, `${id} ${c.km.toFixed(1)} km`);
    await fs.writeFile(path.join(outDir, `${id}.gpx`), gpx(id, c.chain));
    summary.push({ id, km: +c.km.toFixed(2), score: +c.score.toFixed(2), image: path.relative(root, file).replace(/\\/g, "/") });
  }
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ motifs: motifs.length, candidates: candidates.length, kept: summary.length, outDir: path.relative(root, outDir) }, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
