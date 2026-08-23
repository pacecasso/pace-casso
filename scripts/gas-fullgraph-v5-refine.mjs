import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildGraph, nearestNode, meters, corridorPath, traceOpts } = jiti("./trace-contour.ts");

const root = process.cwd();
const outDir = path.join(root, "tmp-logo-proof", "gas-fullgraph-v5-refine");
const ORIGIN = [40.744061, -74.006811];
const M_PER_LAT = 111320;
const STREET_BEARING = 119;
const AVENUE_BEARING = 29;

function unit(deg) {
  const r = (deg * Math.PI) / 180;
  return { e: Math.sin(r), n: Math.cos(r) };
}
const X_AXIS = unit(STREET_BEARING);
const Y_AXIS = unit(AVENUE_BEARING);
const mPerLng = (lat) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);

function toLatLng([x, y], origin = ORIGIN) {
  const e = x * X_AXIS.e + y * Y_AXIS.e;
  const n = x * X_AXIS.n + y * Y_AXIS.n;
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng(origin[0])];
}

function toLocal([lat, lng], origin = ORIGIN) {
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng(origin[0]);
  const det = X_AXIS.e * Y_AXIS.n - Y_AXIS.e * X_AXIS.n;
  return [(e * Y_AXIS.n - Y_AXIS.e * n) / det, (X_AXIS.e * n - e * X_AXIS.n) / det];
}

const row = (street) => (street - 17) * 80;
const AVE_10 = 0, AVE_9 = 272, AVE_8 = 548, AVE_7 = 821, AVE_6 = 1097;
const AVE_5 = 1406, MAD = 1560, PARK = 1707, LEX = 1870, AVE_3 = 2026;
const AVE_2 = 2242, AVE_1 = 2471;

