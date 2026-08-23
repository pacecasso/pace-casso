import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = process.cwd();
const inputRel = process.argv[2] ?? "tmp-sneaker-screenshot-strokes/2026-07-19T12-58-23-827Z/strokes-01/art-strokes.gpx";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "tmp-mapbox-match-proof", stamp);
const M = 111320;

function parseEnv(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

async function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try { parseEnv(await fs.readFile(path.join(root, file), "utf8")); } catch {}
  }
}

function parseGpx(text) {
  return [...text.matchAll(/<trkpt\b[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"/gi)].map((m) => [Number(m[1]), Number(m[2])]);
}

function mLng(lat) { return M * Math.cos(lat * Math.PI / 180); }
function meters(a, b) { return Math.hypot((b[0] - a[0]) * M, (b[1] - a[1]) * mLng((a[0] + b[0]) / 2)); }
function lengthMeters(points) { let total = 0; for (let i = 1; i < points.length; i++) total += meters(points[i - 1], points[i]); return total; }

function simplifyBySpacing(points, spacingM) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || meters(last, p) >= spacingM) { out.push(p); last = p; }
  }
  const tail = points[points.length - 1];
  if (tail && out.length && meters(out[out.length - 1], tail) > 1) out.push(tail);
  return out;
}

function chunksWithOverlap(points, size = 95) {
  const chunks = [];
  for (let i = 0; i < points.length - 1; i += size - 1) {
    const chunk = points.slice(i, Math.min(points.length, i + size));
    if (chunk.length >= 2) chunks.push(chunk);
  }
  return chunks;
}

async function matchChunk(token, coords, radiusM) {
  const coordString = coords.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = new URL(`https://api.mapbox.com/matching/v5/mapbox/walking/${coordString}`);
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("steps", "false");
  url.searchParams.set("tidy", "false");
  url.searchParams.set("radiuses", coords.map(() => String(radiusM)).join(";"));
  url.searchParams.set("access_token", token);
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  if (!res.ok || data.code !== "Ok" || !data.matchings?.[0]?.geometry?.coordinates) {
    throw new Error(`${res.status} ${data.code ?? ""} ${data.message ?? JSON.stringify(data).slice(0, 300)}`);
  }
  return data.matchings[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

function gpx(name, points) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso Mapbox matching proof" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>\n${points.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>\n`;
}

function bounds(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

async function renderBlind(points, file) {
  const meanLat = points.reduce((s, p) => s + p[0], 0) / points.length;
  const meanLng = points.reduce((s, p) => s + p[1], 0) / points.length;
  const xy = ([lat, lng]) => [(lng - meanLng) * mLng(meanLat), (lat - meanLat) * M];
  const local = points.map(xy);
  const b = bounds(local);
  const pad = 230, w = 1100, h = 760;
  const view = { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
  const scale = Math.min((w - 60) / (view.maxX - view.minX || 1), (h - 60) / (view.maxY - view.minY || 1));
  const usedW = (view.maxX - view.minX) * scale, usedH = (view.maxY - view.minY) * scale;
  const ox = (w - usedW) / 2, oy = (h - usedH) / 2;
  const project = ([x, y]) => [ox + (x - view.minX) * scale, oy + (view.maxY - y) * scale];
  const d = local.map((p, i) => { const [x, y] = project(p); return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" stroke="#df7d25" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function main() {
  await loadEnv();
  const token = process.env.MAPBOX_ACCESS_TOKEN?.trim() || process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim();
  if (!token) throw new Error("Mapbox token missing from .env.local");
  await fs.mkdir(outDir, { recursive: true });
  const source = parseGpx(await fs.readFile(path.join(root, inputRel), "utf8"));
  const samples = simplifyBySpacing(source, 55);
  const chunkList = chunksWithOverlap(samples, 95);
  const matched = [];
  const errors = [];
  for (const [i, chunk] of chunkList.entries()) {
    try {
      const points = await matchChunk(token, chunk, 18);
      for (const p of points) if (!matched.length || meters(matched[matched.length - 1], p) > 1) matched.push(p);
    } catch (error) {
      errors.push({ chunk: i, message: error.message, points: chunk.length });
    }
  }
  await fs.writeFile(path.join(outDir, "mapbox-matched.gpx"), gpx("mapbox-matched-sneaker-proof", matched));
  await renderBlind(source, path.join(outDir, "source-gpx-blind.png"));
  if (matched.length >= 2) await renderBlind(matched, path.join(outDir, "mapbox-matched-blind.png"));
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({
    input: inputRel,
    sourcePoints: source.length,
    sourceKm: +(lengthMeters(source) / 1000).toFixed(2),
    sampledPoints: samples.length,
    chunks: chunkList.length,
    matchedPoints: matched.length,
    matchedKm: +(lengthMeters(matched) / 1000).toFixed(2),
    errors,
    artifacts: {
      sourceBlind: "source-gpx-blind.png",
      matchedBlind: matched.length >= 2 ? "mapbox-matched-blind.png" : null,
      matchedGpx: "mapbox-matched.gpx",
    },
  }, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => { console.error(error); process.exit(1); });