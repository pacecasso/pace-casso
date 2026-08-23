/**
 * Export the chosen direct-grid gas logo route (SoHo pump + EV person).
 * Run: node scripts/export-gas-logo-final.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { streetGasLogoCandidates } = jiti("../lib/mapNativeDesigner.ts");
const { MANHATTAN_PRESET } = jiti("../lib/cityPresets.ts");
const { encodePolyline } = jiti("../lib/polylineEncode.ts");

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
}
loadLocalEnv();

const token = process.env.MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
const outDir = path.join(process.cwd(), "tmp-gas-logo-search");
fs.mkdirSync(outDir, { recursive: true });

const candidates = streetGasLogoCandidates(MANHATTAN_PRESET, 14);
const pick =
  candidates.find(
    (c) =>
      c.designIntent.includes("midtown-gas-icon-tall") &&
      Math.abs(c.placement.center[0] - 40.72425) < 0.002 &&
      Math.abs(c.placement.center[1] + 73.99624) < 0.002,
  ) ?? candidates[0];

const coords = pick.anchors;
let km = 0;
for (let i = 1; i < coords.length; i++) {
  const [lat1, lon1] = coords[i - 1];
  const [lat2, lon2] = coords[i];
  const latRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const mpl = 111_320;
  const mp = mpl * Math.cos(latRad);
  km += Math.hypot((lat2 - lat1) * mpl, (lon2 - lon1) * mp) / 1000;
}

const gpxPts = coords
  .map(
    ([lat, lng]) =>
      `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
  )
  .join("\n");
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>GAS company logo — Manhattan runnable</name>
    <desc>Direct-grid etch-a-sketch: pump (SoHo) + hose + headphone person (East Village). ~${km.toFixed(1)} km.</desc>
    <trkseg>
${gpxPts}
    </trkseg>
  </trk>
</gpx>`;

fs.writeFileSync(path.join(outDir, "GAS-LOGO-FINAL.gpx"), gpx);

const encoded = encodePolyline(coords);
// Mapbox static URL length limit — thin the polyline if needed.
let thin = coords;
if (coords.length > 200) {
  const step = Math.ceil(coords.length / 200);
  thin = coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
}
const encodedThin = encodePolyline(thin);
const mapUrl = `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/path-6+e60000-1(${encodeURIComponent(encodedThin)})/auto/1280x800?padding=60&access_token=${token}`;
const res = await fetch(mapUrl);
if (!res.ok) throw new Error(`map ${res.status}`);
fs.writeFileSync(
  path.join(outDir, "GAS-LOGO-FINAL-map.png"),
  Buffer.from(await res.arrayBuffer()),
);

const meta = {
  km: Number(km.toFixed(2)),
  vertexCount: coords.length,
  center: pick.placement.center,
  intent: pick.designIntent,
  routeMode: "direct-grid",
  note: "Corners follow Manhattan grid bearings — runnable as drawn. Pump left, person right, hose between.",
  gpx: path.join(outDir, "GAS-LOGO-FINAL.gpx"),
  map: path.join(outDir, "GAS-LOGO-FINAL-map.png"),
};
fs.writeFileSync(path.join(outDir, "GAS-LOGO-FINAL-meta.json"), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
