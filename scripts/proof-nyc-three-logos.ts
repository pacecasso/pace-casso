/**
 * NYC proof: gas + star + swoosh — search distance × placement, then snap + score.
 *
 * Sweeps target km (10–18) and Manhattan centers (EV, Chelsea, Midtown…),
 * generates map-native + route-library candidates, snaps each, picks best shape.
 *
 * Run: npx tsx scripts/proof-nyc-three-logos.ts
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  addRepresentativeDesignDrafts,
  cleanVisionDesignDrafts,
  gasPumpPersonStructureScore,
  routeShapeMatchPercent,
  type VisionDesignDraft,
} from "../lib/autoFindTop5";
import { MANHATTAN_PRESET } from "../lib/cityPresets";
import {
  generateMapNativeCandidates,
  manhattanRouteLibraryCandidates,
  type MapNativeCandidate,
} from "../lib/mapNativeDesigner";
import { encodePolyline } from "../lib/polylineEncode";
import { getServerMapboxToken } from "../lib/mapboxServerToken";
import { routeToGpx } from "../lib/routeExport";
import { routeQualityScore } from "../lib/routeQuality";
import { snapWalkingRoute } from "../lib/snapWalkingRoute";
import { loadUploadContour } from "../tmp-heart-qa/loadUploadContour";
import type { LatLng } from "../lib/routeLegByLeg";

const root = process.cwd();
const outDir = path.join(root, "tmp-nyc-three-logos");
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

/** Manhattan walkable envelope — rejects Hudson / East River. */
function isOnManhattanWalkable(lat: number, lng: number): boolean {
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

type LogoJob = {
  id: string;
  label: string;
  sourceImage: string;
  distancesKm: number[];
  buildDrafts: (contour: { x: number; y: number }[]) => VisionDesignDraft[];
  /** Route-library templates to re-center / scale across the island. */
  librarySeeds?: LatLng[][];
};

/** Neighborhoods with a regular grid — good for icon GPS art. */
const PLACEMENT_CENTERS: LatLng[] = [
  [40.724, -74.002], // SoHo
  [40.728, -73.991], // East Village
  [40.734, -73.993], // EV / LES edge
  [40.738, -73.987], // Gramercy
  [40.742, -73.997], // Chelsea
  [40.748, -73.986], // Murray Hill
  [40.755, -73.985], // Midtown
  [40.761, -73.988], // Columbus Circle
];

const PLACEMENT_SCALES = [0.92, 1.0, 1.12, 1.28, 1.42];

const STAR_SEED: LatLng[] = [
  [40.762, -73.986],
  [40.752, -73.982],
  [40.751, -73.971],
  [40.744, -73.979],
  [40.731, -73.974],
  [40.738, -73.986],
  [40.731, -73.998],
  [40.744, -73.993],
  [40.751, -74.002],
  [40.752, -73.990],
  [40.762, -73.986],
];

const SWOOSH_SEED: LatLng[] = [
  [40.724, -74.006],
  [40.727, -73.999],
  [40.734, -73.990],
  [40.746, -73.980],
  [40.760, -73.971],
  [40.752, -73.975],
  [40.738, -73.986],
  [40.727, -73.998],
  [40.724, -74.006],
];

const JOBS: LogoJob[] = [
  {
    id: "gas",
    label: "GAS company logo (gas.png)",
    sourceImage: "gas.png",
    distancesKm: [10, 12, 14, 16, 18],
    buildDrafts: () =>
      addRepresentativeDesignDrafts(
        cleanVisionDesignDrafts({
          drafts: [
            {
              label: "Uploaded gas mark",
              description:
                "yellow circle gas pump with hose loop and headphone person holding nozzle",
              visualFeatures: ["gas", "pump", "hose loop", "headphones", "person", "window", "body", "legs"],
              points: [
                { x: 0.1, y: 0.1 },
                { x: 0.9, y: 0.9 },
              ],
              designScore: 90,
            },
          ],
        }),
        [
          {
            label: "Uploaded gas mark",
            description: "gas pump hose loop headphone person",
            visualFeatures: ["gas", "pump", "hose", "headphones", "person"],
          },
        ],
      ),
  },
  {
    id: "star",
    label: "Five-point star",
    sourceImage: "tmp-nyc-three-logos/fixtures/star.svg",
    distancesKm: [8, 10, 12, 14, 16],
    librarySeeds: [STAR_SEED],
    buildDrafts: () =>
      cleanVisionDesignDrafts({
        drafts: [
          {
            label: "Five-point star",
            description: "five-point star sharp tips on midtown grid",
            visualFeatures: ["star", "five points", "sharp tips", "inner crossings"],
            points: [
              { x: 0.5, y: 0.05 },
              { x: 0.62, y: 0.38 },
              { x: 0.95, y: 0.38 },
              { x: 0.68, y: 0.6 },
              { x: 0.78, y: 0.95 },
              { x: 0.5, y: 0.72 },
              { x: 0.22, y: 0.95 },
              { x: 0.32, y: 0.6 },
              { x: 0.05, y: 0.38 },
              { x: 0.38, y: 0.38 },
              { x: 0.5, y: 0.05 },
            ],
            designScore: 100,
          },
        ],
      }),
  },
  {
    id: "swoosh",
    label: "Nike-style swoosh",
    sourceImage: "tmp-nyc-three-logos/fixtures/swoosh.svg",
    distancesKm: [8, 10, 12, 14, 16],
    librarySeeds: [SWOOSH_SEED],
    buildDrafts: () =>
      cleanVisionDesignDrafts({
        drafts: [
          {
            label: "Nike swoosh",
            description: "tapered swoosh wide heel thin rising tip curve",
            visualFeatures: ["swoosh", "curve", "tapered outline", "rising tail", "checkmark"],
            points: [
              { x: 0.05, y: 0.72 },
              { x: 0.28, y: 0.78 },
              { x: 0.52, y: 0.58 },
              { x: 0.76, y: 0.32 },
              { x: 0.95, y: 0.12 },
              { x: 0.72, y: 0.34 },
              { x: 0.48, y: 0.54 },
              { x: 0.22, y: 0.68 },
              { x: 0.05, y: 0.72 },
            ],
            designScore: 100,
          },
        ],
      }),
  },
];

function anchorCentroid(anchors: LatLng[]): LatLng {
  let lat = 0;
  let lng = 0;
  for (const [a, b] of anchors) {
    lat += a;
    lng += b;
  }
  return [lat / anchors.length, lng / anchors.length];
}

function routeLengthKm(coords: LatLng[]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lat1, lng1] = coords[i - 1]!;
    const [lat2, lng2] = coords[i]!;
    const latRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const mpl = 111_320;
    const mpLng = mpl * Math.cos(latRad);
    m += Math.hypot((lat2 - lat1) * mpl, (lng2 - lng1) * mpLng);
  }
  return m / 1000;
}

