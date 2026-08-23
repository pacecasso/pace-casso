/**
 * Direct-grid gas logo search — anchors ARE the runnable route (no Mapbox snap).
 * Grid-walk strokes follow Manhattan avenue/street bearings only.
 *
 * Run: node scripts/search-gas-direct-grid.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

function loadLocalEnv() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] ||= value;
  }
  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN && process.env.MAPBOX_ACCESS_TOKEN) {
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN;
  }
}

loadLocalEnv();

const jiti = createJiti(import.meta.url);
const { streetGasLogoCandidates } = jiti("../lib/mapNativeDesigner.ts");
const { MANHATTAN_PRESET } = jiti("../lib/cityPresets.ts");
const { gasPumpPersonStructureScore } = jiti("../lib/autoFindTop5.ts");
const { routeQualityScore } = jiti("../lib/routeQuality.ts");
const { encodePolyline } = jiti("../lib/polylineEncode.ts");

const outDir = path.join(process.cwd(), "tmp-gas-logo-search");
fs.mkdirSync(outDir, { recursive: true });

const token = process.env.MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
if (!token) {
  console.error("Need MAPBOX token");
  process.exit(1);
}

function isOnManhattanWalkable(lat, lng) {
  if (lat < 40.705 || lat > 40.875) return false;
  if (lng < -74.02 || lng > -73.91) return false;
  if (lat < 40.715) {
    if (lng < -74.012 || lng > -73.975) return false;
  } else if (lat < 40.74) {
    if (lng < -74.01 || lng > -73.972) return false;
  } else if (lat < 40.765) {
    if (lng < -74.008 || lng > -73.968) return false;
  } else {
    if (lng < -74.005 || lng > -73.955) return false;
  }
  return true;
}

function routeKm(coords) {
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lat1, lon1] = coords[i - 1];
    const [lat2, lon2] = coords[i];
    const latRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const mpl = 111_320;
    const mp = mpl * Math.cos(latRad);
    km += Math.hypot((lat2 - lat1) * mpl, (lon2 - lon1) * mp) / 1000;
  }
  return km;
}

const hits = [];
for (const targetKm of [8, 9, 10, 11, 12, 13, 14, 15]) {
  const candidates = streetGasLogoCandidates(MANHATTAN_PRESET, targetKm);
  for (const c of candidates) {
    const coords = c.anchors;
    if (!coords.every(([lat, lng]) => isOnManhattanWalkable(lat, lng))) continue;
    const km = routeKm(coords);
    if (km < 7.5 || km > 18) continue;
    const structure = gasPumpPersonStructureScore(coords, c.placement);
    const clean = routeQualityScore(coords);
    if (structure < 70) continue;
    const distPenalty = Math.abs(km - 11) * 2;
    const score = structure * 0.55 + clean * 0.2 + Math.max(0, 30 - distPenalty);
    hits.push({ ...c, coords, km, structure, clean, score, targetKm });
  }
}

hits.sort((a, b) => b.score - a.score);
const top = hits.slice(0, 16);

async function fetchMapPng(coords, filePath) {
  const encoded = encodePolyline(coords);
  const url = `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/path-6+e60000-1(${encodeURIComponent(encoded)})/auto/1280x800?padding=60&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`static ${res.status}`);
  fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
}

for (let i = 0; i < top.length; i++) {
  const r = top[i];
  const id = String(i + 1).padStart(2, "0");
  const pngPath = path.join(outDir, `grid-${id}-s${Math.round(r.score)}.png`);
  try {
    await fetchMapPng(r.coords, pngPath);
    r.pngPath = pngPath;
  } catch (e) {
    r.pngError = String(e);
  }
  await new Promise((res) => setTimeout(res, 250));
}

if (top[0]?.pngPath) {
  fs.copyFileSync(top[0].pngPath, path.join(outDir, "BEST-DIRECT-GRID-map.png"));
  const gpxPts = top[0].coords
    .map(
      ([lat, lng]) =>
        `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
    )
    .join("\n");
  fs.writeFileSync(
    path.join(outDir, "BEST-DIRECT-GRID.gpx"),
    `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>PACE-CASSO GAS logo NYC direct grid</name><trkseg>
${gpxPts}
  </trkseg></trk>
</gpx>`,
  );
}

const summary = {
  total: hits.length,
  top: top.map((r, i) => ({
    rank: i + 1,
    score: Math.round(r.score),
    km: Number(r.km.toFixed(2)),
    targetKm: r.targetKm,
    structure: r.structure,
    clean: r.clean,
    center: r.placement.center,
    intent: r.designIntent?.slice(0, 80),
    pngPath: r.pngPath,
  })),
};

fs.writeFileSync(path.join(outDir, "direct-grid-results.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
