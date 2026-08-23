import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { buildLatticeGraph, compileContourToLattice } = jiti("../lib/latticeCompiler.ts");

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-street-native-proof", `sneaker-atlas-${stamp}`);
const origin = [40.744061, -74.006811];
const X = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };
const M_PER_LAT = 111320;
function toLatLng([x, y]) { const e = x * X.e + y * Y.e; const n = x * X.n + y * Y.n; const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180); return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng]; }
function toLocal([lat, lng]) { const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180); const n = (lat - origin[0]) * M_PER_LAT; const e = (lng - origin[1]) * mPerLng; const det = X.e * Y.n - Y.e * X.n; return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det]; }
function densify(points, maxStep = 75) { const out = []; for (let i = 0; i < points.length; i++) { const a = points[i]; out.push(a); const b = points[i + 1]; if (!b) continue; const d = Math.hypot(b[0] - a[0], b[1] - a[1]); const steps = Math.max(1, Math.ceil(d / maxStep)); for (let s = 1; s < steps; s++) { const t = s / steps; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } } return out; }
function bounds(points) { const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]); return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }; }
function svgPath(points, b, w, h, pad = 36) { const sx = (w - pad * 2) / Math.max(1, b.maxX - b.minX); const sy = (h - pad * 2) / Math.max(1, b.maxY - b.minY); const s = Math.min(sx, sy); const usedW = (b.maxX - b.minX) * s; const usedH = (b.maxY - b.minY) * s; const ox = (w - usedW) / 2; const oy = (h - usedH) / 2; return points.map(([x, y], i) => { const px = ox + (x - b.minX) * s; const py = oy + (b.maxY - y) * s; return `${i === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`; }).join(" "); }
async function renderLine(points, file, title, subtitle) { const w = 820, h = 520; const b = bounds(points); const d = svgPath(points, b, w, h - 76); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/><rect width="${w}" height="${h - 76}" fill="#fafafa"/><path d="${d}" fill="none" stroke="#e11d48" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><text x="22" y="${h - 42}" font-family="Arial" font-size="21" font-weight="700" fill="#111">${title}</text><text x="22" y="${h - 17}" font-family="Arial" font-size="14" fill="#555">${subtitle}</text></svg>`; await sharp(Buffer.from(svg)).png().toFile(file); }
function routeScore(r) { return r.meanDeviationMeters + r.skippedPins * 180 + Math.max(0, r.maxDeviationMeters - 140) * 0.8 + Math.abs(r.km - 13) * 4; }
function gpx(name, chain) { return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso street-native sneaker atlas" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`; }

const variants = [
  {
    id: "low-runner-a",
    label: "low runner A",
    pts: [
      [0,240],[110,170],[360,135],[790,120],[1210,150],[1580,230],[1830,350],[1880,470],[1760,560],[1510,600],[1260,705],[990,820],[700,875],[350,845],[130,690],[0,520],[0,240],
      [140,300],[690,315],[1200,330],[1660,355],[1200,330],[1040,520],[790,345],[620,630],[920,375],[750,675],[1100,410],[930,690],[1280,455],
      [700,875],[790,700],[1020,700],[1150,610]
    ],
  },
  {
    id: "low-runner-b",
    label: "low runner B",
    pts: [
      [0,250],[120,160],[420,135],[860,135],[1280,175],[1640,270],[1900,420],[1850,545],[1660,625],[1360,660],[1120,790],[830,875],[450,860],[170,735],[0,540],[0,250],
      [120,315],[540,300],[990,300],[1510,335],[1750,420],[1510,335],[1280,505],[1000,340],[760,620],[1040,355],[830,665],[1160,400],[960,700],
      [460,860],[585,665],[845,665],[1040,590],[1240,660]
    ],
  },
  {
    id: "classic-high-top",
    label: "classic high top",
    pts: [
      [0,230],[90,150],[320,130],[760,120],[1170,150],[1510,230],[1790,350],[1900,500],[1800,625],[1510,665],[1260,735],[1030,875],[720,980],[420,960],[210,830],[90,650],[0,520],[0,230],
      [420,960],[470,760],[580,595],[720,420],[890,760],[1100,455],[1000,735],[1260,500],[1160,710],[1440,560],
      [650,945],[740,800],[1010,800],[1190,710],[1370,690]
    ],
  },
  {
    id: "fast-swoop-sole",
    label: "fast swoop sole",
    pts: [
      [0,240],[120,155],[410,125],[810,120],[1220,155],[1600,255],[1880,420],[1870,540],[1720,625],[1390,640],[1140,760],[890,835],[540,825],[235,720],[0,560],[0,240],
      [0,240],[250,250],[720,260],[1230,285],[1670,330],[1850,420],
      [630,610],[850,330],[780,650],[1050,350],[980,670],[1260,395],[1195,645],
      [540,825],[650,690],[930,690],[1130,620]
    ],
  },
];

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const latticeData = JSON.parse(await fs.readFile(path.join(root, "lib", "data", "manhattan-lattice.json"), "utf8"));
  const graph = buildLatticeGraph(latticeData);
  const summary = [];
  for (const v of variants) {
    const dir = path.join(outDir, v.id); await fs.mkdir(dir, { recursive: true });
    const sketch = densify(v.pts);
    await renderLine(sketch, path.join(dir, "1-sketch.png"), v.label, "street-native sneaker target");
    let best = null;
    for (const pinRadiusMeters of [110,130,150,175]) {
      for (const sampleMeters of [24,30,36,44]) {
        const result = compileContourToLattice(sketch.map(toLatLng), graph, { sampleMeters, pinRadiusMeters, minPinSpacingMeters: 42, maxLegDetourRatio: 2.45, maxLegDetourSlackMeters: 230 });
        if (!result) continue;
        const score = routeScore(result);
        if (!best || score < best.score) best = { result, score, sampleMeters, pinRadiusMeters };
      }
    }
    if (!best) { summary.push({ id: v.id, ok: false }); continue; }
    const local = best.result.chain.map(toLocal);
    await renderLine(local, path.join(dir, "2-route.png"), v.label, `${best.result.km.toFixed(1)} km · dev ${Math.round(best.result.meanDeviationMeters)} m · pin ${best.pinRadiusMeters}/${best.sampleMeters}`);
    await fs.writeFile(path.join(dir, `${v.id}.gpx`), gpx(v.label, best.result.chain));
    await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(best, null, 2));
    summary.push({ id: v.id, label: v.label, ok: true, km: +best.result.km.toFixed(2), meanDeviationMeters: +best.result.meanDeviationMeters.toFixed(1), maxDeviationMeters: +best.result.maxDeviationMeters.toFixed(1), skippedPins: best.result.skippedPins, score: +best.score.toFixed(1), preview: path.relative(root, path.join(dir, "2-route.png")).replace(/\\/g, "/") });
  }
  summary.sort((a,b)=>(a.score??9999)-(b.score??9999));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(path.relative(root, outDir));
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((err) => { console.error(err); process.exit(1); });