function moveScaleAnchors(
  anchors: LatLng[],
  toCenter: LatLng,
  scale: number,
  fromCenter = anchorCentroid(anchors),
): LatLng[] {
  const mpl = 111_320;
  const mpLng = mpl * Math.cos((fromCenter[0] * Math.PI) / 180);
  return anchors.map(([lat, lng]) => {
    const north = (lat - fromCenter[0]) * mpl * scale;
    const east = (lng - fromCenter[1]) * mpLng * scale;
    return [
      Number((toCenter[0] + north / mpl).toFixed(6)),
      Number((toCenter[1] + east / mpLng).toFixed(6)),
    ] as LatLng;
  });
}

function anchorKey(anchors: LatLng[]): string {
  return anchors.map((p) => p.map((v) => v.toFixed(4)).join(",")).join("|");
}

function anchorsWalkable(anchors: LatLng[]): boolean {
  return anchors.every(([lat, lng]) => isOnManhattanWalkable(lat, lng));
}

function collectCandidates(
  job: LogoJob,
  drafts: VisionDesignDraft[],
): MapNativeCandidate[] {
  const seen = new Set<string>();
  const out: MapNativeCandidate[] = [];

  const push = (c: MapNativeCandidate) => {
    const key = anchorKey(c.anchors);
    if (seen.has(key)) return;
    if (!anchorsWalkable(c.anchors)) return;
    seen.add(key);
    out.push(c);
  };

  for (const targetKm of job.distancesKm) {
    for (const c of generateMapNativeCandidates({
      drafts,
      preset: MANHATTAN_PRESET,
      targetDistanceKm: targetKm,
    })) {
      push(c);
    }
    for (const c of manhattanRouteLibraryCandidates(drafts, MANHATTAN_PRESET, targetKm)) {
      push(c);
    }
  }

  for (const seed of job.librarySeeds ?? []) {
    const seedCenter = anchorCentroid(seed);
    const seedKm = routeLengthKm(seed);
    for (const center of PLACEMENT_CENTERS) {
      for (const targetKm of job.distancesKm) {
        const scaleFromDistance = targetKm / Math.max(seedKm, 1);
        for (const placementScale of PLACEMENT_SCALES) {
          const scale = scaleFromDistance * placementScale;
          const anchors = moveScaleAnchors(seed, center, scale, seedCenter);
          if (!anchorsWalkable(anchors)) continue;
          push({
            placement: { center, rotationDeg: 29, scale },
            anchors,
            km: routeLengthKm(anchors),
            designIntent: `placement-search ${job.id} @ ${center.join(",")} scale=${scale.toFixed(2)}`,
            kind: "street-design",
          });
        }
      }
    }
  }

  return out;
}

