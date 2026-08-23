import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph, haversineMeters } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const inDir = path.join(root, "tmp-logo-proof", "strava-street-trace-block-multistroke");
const outDir = path.join(root, "tmp-logo-proof", "strava-connected-block-candidates");

function parse(xml) {
  const segs = [];
  const segRe = /<trkseg>([\s\S]*?)<\/trkseg>/g;
  let sm;
  while ((sm = segRe.exec(xml))) {
    const pts = [];
    const ptRe = /<trkpt lat="([^"]+)" lon="([^"]+)"/g;
    let pm;
    while ((pm = ptRe.exec(sm[1]))) pts.push([+pm[1], +pm[2]]);
    if (pts.length) segs.push(pts);
  }
  return segs;
}

function km(ps) {
  let t = 0;
  for (let i = 1; i < ps.length; i++) t += haversineMeters(ps[i - 1], ps[i]);
  return t / 1000;
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

function shortest(graph, from, to) {
  if (from === to) return { path: [from], m: 0 };
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const done = new Set();
  const open = [[haversineMeters(graph.nodes[from], graph.nodes[to]), from]];
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === to) break;
    if (done.has(cur)) continue;
    done.add(cur);
    const cd = dist.get(cur) ?? Infinity;
    for (const e of graph.adj.get(cur) ?? []) {
      const nd = cd + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, cur);
        open.push([nd + haversineMeters(graph.nodes[e.to], graph.nodes[to]), e.to]);
      }
    }
  }
  if (!prev.has(to)) return null;
  const p = [];
  let cur = to;
  while (cur !== undefined) {
    p.push(cur);
    cur = prev.get(cur);
  }
  p.reverse();
  return { path: p, m: dist.get(to) ?? 0 };
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

function rotateClosed(seg, index) {
  const closed = haversineMeters(seg[0], seg[seg.length - 1]) < 30;
  const core = closed ? seg.slice(0, -1) : seg.slice();
  return [...core.slice(index), ...core.slice(0, index + 1)];
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
  const W = 1100;
  const H = 850;
  const pr = project(all, W, H);
  const paths = parts
    .map(
      (seg, i) =>
        `<path d="${d(seg, pr)}" fill="none" stroke="${i === 1 ? "#666" : i === 2 ? "#ff9b70" : "#fc4c02"}" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"/><path d="${d(seg, pr)}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".65"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>${paths}<text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toFile(file);
}

function gpx(name, ps) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso Strava connected block candidate" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>
${ps.map(([la, ln]) => `<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}
</trkseg></trk></gpx>
`;
}

async function connectOne(graph, id) {
  const [topRaw, lowRaw] = parse(await fs.readFile(path.join(inDir, `${id}.gpx`), "utf8"));
  let best = null;
  for (let i = 0; i < topRaw.length; i += 3) {
    for (let j = 0; j < lowRaw.length; j += 3) {
      const route = shortest(graph, nearestNode(graph, topRaw[i]), nearestNode(graph, lowRaw[j]));
      if (!route) continue;
      const d = haversineMeters(topRaw[i], lowRaw[j]) + route.m;
      if (!best || d < best.d) best = { i, j, route, d };
    }
  }
  if (!best) return null;
  const top = rotateClosed(topRaw, best.i);
  const lower = rotateClosed(lowRaw, best.j);
  const connector = [];
  appendNodePath(connector, graph, best.route.path);
  const chain = [...top, ...connector, ...lower];
  const image = path.join(outDir, `${id}-single-run.jpg`);
  await render([top, connector, lower], image, `${id} single ${km(chain).toFixed(1)} km conn ${(best.route.m / 1000).toFixed(2)} km`);
  await fs.writeFile(path.join(outDir, `${id}-single-run.gpx`), gpx(`${id} single run`, chain));
  return {
    id,
    km: +km(chain).toFixed(2),
    connectorKm: +(best.route.m / 1000).toFixed(2),
    image: path.relative(root, image).replace(/\\/g, "/"),
    gpx: path.relative(root, path.join(outDir, `${id}-single-run.gpx`)).replace(/\\/g, "/"),
  };
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const graph = buildLatticeGraph(JSON.parse(await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8")));
  const ids = process.argv.slice(2);
  const rows = [];
  for (const id of ids.length ? ids : ["block-11", "block-10", "block-09", "block-08", "block-07"]) {
    const row = await connectOne(graph, id);
    if (row) rows.push(row);
  }
  const comps = [];
  for (const row of rows) {
    const input = await sharp(path.join(root, row.image)).resize(550, 425, { fit: "contain", background: "#fff" }).jpeg().toBuffer();
    comps.push({ input, left: (comps.length % 2) * 550, top: Math.floor(comps.length / 2) * 425 });
  }
  await sharp({ create: { width: 1100, height: Math.max(425, Math.ceil(comps.length / 2) * 425), channels: 3, background: "#fff" } })
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