function arc(cx, cy, rx, ry, startDeg, endDeg, steps = 24) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((startDeg + ((endDeg - startDeg) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

function bezier(p0, p1, p2, steps = 20) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}

function buildSketch() {
  const pts = [];
  const add = (...p) => pts.push(...p);
  const addArc = (...a) => pts.push(...arc(...a));
  const addBez = (...b) => pts.push(...bezier(...b));

  add([AVE_6, row(33)]);
  add([AVE_6, row(14)]);
  add([AVE_10, row(14)]);
  add([AVE_10, row(42)]);
  add([AVE_9, row(44)]);
  add([AVE_7, row(44)]);
  add([AVE_6, row(42)]);
  add([AVE_6, row(39)]);
  add([AVE_7, row(39)]);
  add([AVE_9, row(39)]);
  add([AVE_9, row(35)]);
  add([AVE_7, row(35)]);
  add([AVE_7, row(39)]);
  add([AVE_6, row(39)]);
  add([AVE_6, row(33)]);
  addBez([AVE_6, row(33)], [1250, 1300], [1354, 1295], 10);
  addArc(AVE_5, 1000, 300, 300, 100, -260, 40);
  addBez([1458, 1295], [1650, 1380], [LEX, row(33)], 16);
  add([LEX, row(35)]);
  add([PARK, row(35)]);
  add([PARK, row(38)]);
  add([LEX, row(38)]);
  add([LEX, row(35)]);
  add([LEX, row(38)]);
  addArc(2170, row(35.5), 301, 320, 180, 0, 26);
  addArc(2170, row(35.5), 301, 280, 0, -180, 26);
  add([LEX, row(30)]);
  add([LEX, row(23)]);
  add([PARK, row(23)]);
  add([PARK, row(14)]);
  add([AVE_3, row(14)]);
  add([AVE_3, row(23)]);
  add([AVE_2, row(23)]);
  add([AVE_2, row(14)]);
  add([AVE_1, row(14)]);
  add([AVE_1, row(30)]);
  add([LEX, row(30)]);
  return pts;
}

function splitSketch() {
  const pump = [
    [AVE_6, row(33)], [AVE_6, row(14)], [AVE_10, row(14)], [AVE_10, row(42)],
    [AVE_9, row(44)], [AVE_7, row(44)], [AVE_6, row(42)], [AVE_6, row(39)],
    [AVE_7, row(39)], [AVE_9, row(39)], [AVE_9, row(35)], [AVE_7, row(35)],
    [AVE_7, row(39)], [AVE_6, row(39)], [AVE_6, row(33)],
  ];
  const hose = [
    [AVE_6, row(33)],
    ...bezier([AVE_6, row(33)], [1250, 1300], [1354, 1295], 10).slice(1),
    ...arc(AVE_5, 1000, 300, 300, 100, -260, 48).slice(1),
    ...bezier([1458, 1295], [1650, 1380], [LEX, row(33)], 16).slice(1),
    [LEX, row(35)],
  ];
  const cup = [[LEX, row(35)], [PARK, row(35)], [PARK, row(38)], [LEX, row(38)], [LEX, row(35)]];
  const head = [
    [LEX, row(38)],
    ...arc(2170, row(35.5), 301, 320, 180, 0, 30).slice(1),
    ...arc(2170, row(35.5), 301, 280, 0, -180, 30).slice(1),
    [LEX, row(30)],
  ];
  const body = [
    [LEX, row(30)], [LEX, row(23)], [PARK, row(23)], [PARK, row(14)],
    [AVE_3, row(14)], [AVE_3, row(23)], [AVE_2, row(23)], [AVE_2, row(14)],
    [AVE_1, row(14)], [AVE_1, row(30)], [LEX, row(30)],
  ];
  return { pump, hose, cup, head, body };
}
function chainKm(ps) {
  let t = 0;
  for (let i = 1; i < ps.length; i++) t += meters(ps[i - 1], ps[i]);
  return t / 1000;
}

function maxJump(ps) {
  let m = 0;
  for (let i = 1; i < ps.length; i++) m = Math.max(m, meters(ps[i - 1], ps[i]));
  return m;
}

function bounds(ps) {
  const lats = ps.map((p) => p[0]);
  const lngs = ps.map((p) => p[1]);
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
}

function project(ps, w, h, pad = 55) {
  const b = bounds(ps);
  const mid = (b.minLat + b.maxLat) / 2;
  const spanX = Math.max(1, (b.maxLng - b.minLng) * mPerLng(mid));
  const spanY = Math.max(1, (b.maxLat - b.minLat) * M_PER_LAT);
  const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * s) / 2;
  const oy = (h - spanY * s) / 2;
  return (p) => [ox + (p[1] - b.minLng) * mPerLng(mid) * s, oy + (b.maxLat - p[0]) * M_PER_LAT * s];
}

function svgPath(ps, pr) {
  return ps.map((p, i) => {
    const q = pr(p);
    return `${i ? "L" : "M"} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
  }).join(" ");
}

function nearestDistanceToPolyline(p, line) {
  let best = Infinity;
  const px0 = p[1] * mPerLng(p[0]), py0 = p[0] * M_PER_LAT;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const ax = a[1] * mPerLng(p[0]), ay = a[0] * M_PER_LAT;
    const bx = b[1] * mPerLng(p[0]), by = b[0] * M_PER_LAT;
    const vx = bx - ax, vy = by - ay;
    const t = Math.max(0, Math.min(1, ((px0 - ax) * vx + (py0 - ay) * vy) / (vx * vx + vy * vy || 1)));
    best = Math.min(best, Math.hypot(px0 - (ax + vx * t), py0 - (ay + vy * t)));
  }
  return best;
}

function scoreChain(parts, targets) {
  const all = parts.flat();
  const targetAll = Object.values(targets).flat();
  const km = chainKm(all);
  let dev = 0, n = 0;
  for (const p of all) {
    dev += nearestDistanceToPolyline(p, targetAll);
    n++;
  }
  const meanDev = dev / Math.max(1, n);
  let tiny = 0;
  for (const seg of parts) {
    for (let i = 2; i < seg.length; i++) {
      const a = seg[i - 2], b = seg[i - 1], c = seg[i];
      const ab = meters(a, b), bc = meters(b, c);
      if (Math.min(ab, bc) > 90) continue;
      const ux = (b[1] - a[1]) * mPerLng(b[0]), uy = (b[0] - a[0]) * M_PER_LAT;
      const vx = (c[1] - b[1]) * mPerLng(b[0]), vy = (c[0] - b[0]) * M_PER_LAT;
      const dot = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1)));
      if (Math.acos(dot) * 180 / Math.PI > 45) tiny++;
    }
  }
  return 100 - meanDev * 0.38 - tiny * 1.9 - Math.max(0, km - 35) * 4 - Math.max(0, 18 - km) * 1.5;
}

function shortest(g, from, to) {
  if (from === to) return { path: [from], m: 0 };
  const D = new Map([[from, 0]]);
  const P = new Map();
  const done = new Set();
  const open = [[0, from]];
  const target = g.coord.get(to);
  while (open.length && done.size < 160000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === to) break;
    if (done.has(cur)) continue;
    done.add(cur);
    const cd = D.get(cur) ?? Infinity;
    for (const e of g.adj.get(cur) ?? []) {
      const nd = cd + e.w;
      if (nd < (D.get(e.to) ?? Infinity)) {
        D.set(e.to, nd);
        P.set(e.to, cur);
        open.push([nd + meters(g.coord.get(e.to), target), e.to]);
      }
    }
  }
  if (!P.has(to)) return null;
  const p = [];
  let c = to;
  while (c !== undefined) {
    p.push(c);
    c = P.get(c);
  }
  p.reverse();
  return { path: p, m: D.get(to) ?? 0 };
}

function append(out, g, nodePath) {
  for (const id of nodePath) {
    const p = g.coord.get(id);
    const last = out[out.length - 1];
    if (!last || meters(last, p) > 1) out.push(p);
  }
}

function connectSegments(g, segs) {
  const out = [];
  const connectors = [];
  for (let i = 0; i < segs.length; i++) {
    if (i) {
      const a = nearestNode(g, out[out.length - 1]);
      const b = nearestNode(g, segs[i][0]);
      const r = shortest(g, a, b);
      if (r) {
        const before = out.length;
        append(out, g, r.path);
        connectors.push(out.slice(before));
      }
    }
    for (const p of segs[i]) {
      const last = out[out.length - 1];
      if (!last || meters(last, p) > 1) out.push(p);
    }
  }
  return { chain: out, connectors };
}

function resamplePolyline(line, stepM) {
  const out = [line[0]];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const d = meters(a, b);
    const n = Math.max(1, Math.floor((d + carry) / stepM));
    for (let k = 1; k <= n; k++) {
      const t = Math.min(1, (k * stepM - carry) / Math.max(1, d));
      if (t > 0 && t < 1) out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(b);
    carry = (d + carry) % stepM;
  }
  return out;
}

function tracePolyline(g, line, opts) {
  const dense = resamplePolyline(line, 25);
  const anchors = resamplePolyline(line, opts.anchorM);
  const out = [];
  for (let i = 1; i < anchors.length; i++) {
    const na = nearestNode(g, anchors[i - 1]);
    const nb = nearestNode(g, anchors[i]);
    if (na < 0 || nb < 0) continue;
    if (na === nb) {
      const p = g.coord.get(na);
      const last = out[out.length - 1];
      if (!last || meters(last, p) > 1) out.push(p);
      continue;
    }
    const direct = meters(anchors[i - 1], anchors[i]);
    let p = corridorPath(g, na, nb, dense, opts.lambda, opts.corridorM);
    if (!p) p = corridorPath(g, na, nb, dense, opts.lambda, opts.corridorM * 2.4);
    if (!p) p = corridorPath(g, na, nb, dense, 0, 1e7);
    if (!p) continue;
    let plen = 0;
    for (let k = 1; k < p.length; k++) plen += meters(g.coord.get(p[k - 1]), g.coord.get(p[k]));
    if (plen > direct * 2.7 + 380 || plen > 1800) continue;
    append(out, g, p);
  }
  return out;
}
async function render(parts, targets, file, label) {
  const all = [...parts.flat(), ...Object.values(targets).flat()];
  const W = 1400, H = 980;
  const pr = project(all, W, H);
  const targetPaths = Object.values(targets).map((seg) => `<path d="${svgPath(seg, pr)}" fill="none" stroke="#f3a7b5" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
  const routePaths = parts.map((seg, i) => `<path d="${svgPath(seg, pr)}" fill="none" stroke="${i % 2 ? "#a20d25" : "#e5253f"}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="${svgPath(seg, pr)}" fill="none" stroke="#111" stroke-width="2.8" opacity=".55" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>${targetPaths}${routePaths}<text x="24" y="38" font-family="Arial" font-size="22" font-weight="700">${label}</text></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toFile(file);
}

function gpx(name, ps) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso gas full graph" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${ps.map(([la, ln]) => `<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

async function main() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  traceOpts.trim = false;
  const g = await buildGraph();
  const piecesLocal = splitSketch();
  const variants = [];
  for (const anchorM of [420]) {
    for (const lambda of [4]) {
      for (const corridorM of [180]) {
        const targets = {};
        const parts = [];
        let ok = true;
        for (const [name, local] of Object.entries(piecesLocal)) {
          const target = local.map((p) => toLatLng(p));
          targets[name] = target;
          const chain = tracePolyline(g, target, { anchorM, lambda, corridorM });
          if (chain.length < 8 || maxJump(chain) > 900) console.log("weak piece", name, chain.length, maxJump(chain).toFixed(0));
          parts.push(chain);
        }
        
        const connected = connectSegments(g, parts);
        const score = scoreChain(parts, targets);
        variants.push({ anchorM, lambda, corridorM, score, km: chainKm(connected.chain), parts, targets, chain: connected.chain });
      }
    }
  }
  variants.sort((a, b) => b.score - a.score);
  const keep = variants.slice(0, 12);
  const comps = [];
  let idx = 0;
  for (const v of keep) {
    const id = `gas-full-${String(++idx).padStart(3, "0")}`;
    const img = path.join(outDir, `${id}.jpg`);
    await render(v.parts, v.targets, img, `${id} ${v.km.toFixed(1)} km a${v.anchorM} l${v.lambda} c${v.corridorM} s${v.score.toFixed(1)}`);
    await fs.writeFile(path.join(outDir, `${id}.gpx`), gpx(id, v.chain));
    comps.push({ input: await sharp(img).resize(700, 490, { fit: "contain", background: "#fff" }).jpeg().toBuffer(), left: (idx - 1) % 2 * 700, top: Math.floor((idx - 1) / 2) * 490 });
  }
  await sharp({ create: { width: 1400, height: Math.max(490, Math.ceil(comps.length / 2) * 490), channels: 3, background: "#fff" } })
    .composite(comps)
    .jpeg({ quality: 92 })
    .toFile(path.join(outDir, "candidate-sheet.jpg"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(keep.map(({ parts, targets, chain, ...rest }, i) => ({ rank: i + 1, ...rest })), null, 2));
  console.log(JSON.stringify({ count: variants.length, best: keep[0] && { score: keep[0].score, km: keep[0].km, anchorM: keep[0].anchorM, lambda: keep[0].lambda, corridorM: keep[0].corridorM }, sheet: path.relative(root, path.join(outDir, "candidate-sheet.jpg")) }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});




