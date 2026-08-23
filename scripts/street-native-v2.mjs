import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph, compileContourToLattice } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-street-native-v2", stamp);

const M_PER_LAT = 111320;
const origin = [40.744061, -74.006811];
const X = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };

function toLatLng([x, y]) {
  const e = x * X.e + y * Y.e;
  const n = x * X.n + y * Y.n;
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng];
}

function toLocal([lat, lng]) {
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng;
  const det = X.e * Y.n - Y.e * X.n;
  return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det];
}

function densify(points, maxStep = 55) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    out.push(a);
    const b = points[i + 1];
    if (!b) continue;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(d / maxStep));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function arc(cx, cy, rx, ry, a0, a1, n = 12) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function scalePoints(points, scale, dx = 0, dy = 0) {
  return points.map(([x, y]) => [x * scale + dx, y * scale + dy]);
}

function sneakerCandidateA() {
  const upper = [
    [0, 250], [80, 560], [250, 720], [500, 735], [760, 660], [1040, 530],
    [1320, 420], [1570, 390], [1730, 305]
  ];
  const toe = arc(1690, 220, 210, 145, Math.PI * 0.18, Math.PI * -0.62, 10);
  const bottom = [[1480, 80], [900, 45], [320, 60], [70, 105], [0, 250]];
  const laces = [[455, 650], [655, 380], [610, 675], [820, 405], [775, 650], [1000, 445], [955, 605], [1180, 470]];
  return densify([...upper, ...toe, ...bottom, [300, 600], ...laces], 45);
}

function sneakerCandidateB() {
  const sole = [[0, 190], [180, 95], [620, 50], [1180, 72], [1600, 130], [1870, 235]];
  const toe = arc(1740, 320, 190, 170, -0.4, 1.5, 12);
  const upper = [[1410, 560], [1080, 610], [800, 735], [470, 720], [210, 610], [0, 190]];
  const collar = [[470, 720], [560, 520], [820, 610], [680, 715]];
  const laces = [[610, 620], [760, 415], [760, 645], [930, 410], [910, 620], [1100, 445], [1060, 590], [1245, 480]];
  return densify([...sole, ...toe, ...upper, ...collar, ...laces], 45);
}

function witchCandidateA() {
  const brim = [[0, 700], [260, 635], [620, 620], [980, 650], [1260, 720], [930, 790], [430, 800], [0, 700]];
  const hat = [[430, 800], [620, 40], [875, 795]];
  const face = [[875, 795], [760, 1000], [560, 1080], [390, 970], [430, 800]];
  const broom = [[760, 1000], [1340, 1210], [1530, 1125], [1370, 1230], [1570, 1310], [1370, 1230]];
  return densify([...brim, ...hat, ...face, ...broom], 45);
}

function witchCandidateB() {
  const hat = [[30, 760], [480, 675], [760, 90], [910, 680], [1240, 760], [900, 825], [360, 815], [30, 760]];
  const brimBack = [[360, 815], [570, 940], [780, 900], [900, 825]];
  const nose = [[620, 920], [820, 1050], [660, 1090], [560, 1000]];
  const broom = [[820, 1050], [1300, 1320], [1500, 1270], [1320, 1330], [1510, 1410]];
  return densify([...hat, ...brimBack, ...nose, ...broom], 45);
}

const designs = [
  { id: "sneaker-a", label: "Sneaker A", subject: "sneaker", reference: "sneaker.jpg", points: sneakerCandidateA(), intent: "side-profile shoe: sole, rounded toe, upper, lace bars" },
  { id: "sneaker-b", label: "Sneaker B", subject: "sneaker", reference: "sneaker.jpg", points: sneakerCandidateB(), intent: "chunkier shoe silhouette with collar and laces" },
  { id: "witch-a", label: "Witch A", subject: "witch", reference: "witch.jpg", points: witchCandidateA(), intent: "witch hat plus face/broom cues" },
  { id: "witch-b", label: "Witch B", subject: "witch", reference: "witch.jpg", points: witchCandidateB(), intent: "hat-first witch with broom and nose" },
];

function projectFactory(points, w, h, pad = 46) {
  const b = bounds(points);
  const sx = (w - pad * 2) / Math.max(1, b.maxX - b.minX);
  const sy = (h - pad * 2) / Math.max(1, b.maxY - b.minY);
  const s = Math.min(sx, sy);
  const usedW = (b.maxX - b.minX) * s;
  const usedH = (b.maxY - b.minY) * s;
  const ox = (w - usedW) / 2;
  const oy = (h - usedH) / 2;
  return ([x, y]) => [ox + (x - b.minX) * s, oy + (b.maxY - y) * s];
}

