/**
 * Two-phase Manhattan gas-logo search:
 * 1) sweep sparse grid-stroke anchors (no API)
 * 2) Mapbox leg-by-leg on top candidates → Mapbox static preview
 *
 * Run: node scripts/search-gas-logo-manhattan.mjs
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
  process.env.NEXT_PUBLIC_MAPBOX_PROXY = "0";
}

loadLocalEnv();

const jiti = createJiti(import.meta.url);
const { routeLegByLegResilient } = jiti("../lib/routeLegByLeg.ts");
const { gasPumpPersonStructureScore } = jiti("../lib/autoFindTop5.ts");
const { routeQualityScore } = jiti("../lib/routeQuality.ts");
const { encodePolyline } = jiti("../lib/polylineEncode.ts");

const outDir = path.join(process.cwd(), "tmp-gas-logo-search");
fs.mkdirSync(outDir, { recursive: true });

const token = process.env.MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
if (!token) {
  console.error("Need MAPBOX token in .env.local");
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

function bearingUnitVector(deg) {
  const rad = (deg * Math.PI) / 180;
  return { east: Math.sin(rad), north: Math.cos(rad) };
}

function offsetLatLngMeters([lat, lon], east, north) {
  const metersPerLat = 111_320;
  const metersPerLon = metersPerLat * Math.cos((lat * Math.PI) / 180);
  return [
    Number((lat + north / metersPerLat).toFixed(6)),
    Number((lon + east / metersPerLon).toFixed(6)),
  ];
}

/** Sparse etch-a-sketch strokes — pump | hose | person (grid units). */
const ART_STROKES = [
  [
    [-5.1, -5.2],
    [-5.1, 5.6],
    [-2.4, 5.6],
    [-2.4, 4.1],
    [-3.35, 4.1],
    [-2.85, 4.1],
    [-2.85, 4.95],
    [-3.35, 4.95],
    [-3.35, 4.1],
    [-2.4, 4.1],
    [-2.4, -5.2],
    [-5.1, -5.2],
    [-5.1, 0.2],
    [-2.4, 0.2],
  ],
  [
    [-1.7, 0.2],
    [-1.7, -2.6],
    [-0.9, -2.6],
    [-0.9, 1.6],
    [0.4, 1.6],
  ],
  [
    [1.15, 5.7],
    [2.05, 6.45],
    [2.95, 5.7],
    [3.05, 4.95],
    [2.35, 5.35],
    [1.25, 5.25],
    [2.05, 4.55],
    [2.05, 0.45],
    [1.35, -5.1],
    [2.05, 0.45],
    [2.75, -5.1],
    [2.05, 0.45],
    [2.4, 3.6],
    [3.15, 5.85],
  ],
];

function buildAnchors({ center, xStepMeters, yStepMeters, streetBearingDeg, avenueBearingDeg, scale }) {
  const xAxis = bearingUnitVector(streetBearingDeg);
  const yAxis = bearingUnitVector(avenueBearingDeg);

  function gridPoint(x, y) {
    const sx = x * scale;
    const sy = y * scale;
    const east = sx * xStepMeters * xAxis.east + sy * yStepMeters * yAxis.east;
    const north = sx * xStepMeters * xAxis.north + sy * yStepMeters * yAxis.north;
    return offsetLatLngMeters(center, east, north);
  }

  const anchors = [];
  const push = (pt) => {
    if (!pt) return;
    const last = anchors[anchors.length - 1];
    if (last && last[0] === pt[0] && last[1] === pt[1]) return;
    anchors.push(pt);
  };

  for (const stroke of ART_STROKES) {
    for (const [x, y] of stroke) push(gridPoint(x, y));
  }
  return anchors;
}

function routeKm(points) {
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const [lat1, lon1] = points[i - 1];
    const [lat2, lon2] = points[i];
    const latRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const mpl = 111_320;
    const mp = mpl * Math.cos(latRad);
    km += Math.hypot((lat2 - lat1) * mpl, (lon2 - lon1) * mp) / 1000;
  }
  return km;
}

function placementFromAnchors(anchors, bearing) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of anchors) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  return {
    center: [(minLat + maxLat) / 2, (minLng + maxLng) / 2],
    rotationDeg: bearing,
    scale: 1,
  };
}

const CENTERS = [
  [40.726, -73.998],
  [40.728, -73.992],
  [40.7302, -73.9885],
  [40.732, -73.986],
  [40.734, -73.994],
  [40.736, -73.988],
  [40.738, -73.982],
  [40.742, -73.993],
  [40.745, -73.986],
  [40.722, -73.986],
];

const X_STEPS = [220, 248, 275, 300];
const Y_STEPS = [68, 72, 80, 88];
const STREET_BEARINGS = [104, 107, 110];
const AVENUE_OFFSETS = [10, 17, 24];
const SCALES = [0.9, 1.0, 1.1, 1.22];

