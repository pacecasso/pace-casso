import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const jiti = require("jiti")(import.meta.url);
const { streetLockupCandidates } = jiti("../lib/mapNativeDesigner.ts");
const { MANHATTAN_PRESET } = jiti("../lib/cityPresets.ts");

const root = process.cwd();
const outRoot = path.join(root, "tmp-logo-proof", "fresh-lockup-runs");

function swooshSymbol() {
  return [
    { x: 0.04, y: 0.62 }, { x: 0.08, y: 0.73 }, { x: 0.17, y: 0.80 },
    { x: 0.31, y: 0.79 }, { x: 0.50, y: 0.68 }, { x: 0.74, y: 0.50 },
    { x: 0.98, y: 0.28 }, { x: 0.72, y: 0.36 }, { x: 0.48, y: 0.42 },
    { x: 0.27, y: 0.50 }, { x: 0.17, y: 0.48 }, { x: 0.13, y: 0.39 },
    { x: 0.18, y: 0.22 }, { x: 0.09, y: 0.35 }, { x: 0.05, y: 0.49 },
    { x: 0.04, y: 0.62 },
  ];
}

function arc(cx, cy, rx, ry, start, end, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = ((start + (end - start) * i / n) * Math.PI) / 180;
    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
  }
  return pts;
}

function chanelSymbol() {
  // One continuous double-C stroke, with an outside connector between loops.
  return [
    ...arc(0.42, 0.48, 0.30, 0.24, 50, 310, 22),
    { x: 0.50, y: 0.75 }, { x: 0.58, y: 0.72 },
    ...arc(0.58, 0.48, 0.30, 0.24, 230, -50, 22),
  ];
}

function meters(a, b) {
  const latM = 111320;
  const lngM = latM * Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * latM, (b[1] - a[1]) * lngM);
}
function routeKm(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += meters(pts[i - 1], pts[i]);
  return total / 1000;
}
function bounds(pts) {
  const lats = pts.map((p) => p[0]);
  const lngs = pts.map((p) => p[1]);
  return { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLng: Math.min(...lngs), maxLng: Math.max(...lngs) };
}
function project(pts, w, h, pad = 55) {
  const b = bounds(pts);
  const mid = (b.minLat + b.maxLat) / 2;
  const mx = 111320 * Math.cos((mid * Math.PI) / 180);
  const spanX = Math.max(1, (b.maxLng - b.minLng) * mx);
  const spanY = Math.max(1, (b.maxLat - b.minLat) * 111320);
  const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = (w - spanX * s) / 2;
  const oy = (h - spanY * s) / 2;
  return (p) => [ox + (p[1] - b.minLng) * mx * s, oy + (b.maxLat - p[0]) * 111320 * s];
}
function d(pts, pr) {
  return pts.map((p, i) => {
    const q = pr(p);
    return `${i ? "L" : "M"} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
  }).join(" ");
}
function gpx(name, pts) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso fresh lockup proof" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${pts.map(([lat,lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}
async function renderCandidate(c, file, title) {
  const w = 1040, h = 760;
  const pr = project(c.anchors, w, h, 70);
  const route = d(c.anchors, pr);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${route}" fill="none" stroke="#111" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><text x="24" y="38" font-family="Arial" font-size="20" font-weight="700">${title}</text></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 94 }).toFile(file);
}
async function runOne(id, symbol, word, targetKm) {
  const outDir = path.join(outRoot, id);
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  const candidates = streetLockupCandidates(symbol, word, MANHATTAN_PRESET, targetKm)
    .sort((a, b) => Math.abs(a.km - targetKm) - Math.abs(b.km - targetKm));
  const rows = [];
  let i = 0;
  for (const c of candidates.slice(0, 12)) {
    const name = `${id}-${String(++i).padStart(2, "0")}`;
    const jpg = path.join(outDir, `${name}.jpg`);
    await renderCandidate(c, jpg, `${name} ${routeKm(c.anchors).toFixed(1)} km - ${word}`);
    await fs.writeFile(path.join(outDir, `${name}.gpx`), gpx(name, c.anchors), "utf8");
    rows.push({ name, km: Number(routeKm(c.anchors).toFixed(2)), jpg: path.relative(root, jpg).replace(/\\/g, "/") });
  }
  const comps = [];
  for (const row of rows.slice(0, 8)) {
    const input = await sharp(path.join(root, row.jpg)).resize(520, 380, { fit: "contain", background: "#fff" }).jpeg().toBuffer();
    comps.push({ input, left: (comps.length % 2) * 520, top: Math.floor(comps.length / 2) * 380 });
  }
  if (comps.length) {
    await sharp({ create: { width: 1040, height: Math.ceil(comps.length / 2) * 380, channels: 3, background: "#fff" } })
      .composite(comps)
      .jpeg({ quality: 92 })
      .toFile(path.join(outDir, "candidate-sheet.jpg"));
  }
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(rows, null, 2));
  return { id, count: rows.length, sheet: path.relative(root, path.join(outDir, "candidate-sheet.jpg")).replace(/\\/g, "/"), rows };
}

await fs.mkdir(outRoot, { recursive: true });
const results = [];
results.push(await runOne("nike", swooshSymbol(), "JUST DO IT", 50));
results.push(await runOne("chanel", chanelSymbol(), "CHANEL", 38));
await fs.writeFile(path.join(outRoot, "summary.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));