async function renderSketch(points, file) {
  const w = 900, h = 620;
  const project = projectFactory(points, w, h);
  const d = points.map((p, i) => {
    const [x, y] = project(p);
    return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="none" stroke="#111" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function renderStreetMap(chain, graph, file) {
  const w = 1100, h = 820;
  const route = chain.map(toLocal);
  const rb = bounds(route);
  const padM = 260;
  const view = { minX: rb.minX - padM, maxX: rb.maxX + padM, minY: rb.minY - padM, maxY: rb.maxY + padM };
  const sx = (w - 70) / Math.max(1, view.maxX - view.minX);
  const sy = (h - 70) / Math.max(1, view.maxY - view.minY);
  const s = Math.min(sx, sy);
  const usedW = (view.maxX - view.minX) * s, usedH = (view.maxY - view.minY) * s;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * s, oy + (view.maxY - y) * s];
  const inView = ([x, y]) => x >= view.minX && x <= view.maxX && y >= view.minY && y <= view.maxY;
  const seen = new Set();
  const streets = [];
  for (const [from, entries] of graph.adj.entries()) {
    for (const edge of entries) {
      const key = from < edge.to ? `${from}:${edge.to}` : `${edge.to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = [graph.nodes[from], ...(edge.via ?? []), graph.nodes[edge.to]].map(toLocal);
      if (!pts.some(inView)) continue;
      const d = pts.map((p, i) => {
        const [x, y] = project(p);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(" ");
      streets.push(`<path d="${d}" fill="none" stroke="#dadada" stroke-width="2.1" stroke-linecap="round"/>`);
    }
  }
  const rd = route.map((p, i) => {
    const [x, y] = project(p);
    return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f4ef"/><rect x="24" y="24" width="${w-48}" height="${h-48}" fill="#fff"/>${streets.join("\n")}<path d="${rd}" fill="none" stroke="#771225" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/><path d="${rd}" fill="none" stroke="#ef1744" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function makeComparison(reference, routeImage, file, title, metrics) {
  const w = 1500, h = 760;
  const ref = await sharp(path.join(root, reference)).resize(700, 560, { fit: "contain", background: "#fff" }).png().toBuffer();
  const route = await sharp(routeImage).resize(700, 560, { fit: "contain", background: "#fff" }).png().toBuffer();
  const labelSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f8f5ef"/><text x="40" y="46" font-family="Arial" font-size="28" font-weight="700" fill="#111">${title}</text><text x="40" y="82" font-family="Arial" font-size="16" fill="#555">${metrics}</text><text x="40" y="692" font-family="Arial" font-size="15" fill="#555">source image</text><text x="790" y="692" font-family="Arial" font-size="15" fill="#555">NEW generated street-lattice route</text></svg>`);
  await sharp(labelSvg).composite([{ input: ref, left: 40, top: 110 }, { input: route, left: 790, top: 110 }]).png().toFile(file);
}

function gpx(name, chain) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso street-native v2" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat,lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const latticeData = JSON.parse(await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8"));
  const graph = buildLatticeGraph(latticeData);
  const summary = [];
  for (const design of designs) {
    const dir = path.join(outDir, design.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(path.join(root, design.reference), path.join(dir, `source${path.extname(design.reference)}`));
    await renderSketch(design.points, path.join(dir, "1-new-semantic-sketch.png"));
    const candidates = [0.82, 1, 1.16].map((scale, i) => ({ scale, pts: scalePoints(design.points, scale, i * 40, i * 30) }));
    let best = null;
    for (const cand of candidates) {
      const result = compileContourToLattice(cand.pts.map(toLatLng), graph, { sampleMeters: 34, pinRadiusMeters: 145, maxLegDetourRatio: 2.45, maxLegDetourSlackMeters: 180 });
      if (!result) continue;
      const score = result.meanDeviationMeters + result.skippedPins * 120 + Math.abs(result.km - 10) * 2;
      if (!best || score < best.score) best = { ...cand, result, score };
    }
    if (!best) {
      summary.push({ id: design.id, ok: false, reason: "compile failed" });
      continue;
    }
    const routeImage = path.join(dir, "2-new-route-blind.png");
    await renderStreetMap(best.result.chain, graph, routeImage);
    const metrics = `${best.result.km.toFixed(1)} km · mean deviation ${Math.round(best.result.meanDeviationMeters)} m · skipped pins ${best.result.skippedPins}`;
    await makeComparison(design.reference, routeImage, path.join(dir, "3-source-vs-new-route.png"), design.label, metrics);
    await fs.writeFile(path.join(dir, `${design.id}.gpx`), gpx(design.label, best.result.chain), "utf8");
    await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(best.result, null, 2), "utf8");
    summary.push({ id: design.id, subject: design.subject, ok: true, km: +best.result.km.toFixed(2), meanDeviationMeters: +best.result.meanDeviationMeters.toFixed(1), maxDeviationMeters: +best.result.maxDeviationMeters.toFixed(1), legCount: best.result.legCount, skippedPins: best.result.skippedPins, intent: design.intent, blindImage: path.relative(root, routeImage).replace(/\\/g, "/"), comparisonImage: path.relative(root, path.join(dir, "3-source-vs-new-route.png")).replace(/\\/g, "/") });
  }
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(path.relative(root, outDir));
}
main().catch((err) => { console.error(err); process.exit(1); });