const phase1 = [];
for (const center of CENTERS) {
  for (const xStepMeters of X_STEPS) {
    for (const yStepMeters of Y_STEPS) {
      for (const streetBearingDeg of STREET_BEARINGS) {
        for (const avenueOffset of AVENUE_OFFSETS) {
          const avenueBearingDeg = streetBearingDeg + avenueOffset;
          for (const scale of SCALES) {
            const anchors = buildAnchors({
              center,
              xStepMeters,
              yStepMeters,
              streetBearingDeg,
              avenueBearingDeg,
              scale,
            });
            if (anchors.length < 12) continue;
            if (!anchors.every(([lat, lng]) => isOnManhattanWalkable(lat, lng))) continue;

            const anchorKm = routeKm(anchors);
            if (anchorKm < 7 || anchorKm > 16) continue;

            const placement = placementFromAnchors(anchors, streetBearingDeg);
            const structure = gasPumpPersonStructureScore(anchors, placement);
            if (structure < 55) continue;

            phase1.push({
              structure,
              anchorKm,
              center,
              xStepMeters,
              yStepMeters,
              streetBearingDeg,
              avenueBearingDeg,
              scale,
              anchors,
              placement,
            });
          }
        }
      }
    }
  }
}

phase1.sort((a, b) => b.structure - a.structure || Math.abs(a.anchorKm - 11) - Math.abs(b.anchorKm - 11));
const toRoute = phase1.slice(0, 18);

console.log(`Phase 1: ${phase1.length} anchor sets, routing top ${toRoute.length}…`);

const routed = [];
for (let i = 0; i < toRoute.length; i++) {
  const c = toRoute[i];
  process.stdout.write(`  route ${i + 1}/${toRoute.length}… `);
  try {
    const result = await routeLegByLegResilient(c.anchors, {
      maxLegMeters: 850,
      validatePoint: isOnManhattanWalkable,
    });
    const km = result.distanceMeters / 1000;
    const ratio = km / c.anchorKm;
    const structure = gasPumpPersonStructureScore(result.coordinates, c.placement);
    const clean = routeQualityScore(result.coordinates);
    const score =
      structure * 0.5 +
      clean * 0.2 +
      (ratio >= 0.85 && ratio <= 1.45 ? 25 : 0) +
      (km >= 9 && km <= 16 ? 15 : 0) -
      result.rejectedLegs * 10;

    routed.push({
      ...c,
      coords: result.coordinates,
      km,
      ratio,
      structureRouted: structure,
      clean,
      rejectedLegs: result.rejectedLegs,
      score,
    });
    console.log(`ok ${km.toFixed(1)}km struct=${structure} rej=${result.rejectedLegs}`);
  } catch (e) {
    console.log(`fail ${e instanceof Error ? e.message : e}`);
  }
  await new Promise((r) => setTimeout(r, 250));
}

routed.sort((a, b) => b.score - a.score);
const top = routed.slice(0, 8);

async function fetchMapPng(coords, filePath) {
  const step = coords.length > 500 ? Math.ceil(coords.length / 500) : 1;
  const simplified = coords.filter((_, i) => i % step === 0);
  const encoded = encodePolyline(simplified);
  const url = `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/path-6+e60000-1(${encodeURIComponent(encoded)})/auto/1280x800?padding=60&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox static ${res.status}`);
  fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
}

for (let i = 0; i < top.length; i++) {
  const r = top[i];
  const id = String(i + 1).padStart(2, "0");
  const pngPath = path.join(outDir, `candidate-${id}-s${Math.round(r.score)}.png`);
  try {
    await fetchMapPng(r.coords, pngPath);
    r.pngPath = pngPath;
    fs.writeFileSync(
      path.join(outDir, `candidate-${id}.json`),
      JSON.stringify(
        {
          score: r.score,
          km: r.km,
          anchorKm: r.anchorKm,
          ratio: r.ratio,
          structure: r.structureRouted,
          clean: r.clean,
          rejectedLegs: r.rejectedLegs,
          center: r.center,
          xStepMeters: r.xStepMeters,
          yStepMeters: r.yStepMeters,
          streetBearingDeg: r.streetBearingDeg,
          scale: r.scale,
          anchorCount: r.anchors.length,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    r.pngError = String(e);
  }
  await new Promise((res) => setTimeout(res, 300));
}

if (top[0]) {
  const best = top[0];
  const gpxPts = best.coords
    .map(
      ([lat, lng]) =>
        `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
    )
    .join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>PACE-CASSO GAS logo NYC</name><trkseg>
${gpxPts}
  </trkseg></trk>
</gpx>`;
  fs.writeFileSync(path.join(outDir, "BEST-GAS-LOGO.gpx"), gpx);
  fs.copyFileSync(best.pngPath, path.join(outDir, "BEST-GAS-LOGO-map.png"));
}

const summary = {
  phase1Count: phase1.length,
  routedCount: routed.length,
  top: top.map((r, i) => ({
    rank: i + 1,
    score: Math.round(r.score),
    km: Number(r.km.toFixed(2)),
    structure: r.structureRouted,
    clean: r.clean,
    rejectedLegs: r.rejectedLegs,
    center: r.center,
    scale: r.scale,
    xStep: r.xStepMeters,
    yStep: r.yStepMeters,
    bearing: r.streetBearingDeg,
    pngPath: r.pngPath,
  })),
};

fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