type ScoredHit = {
  coords: LatLng[];
  km: number;
  shape: number;
  source: number;
  quality: number;
  gasStructure: number;
  score: number;
  intent: string;
  targetKm: number;
  center: LatLng;
};

async function snapAndScore(
  job: LogoJob,
  candidate: MapNativeCandidate,
  sourceContour: LatLng[],
): Promise<ScoredHit | null> {
  try {
    const route = await snapWalkingRoute(candidate.anchors, {
      anchorSource: "image",
      startVariantCount: 2,
    });
    const coords = route.coordinates as LatLng[];
    if (coords.length < 8) return null;
    if (coords.some(([lat, lng]) => !isOnManhattanWalkable(lat, lng))) return null;

    const km = (route.distanceMeters ?? routeLengthKm(coords) * 1000) / 1000;
    if (km < 5 || km > 28) return null;

    const shape = routeShapeMatchPercent(candidate.anchors, coords);
    const source = routeShapeMatchPercent(sourceContour, coords);
    const quality = routeQualityScore(coords);
    const gasStructure =
      job.id === "gas"
        ? gasPumpPersonStructureScore(coords, candidate.placement)
        : 0;

    let score = shape * 0.55 + source * 0.2 + quality * 0.15;
    if (job.id === "gas") score += gasStructure * 0.25;
    else score += shape * 0.1;

    // Prefer routes near requested scale (larger = more readable on Strava).
    const targetKm = job.distancesKm[job.distancesKm.length - 1] ?? 12;
    const kmPenalty = Math.abs(km - targetKm) * 1.5;
    score -= kmPenalty;

    return {
      coords,
      km,
      shape,
      source,
      quality,
      gasStructure,
      score,
      intent: candidate.designIntent,
      targetKm,
      center: candidate.placement.center,
    };
  } catch {
    return null;
  }
}

async function staticMap(coords: LatLng[], outPath: string): Promise<void> {
  const token = getServerMapboxToken();
  if (!token) throw new Error("MAPBOX token missing");
  if (!token) throw new Error("Mapbox token missing");
  const url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/path-6+e60000(${encodeURIComponent(encodePolyline(coords))})/auto/1000x1000?padding=80&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`map ${res.status}`);
  await sharp(Buffer.from(await res.arrayBuffer())).png().toFile(outPath);
}

