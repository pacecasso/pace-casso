import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const outDir = path.join(root, "tmp-logo-proof", "strava-open-chevron-checkpoint");
const M = 111320;
const origin = [40.748, -73.994];
const X = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };
const TOP_N = 40;
const CHECKPOINT_EVERY = 250;
const MAX_EVALS = Number(process.env.MAX_EVALS ?? 9000);

function toLocal([lat, lng]) {
  const m = M * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M;
  const e = (lng - origin[1]) * m;
  const det = X.e * Y.n - Y.e * X.n;
  return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det];
}
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function bounds(points) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
function project(points, w, h, pad = 34) {
  const b = bounds(points);
  const s = Math.min((w - pad * 2) / Math.max(1, b.maxX - b.minX), (h - pad * 2) / Math.max(1, b.maxY - b.minY));
  const ox = (w - (b.maxX - b.minX) * s) / 2;
  const oy = (h - (b.maxY - b.minY) * s) / 2;
  return p => [ox + (p[0] - b.minX) * s, oy + (b.maxY - p[1]) * s];
}
function pathD(points, pr) {
  return points.map((p, i) => { const q = pr(p); return `${i ? "L" : "M"} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`; }).join(" ");
}
async function maskFor(points, size = 220, stroke = 14) {
  const pr = project(points, size, size, 24);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#fff"/><path d="${pathD(points, pr)}" fill="none" stroke="#000" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}
function targetPoints() {
  return [[0,0],[300,620],[600,1240],[900,620],[1200,0],[900,-120],[600,-760],[300,-120]];
}
async function scoreImage(points, target) {
  const r = await maskFor(points, 220, 14);
  let inter = 0, uni = 0, routePix = 0, targetPix = 0;
  for (let i = 0; i < r.data.length; i++) {
    const a = r.data[i] < 210;
    const b = target.data[i] < 210;
    if (a) routePix++;
    if (b) targetPix++;
    if (a && b) inter++;
    if (a || b) uni++;
  }
  const iou = uni ? inter / uni : 0;
  const coverage = targetPix ? inter / targetPix : 0;
  const extra = routePix ? Math.max(0, (routePix - inter) / routePix) : 1;
  return { visual: iou * 70 + coverage * 25 - extra * 18, iou, coverage, extra };
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
        D.set(e.to, nd);
        P.set(e.to, cur);
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
function append(chain, graph, nodes) {
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    const edge = (graph.adj.get(a) ?? []).find(x => x.to === b);
    const nodeA = graph.nodes[a];
    const last = chain[chain.length - 1];
    if (!last || last[0] !== nodeA[0] || last[1] !== nodeA[1]) chain.push(nodeA);
    if (edge) for (const v of edge.via ?? []) chain.push(v);
    chain.push(graph.nodes[b]);
  }
}
function nearest(localNodes, p) {
  let best = 0, bd = Infinity;
  for (const n of localNodes) {
    const dd = dist(n.p, p);
    if (dd < bd) { bd = dd; best = n.i; }
  }
  return best;
}
async function render(chain, file, label) {
  const loc = chain.map(toLocal);
  const w = 980, h = 760, pr = project(loc, w, h, 70);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${pathD(loc, pr)}" fill="none" stroke="#111" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toFile(file);
}
function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso slow checkpoint search" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}
function insertTop(top, cand) {
  top.push(cand);
  top.sort((a, b) => b.score - a.score);
  if (top.length > TOP_N) top.length = TOP_N;
}
async function writeCheckpoint(top, checked, accepted, done = false) {
  await fs.mkdir(outDir, { recursive: true });
  const previewDir = path.join(outDir, "previews");
  await fs.mkdir(previewDir, { recursive: true });
  const summary = [];
  let i = 0;
  for (const c of top) {
    const id = `best-${String(++i).padStart(2, "0")}`;
    const image = path.join(previewDir, `${id}.jpg`);
    await render(c.chain, image, `${id} ${c.km.toFixed(1)} km score ${c.score.toFixed(1)}`);
    await fs.writeFile(path.join(previewDir, `${id}.gpx`), gpx(id, c.chain));
    summary.push({ id, km: +c.km.toFixed(2), score: +c.score.toFixed(2), visual: +c.visual.toFixed(2), iou: +c.iou.toFixed(3), coverage: +c.coverage.toFixed(3), extra: +c.extra.toFixed(3), image: path.relative(root, image).replace(/\\/g, "/") });
  }
  const imgs = [];
  for (const item of summary.slice(0, 24)) {
    imgs.push(await sharp(path.join(root, item.image)).resize(300, 230, { fit: "contain", background: "#fff" }).jpeg({ quality: 90 }).toBuffer());
  }
  if (imgs.length) {
    const sheet = await sharp({ create: { width: 1200, height: Math.ceil(imgs.length / 4) * 230, channels: 3, background: "#f8f5ef" } })
      .composite(imgs.map((input, idx) => ({ input, left: (idx % 4) * 300, top: Math.floor(idx / 4) * 230 })))
      .jpeg({ quality: 92 })
      .toBuffer();
    await fs.writeFile(path.join(outDir, "candidate-sheet.jpg"), sheet);
  }
  await fs.writeFile(path.join(outDir, "progress.json"), JSON.stringify({ checked, accepted, done, updatedAt: new Date().toISOString(), summary }, null, 2));
  console.log(JSON.stringify({ checked, accepted, best: summary[0] ?? null, done }));
}
async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const graph = buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root, "lib/data/manhattan-lattice.json"), "utf8")));
  const localNodes = graph.nodes.map((ll, i) => ({ i, p: toLocal(ll) }));
  const bases = localNodes.filter(n => n.p[0] > -300 && n.p[0] < 4300 && n.p[1] > -3300 && n.p[1] < 5600);
  const target = await maskFor(targetPoints(), 220, 14);
  const top = [];
  let checked = 0, accepted = 0;
  outer:
  for (const base of bases) {
    for (const sx of [620, 760, 900, 1040, 1200, 1380, 1560]) {
      for (const sy of [760, 920, 1080, 1260, 1460, 1680]) {
        for (const lower of [0.42, 0.54, 0.66, 0.78]) {
          for (const overlap of [0.08, 0.14, 0.22]) {
            const x = base.p[0], y = base.p[1];
            const raw = [
              [0, 0], [sx * 0.25, sy * 0.5], [sx * 0.5, sy], [sx * 0.75, sy * 0.5], [sx, 0],
              [sx * (0.5 + overlap), -sy * 0.10], [sx * 0.5, -sy * lower], [sx * (0.5 - overlap), -sy * 0.10],
            ];
            const pts = raw.map(([a, b]) => [x + a, y + b]);
            const nodes = pts.map(p => nearest(localNodes, p)).filter((n, idx, arr) => idx === 0 || n !== arr[idx - 1]);
            if (nodes.length < 7) continue;
            const chain = [graph.nodes[nodes[0]]];
            let meters = 0, failed = false;
            for (let i = 1; i < nodes.length; i++) {
              const leg = shortest(graph, nodes[i - 1], nodes[i]);
              if (!leg) { failed = true; break; }
              append(chain, graph, leg.nodes);
              meters += leg.m;
            }
            if (failed) continue;
            const km = meters / 1000;
            if (km < 5 || km > 22) continue;
            checked++;
            const loc = chain.map(toLocal);
            const scored = await scoreImage(loc, target);
            const aspect = (() => { const b = bounds(loc); return (b.maxX - b.minX) / Math.max(1, b.maxY - b.minY); })();
            const score = scored.visual - Math.abs(km - 11) * 0.55 - Math.abs(aspect - 0.78) * 9;
            accepted++;
            insertTop(top, { chain, km, score, ...scored });
            if (accepted % CHECKPOINT_EVERY === 0) await writeCheckpoint(top, checked, accepted, false);
            if (accepted >= MAX_EVALS) break outer;
          }
        }
      }
    }
  }
  await writeCheckpoint(top, checked, accepted, true);
}
main().catch(err => { console.error(err); process.exit(1); });
