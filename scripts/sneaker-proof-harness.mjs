import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const {
  buildWalkingProofReport,
  parseGpxTrackpoints,
  selectValidationWaypointsBySpacing,
} = jiti("../lib/streetRouteProof.ts");

const MILES_TO_METERS = 1609.344;
const DEFAULT_TARGET_MILES = 11.25;

function usage() {
  console.error(`Usage:
  node scripts/sneaker-proof-harness.mjs <candidate.gpx> [options]

Options:
  --target-mi <miles>       Target sample length. Defaults to 11.25.
  --target-km <km>          Target sample length in kilometers.
  --target-m <meters>       Target sample length in meters.
  --out <dir>               Output directory. Defaults to tmp-sneaker-proof-harness.
  --label <name>            Human-readable run label.
  --chunk-size <n>          Mapbox coordinates per request, 2-25. Defaults to 25.
  --spacing-m <meters>      Validation waypoint spacing. Defaults to 350.
  --max-total-waypoints <n> Max validation waypoints across chunks. Defaults to 180.

The script requires MAPBOX_ACCESS_TOKEN or NEXT_PUBLIC_MAPBOX_TOKEN for the
Mapbox walking proof. Without a token it writes a blocked report instead of
claiming the route is valid.`);
}

function parseArgs(argv) {
  const args = {
    targetMeters: DEFAULT_TARGET_MILES * MILES_TO_METERS,
    outDir: "tmp-sneaker-proof-harness",
    label: null,
    chunkSize: 25,
    spacingMeters: 350,
    maxTotalWaypoints: 180,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target-mi") {
      args.targetMeters = Number(argv[++i]) * MILES_TO_METERS;
    } else if (arg === "--target-km") {
      args.targetMeters = Number(argv[++i]) * 1000;
    } else if (arg === "--target-m") {
      args.targetMeters = Number(argv[++i]);
    } else if (arg === "--out") {
      args.outDir = argv[++i];
    } else if (arg === "--label") {
      args.label = argv[++i];
    } else if (arg === "--chunk-size" || arg === "--max-waypoints") {
      args.chunkSize = Number(argv[++i]);
    } else if (arg === "--spacing-m") {
      args.spacingMeters = Number(argv[++i]);
    } else if (arg === "--max-total-waypoints") {
      args.maxTotalWaypoints = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) throw new Error("Expected exactly one GPX path.");
  if (!Number.isFinite(args.targetMeters) || args.targetMeters <= 0) {
    throw new Error("Target distance must be a positive number.");
  }
  if (
    !Number.isFinite(args.chunkSize) ||
    args.chunkSize < 2 ||
    args.chunkSize > 25
  ) {
    throw new Error("--chunk-size must be between 2 and 25.");
  }
  if (!Number.isFinite(args.spacingMeters) || args.spacingMeters < 25) {
    throw new Error("--spacing-m must be at least 25.");
  }
  if (!Number.isFinite(args.maxTotalWaypoints) || args.maxTotalWaypoints < 2) {
    throw new Error("--max-total-waypoints must be at least 2.");
  }
  return { ...args, gpxPath: positionals[0] };
}