async function searchJob(job: LogoJob): Promise<ScoredHit | null> {
  const srcPath = path.join(root, job.sourceImage);
  const contourRaw = await loadUploadContour(srcPath);
  if (!contourRaw?.length) return null;

  const drafts = job.buildDrafts(contourRaw.map((p) => ({ x: p.x, y: p.y })));
  const candidates = collectCandidates(job, drafts);
  console.log(`  ${candidates.length} candidates`);

  // Snap the most promising anchor sets first (closer to mid-target distance).
  const midTarget = job.distancesKm[Math.floor(job.distancesKm.length / 2)] ?? 12;
  candidates.sort(
    (a, b) => Math.abs(a.km - midTarget) - Math.abs(b.km - midTarget),
  );
  const toTry = candidates.slice(0, Math.min(36, candidates.length));

  const sourceContour: LatLng[] = contourRaw.map((p) => [p.y, p.x]); // rough lat/lng proxy for scoring
  // Better: build a placement-neutral source from normalized contour at a fixed center
  const fixedCenter: LatLng = [40.738, -73.99];
  const mpl = 111_320;
  const mpLng = mpl * Math.cos((fixedCenter[0] * Math.PI) / 180);
  const normSource: LatLng[] = contourRaw.map((p) => [
    fixedCenter[0] + (0.5 - p.y) * 0.08,
    fixedCenter[1] + (p.x - 0.5) * 0.08 * (mpLng / mpl),
  ]);

  let best: ScoredHit | null = null;
  const batch = 3;
  for (let i = 0; i < toTry.length; i += batch) {
    const chunk = toTry.slice(i, i + batch);
    const hits = await Promise.all(
      chunk.map((c) => snapAndScore(job, c, normSource)),
    );
    for (const hit of hits) {
      if (!hit) continue;
      if (!best || hit.score > best.score) best = hit;
      process.stdout.write(
        `.${hit.shape}${job.id === "gas" ? `g${hit.gasStructure}` : ""}`,
      );
    }
  }
  return best;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const results: {
    id: string;
    label: string;
    km: number;
    shapeMatch: number;
    quality: number;
    gasStructure?: number;
    map: string;
    gpx: string;
    source: string;
    intent: string;
    center: LatLng;
  }[] = [];

  for (const job of JOBS) {
    process.stdout.write(`${job.id}...`);
    const best = await searchJob(job);
    if (!best) {
      console.log(" none");
      continue;
    }

    const srcPath = path.join(root, job.sourceImage);
    const mapPath = path.join(outDir, `${job.id}-STREETS-map.png`);
    const gpxPath = path.join(outDir, `${job.id}-RUNNABLE.gpx`);

    await staticMap(best.coords, mapPath);
    fs.writeFileSync(
      gpxPath,
      routeToGpx(
        { coordinates: best.coords, distanceMeters: best.km * 1000 },
        [],
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, `${job.id}-result.json`),
      JSON.stringify(best, null, 2),
    );

    console.log(
      `\n  ★ ${best.km.toFixed(1)}km shape=${best.shape}% clean=${best.quality}%` +
        (job.id === "gas" ? ` gas=${best.gasStructure}%` : "") +
        ` @ [${best.center.map((v) => v.toFixed(3)).join(", ")}]`,
    );

    results.push({
      id: job.id,
      label: job.label,
      km: best.km,
      shapeMatch: best.shape,
      quality: best.quality,
      gasStructure: job.id === "gas" ? best.gasStructure : undefined,
      map: mapPath,
      gpx: gpxPath,
      source: srcPath,
      intent: best.intent,
      center: best.center,
    });
  }

  if (!results.length) {
    console.error("No logo routed.");
    process.exit(1);
  }

  const panelW = 480;
  const sheetW = results.length * (panelW * 2 + 40) + 20;
  const composites: { input: Buffer; left: number; top: number }[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const srcBuf = fs.existsSync(r.source)
      ? await sharp(r.source).resize(panelW, panelW, { fit: "inside", background: "#fff" }).png().toBuffer()
      : await sharp({ create: { width: panelW, height: panelW, channels: 3, background: "#eee" } })
          .png()
          .toBuffer();
    const mapBuf = await sharp(r.map).resize(panelW, panelW, { fit: "inside" }).toBuffer();
    const col = i * (panelW * 2 + 40);
    composites.push({ input: srcBuf, left: col + 10, top: 50 });
    composites.push({ input: mapBuf, left: col + panelW + 30, top: 50 });
  }

  const sheetPath = path.join(outDir, "NYC-THREE-LOGOS-sheet.png");
  await sharp({
    create: { width: sheetW, height: panelW + 80, channels: 3, background: "#f4f4f4" },
  })
    .composite(composites)
    .png()
    .toFile(sheetPath);

  const verdict = {
    note: "Distance × placement search → snapWalkingRoute. Left = upload, right = best snapped route.",
    logos: results,
    sheet: sheetPath,
  };
  fs.writeFileSync(path.join(outDir, "verdict.json"), JSON.stringify(verdict, null, 2));
  console.log("\n", JSON.stringify(verdict, null, 2));
  console.log(sheetPath);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
