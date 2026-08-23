/**
 * Build runnable GAS logo via intersection-graph pipeline.
 * 1) Geocode named NYC intersections → snap to walk network
 * 2) Axis-only leg-by-leg Mapbox routing
 * 3) Fallback: grid placement search
 *
 * Run: npx tsx scripts/build-gas-logo-intersection-route.ts
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  buildGasLogoFromGridPlacement,
  buildGasLogoFromNamedIntersections,
  GAS_LOGO_AVENUE_METERS,
  GAS_LOGO_SEARCH_CENTERS,
  GAS_LOGO_STREET_METERS,
  type GasLogoRouteResult,
} from "../lib/gasLogoIntersectionRoute";
import { gasLogoIntersectionAnchors } from "../lib/gasLogoIntersections";
import { encodePolyline } from "../lib/polylineEncode";
import { getServerMapboxToken } from "../lib/mapboxServerToken";
import { routeToGpx } from "../lib/routeExport";
import {
  assertAxisAlignedAnchors,
  decomposeToAxisAnchors,
} from "../lib/gridRouteUtils";
import { snapAnchorsToWalkNetwork } from "../lib/walkNetworkSnap";

const root = process.cwd();
const outDir = path.join(root, "tmp-gas-logo-search", "intersection-graph");
fs.mkdirSync(outDir, { recursive: true });

const envPath = path.join(root, ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!(m[1]! in process.env)) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
  }
}
if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() && process.env.MAPBOX_ACCESS_TOKEN?.trim()) {
  process.env.NEXT_PUBLIC_MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN.trim();
}

async function staticMap(coords: [number, number][], outPath: string) {
  const token = getServerMapboxToken();
  if (!token) throw new Error("MAPBOX token missing");
  const thin =
    coords.length > 220
      ? coords.filter((_, i) => i % Math.ceil(coords.length / 220) === 0 || i === coords.length - 1)
      : coords;
  const url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/path-6+e60000(${encodeURIComponent(encodePolyline(thin))})/auto/1200x900?padding=70&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`static map ${res.status}`);
  await sharp(Buffer.from(await res.arrayBuffer())).png().toFile(outPath);
}

async function tryNamedIntersections(): Promise<GasLogoRouteResult | null> {
  console.log("▶ Verified named intersections…");
  const raw = gasLogoIntersectionAnchors();
  fs.writeFileSync(
    path.join(outDir, "verified-anchors.json"),
    JSON.stringify(raw, null, 2),
  );

  console.log(`  Snapping ${raw.length} corners to walk network…`);
  const snapped = await snapAnchorsToWalkNetwork(raw, 50);
  const axis = assertAxisAlignedAnchors(snapped)
    ? snapped
    : decomposeToAxisAnchors(snapped);
  if (!assertAxisAlignedAnchors(axis)) {
    console.log("  ✗ snapped anchors not axis-aligned");
    return null;
  }

  fs.writeFileSync(
    path.join(outDir, "axis-anchors.json"),
    JSON.stringify({ raw, snapped, axis }, null, 2),
  );

  console.log("  Routing leg-by-leg…");
  const result = await buildGasLogoFromNamedIntersections(axis, {
    maxLegMeters: 1200,
    maxHopMeters: 320,
    snapDelayMs: 0,
  });

  if (!result.ok) {
    console.log(`  ✗ ${result.reason}`);
    return null;
  }
  return result;
}

async function searchGridPlacements(): Promise<GasLogoRouteResult | null> {
  console.log("\n▶ Grid placement search…");
  const wins: GasLogoRouteResult[] = [];

  for (const center of GAS_LOGO_SEARCH_CENTERS) {
    for (const streetMeters of GAS_LOGO_STREET_METERS) {
      for (const avenueMeters of GAS_LOGO_AVENUE_METERS) {
        const label = `${center.map((v) => v.toFixed(3)).join(",")} s=${streetMeters} a=${avenueMeters}`;
        process.stdout.write(`  ${label}… `);
        const r = await buildGasLogoFromGridPlacement(
          { center, streetMeters, avenueMeters },
          { maxLegMeters: 850, maxHopMeters: 150, snapDelayMs: 35 },
        );
        if (r.ok) {
          console.log(`PASS ${r.km.toFixed(1)}km struct=${r.structureScore}`);
          wins.push(r);
        } else {
          console.log(r.reason);
        }
      }
    }
  }

  if (!wins.length) return null;
  wins.sort(
    (a, b) =>
      b.structureScore - a.structureScore ||
      b.shapeMatch - a.shapeMatch ||
      -Math.abs(a.km - 11) + Math.abs(b.km - 11),
  );
  return wins[0]!;
}

async function exportWinner(best: GasLogoRouteResult) {
  const mapPath = path.join(outDir, "GAS-intersection-graph-map.png");
  const gpxPath = path.join(outDir, "GAS-intersection-graph.gpx");
  await staticMap(best.coordinates, mapPath);
  fs.writeFileSync(
    gpxPath,
    routeToGpx(
      { coordinates: best.coordinates, distanceMeters: best.km * 1000 },
      [],
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(outDir, "route.json"), JSON.stringify(best, null, 2));

  const gasPath = path.join(root, "gas.png");
  const sheetPath = path.join(outDir, "GAS-intersection-graph-comparison.png");
  if (fs.existsSync(gasPath)) {
    const up = await sharp(gasPath).resize(420, 420, { fit: "inside", background: "#fff" }).toBuffer();
    const mp = await sharp(mapPath).resize(420, 420, { fit: "inside", background: "#fff" }).toBuffer();
    await sharp({
      create: { width: 870, height: 460, channels: 3, background: "#f5f5f5" },
    })
      .composite([
        { input: up, left: 10, top: 20 },
        { input: mp, left: 440, top: 20 },
      ])
      .png()
      .toFile(sheetPath);
  }

  return { mapPath, gpxPath, sheetPath };
}

async function main() {
  let best = await tryNamedIntersections();
  if (!best) {
    console.log("\nNamed route failed — skipping grid search in CI; run grid manually if needed.");
    // best = await searchGridPlacements();
  }

  if (!best) {
    console.error("\nNo candidate passed intersection-graph bar.");
    process.exit(1);
  }

  const files = await exportWinner(best);
  const verdict = {
    pipeline: "intersection-graph: geocoded corners → walk-network snap → axis leg-by-leg",
    source: best.source,
    km: best.km,
    maxHopMeters: best.maxHopMeters,
    structureScore: best.structureScore,
    shapeMatch: best.shapeMatch,
    qualityScore: best.qualityScore,
    rejectedLegs: best.rejectedLegs,
    files,
  };
  fs.writeFileSync(path.join(outDir, "verdict.json"), JSON.stringify(verdict, null, 2));
  console.log("\n", JSON.stringify(verdict, null, 2));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