function safeLabel(label, fallback) {
  return String(label || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "candidate";
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function loadLocalEnv(root) {
  for (const name of [".env.local", ".env"]) {
    let text;
    try {
      text = await fs.readFile(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] != null) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchMapboxWalkingRoute(waypoints, token) {
  const coordString = waypoints
    .map(([lat, lng]) => `${lng.toFixed(7)},${lat.toFixed(7)}`)
    .join(";");
  const url = new URL(
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordString}`,
  );
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", "full");
  url.searchParams.set("steps", "false");
  url.searchParams.set("alternatives", "false");
  url.searchParams.set("access_token", token);

  const res = await fetch(url);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Mapbox returned non-JSON (${res.status}): ${text.slice(0, 180)}`);
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || JSON.stringify(data).slice(0, 240);
    throw new Error(`Mapbox walking failed (${res.status}): ${msg}`);
  }
  const coords = data?.routes?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) {
    throw new Error("Mapbox response did not include route geometry.");
  }
  return coords
    .map((row) => [Number(row[1]), Number(row[0])])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
}
function chunkWaypoints(waypoints, chunkSize) {
  const chunks = [];
  let start = 0;
  while (start < waypoints.length - 1) {
    const end = Math.min(waypoints.length, start + chunkSize);
    const chunk = waypoints.slice(start, end);
    if (chunk.length >= 2) chunks.push(chunk);
    if (end >= waypoints.length) break;
    start = end - 1;
  }
  return chunks;
}

async function fetchChunkedMapboxWalkingRoute(waypoints, token, chunkSize) {
  const chunks = chunkWaypoints(waypoints, chunkSize);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    const route = await fetchMapboxWalkingRoute(chunks[i], token);
    if (i === 0) out.push(...route);
    else out.push(...route.slice(1));
  }
  return out;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function gpxFromCoords(coords, name) {
  const pts = coords
    .map(
      ([lat, lng]) =>
        `      <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso sneaker proof harness" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

function lineFeature(name, coords, color) {
  return {
    type: "Feature",
    properties: { name, stroke: color },
    geometry: {
      type: "LineString",
      coordinates: coords.map(([lat, lng]) => [lng, lat]),
    },
  };
}

function toGeoJson(candidate, mapbox, validationWaypoints) {
  return {
    type: "FeatureCollection",
    features: [
      lineFeature("candidate-gpx", candidate, "#df7d25"),
      lineFeature("mapbox-walking", mapbox, "#246bfe"),
      ...validationWaypoints.map(([lat, lng], i) => ({
        type: "Feature",
        properties: { name: `validation-${i + 1}` },
        geometry: { type: "Point", coordinates: [lng, lat] },
      })),
    ],
  };
}

function projectOverlay(points) {
  const meanLat =
    points.reduce((sum, [lat]) => sum + lat, 0) / Math.max(1, points.length);
  const meanLng =
    points.reduce((sum, [, lng]) => sum + lng, 0) / Math.max(1, points.length);
  const metersPerLat = 111_320;
  const metersPerLng = metersPerLat * Math.cos((meanLat * Math.PI) / 180);
  return ([lat, lng]) => [
    (lng - meanLng) * metersPerLng,
    (lat - meanLat) * metersPerLat,
  ];
}

function bounds(xys) {
  return xys.reduce(
    (b, [x, y]) => ({
      minX: Math.min(b.minX, x),
      maxX: Math.max(b.maxX, x),
      minY: Math.min(b.minY, y),
      maxY: Math.max(b.maxY, y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
}

function svgPath(coords, project, view) {
  const d = coords
    .map((p, i) => {
      const [x, y] = project(p);
      const sx = view.ox + (x - view.minX) * view.scale;
      const sy = view.oy + (view.maxY - y) * view.scale;
      return `${i ? "L" : "M"} ${sx.toFixed(1)} ${sy.toFixed(1)}`;
    })
    .join(" ");
  return d;
}

function pointSvg(point, project, view) {
  const [x, y] = project(point);
  const sx = view.ox + (x - view.minX) * view.scale;
  const sy = view.oy + (view.maxY - y) * view.scale;
  return `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="3.2" fill="#111111"/>`;
}

function renderBlindRouteSvg(coords) {
  const project = projectOverlay(coords);
  const xy = coords.map(project);
  const b = bounds(xy);
  const pad = 220;
  const w = 900;
  const h = 620;
  const minX = b.minX - pad;
  const maxX = b.maxX + pad;
  const minY = b.minY - pad;
  const maxY = b.maxY + pad;
  const scale = Math.min((w - 60) / (maxX - minX || 1), (h - 60) / (maxY - minY || 1));
  const view = {
    minX,
    maxX,
    minY,
    maxY,
    scale,
    ox: (w - (maxX - minX) * scale) / 2,
    oy: (h - (maxY - minY) * scale) / 2,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <path d="${svgPath(coords, project, view)}" stroke="#df7d25" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

async function writePngIfSharp(svg, outFile) {
  try {
    const sharp = require("sharp");
    await sharp(Buffer.from(svg)).png().toFile(outFile);
    return true;
  } catch {
    return false;
  }
}

function renderOverlaySvg(candidate, mapbox, validationWaypoints, report) {
  const all = [...candidate, ...mapbox, ...validationWaypoints];
  const project = projectOverlay(all);
  const xy = all.map(project);
  const b = bounds(xy);
  const pad = 260;
  const w = 1100;
  const h = 760;
  const minX = b.minX - pad;
  const maxX = b.maxX + pad;
  const minY = b.minY - pad;
  const maxY = b.maxY + pad;
  const scale = Math.min((w - 60) / (maxX - minX || 1), (h - 90) / (maxY - minY || 1));
  const view = {
    minX,
    maxX,
    minY,
    maxY,
    scale,
    ox: (w - (maxX - minX) * scale) / 2,
    oy: 54,
  };
  const verdict = report.pass ? "PASS" : "FAIL";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="30" y="30" font-family="Arial, sans-serif" font-size="18" fill="#111111">Sneaker proof overlay: ${verdict}</text>
  <text x="30" y="54" font-family="Arial, sans-serif" font-size="13" fill="#555555">orange=candidate GPX, blue=Mapbox walking route, black=validation waypoints</text>
  <path d="${svgPath(mapbox, project, view)}" stroke="#246bfe" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>
  <path d="${svgPath(candidate, project, view)}" stroke="#df7d25" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
  ${validationWaypoints.map((p) => pointSvg(p, project, view)).join("\n  ")}
</svg>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  await loadLocalEnv(root);
  const gpxAbs = path.resolve(root, args.gpxPath);
  const label = safeLabel(args.label, path.basename(args.gpxPath, path.extname(args.gpxPath)));
  const outDir = path.resolve(root, args.outDir, `${isoStamp()}-${label}`);
  await fs.mkdir(outDir, { recursive: true });

  const gpxText = await fs.readFile(gpxAbs, "utf8");
  const candidate = parseGpxTrackpoints(gpxText);
  const validationWaypoints = selectValidationWaypointsBySpacing(candidate, {
    spacingMeters: args.spacingMeters,
    maxWaypoints: args.maxTotalWaypoints,
  });
  await writeJson(path.join(outDir, "validation-waypoints.json"), validationWaypoints);

  const token = process.env.MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const envelope = {
    status: "blocked",
    pass: false,
    input: {
      gpxPath: path.relative(root, gpxAbs),
      label,
      targetDistanceMeters: args.targetMeters,
      chunkSize: args.chunkSize,
      spacingMeters: args.spacingMeters,
      maxTotalWaypoints: args.maxTotalWaypoints,
    },
    blockReason: null,
    proof: null,
  };

  if (!token) {
    envelope.blockReason = "mapbox_token_missing";
    await writeJson(path.join(outDir, "report.json"), envelope);
    console.log(path.relative(root, path.join(outDir, "report.json")));
    process.exitCode = 2;
    return;
  }

  let mapboxWalkingRoute;
  try {
    mapboxWalkingRoute = await fetchChunkedMapboxWalkingRoute(
      validationWaypoints,
      token,
      args.chunkSize,
    );
  } catch (err) {
    envelope.blockReason = "mapbox_fetch_failed";
    envelope.error = err instanceof Error ? err.message : String(err);
    await writeJson(path.join(outDir, "report.json"), envelope);
    console.log(path.relative(root, path.join(outDir, "report.json")));
    process.exitCode = 2;
    return;
  }

  const proof = buildWalkingProofReport({
    candidate,
    mapboxWalkingRoute,
    validationWaypoints,
    targetDistanceMeters: args.targetMeters,
  });
  const geojson = toGeoJson(candidate, mapboxWalkingRoute, validationWaypoints);
  const candidateBlindSvg = renderBlindRouteSvg(candidate);
  const mapboxBlindSvg = renderBlindRouteSvg(mapboxWalkingRoute);
  const candidateBlindPngPath = path.join(outDir, "candidate-blind.png");
  const mapboxBlindPngPath = path.join(outDir, "mapbox-walking-blind.png");
  const wroteCandidateBlindPng = await writePngIfSharp(
    candidateBlindSvg,
    candidateBlindPngPath,
  );
  const wroteMapboxBlindPng = await writePngIfSharp(
    mapboxBlindSvg,
    mapboxBlindPngPath,
  );
  await writeJson(path.join(outDir, "candidate-vs-mapbox.geojson"), geojson);
  await fs.writeFile(
    path.join(outDir, "candidate-vs-mapbox.svg"),
    renderOverlaySvg(candidate, mapboxWalkingRoute, validationWaypoints, proof),
  );
  await fs.writeFile(path.join(outDir, "candidate-blind.svg"), candidateBlindSvg);
  await fs.writeFile(path.join(outDir, "mapbox-walking-blind.svg"), mapboxBlindSvg);
  await fs.writeFile(
    path.join(outDir, "candidate.gpx"),
    gpxFromCoords(candidate, `${label} visual candidate route`),
  );
  await fs.writeFile(
    path.join(outDir, "mapbox-walking.gpx"),
    gpxFromCoords(mapboxWalkingRoute, `${label} Mapbox walking proof route`),
  );
  await writeJson(path.join(outDir, "report.json"), {
    status: "complete",
    pass: proof.pass,
    input: envelope.input,
    blockReason: null,
    proof,
    artifacts: {
      overlaySvg: "candidate-vs-mapbox.svg",
      geojson: "candidate-vs-mapbox.geojson",
      validationWaypoints: "validation-waypoints.json",
      candidateGpx: "candidate.gpx",
      candidateBlindSvg: "candidate-blind.svg",
      ...(wroteCandidateBlindPng
        ? { candidateBlindPng: "candidate-blind.png" }
        : {}),
      mapboxGpx: "mapbox-walking.gpx",
      mapboxBlindSvg: "mapbox-walking-blind.svg",
      ...(wroteMapboxBlindPng
        ? { mapboxBlindPng: "mapbox-walking-blind.png" }
        : {}),
    },
  });
  console.log(path.relative(root, path.join(outDir, "report.json")));
  if (!proof.pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
