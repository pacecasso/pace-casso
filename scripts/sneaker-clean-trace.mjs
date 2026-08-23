import fs from "node:fs/promises";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseGpxTrackpoints,
  pathDistanceMeters,
} = jiti("../lib/streetRouteProof.ts");

function usage() {
  console.error(`Usage:
  node scripts/sneaker-clean-trace.mjs <input.gpx> --out <output.gpx> [options]

Options:
  --step-m <meters>       Resample step distance. Defaults to 18.
  --smooth-window <odd>   Moving-average window on resampled points. Defaults to 5.
  --passes <n>            Smoothing passes. Defaults to 0.`);
}

function parseArgs(argv) {
  const args = {
    out: null,
    stepMeters: 18,
    smoothWindow: 5,
    passes: 0,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--step-m") args.stepMeters = Number(argv[++i]);
    else if (arg === "--smooth-window") args.smoothWindow = Number(argv[++i]);
    else if (arg === "--passes") args.passes = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      pos.push(arg);
    }
  }
  if (pos.length !== 1 || !args.out) {
    usage();
    process.exit(2);
  }
  if (!Number.isFinite(args.stepMeters) || args.stepMeters < 5) {
    throw new Error("--step-m must be at least 5.");
  }
  if (
    !Number.isFinite(args.smoothWindow) ||
    args.smoothWindow < 1 ||
    Math.floor(args.smoothWindow) % 2 !== 1
  ) {
    throw new Error("--smooth-window must be an odd positive integer.");
  }
  if (!Number.isFinite(args.passes) || args.passes < 0) {
    throw new Error("--passes must be non-negative.");
  }
  return {
    input: pos[0],
    out: args.out,
    stepMeters: args.stepMeters,
    smoothWindow: Math.floor(args.smoothWindow),
    passes: Math.floor(args.passes),
  };
}

const EARTH_RADIUS_M = 6_371_000;

function toLocalProject(points) {
  const meanLat =
    points.reduce((sum, [lat]) => sum + lat, 0) / Math.max(1, points.length);
  const refLat = (meanLat * Math.PI) / 180;
  return {
    toXY: ([lat, lng]) => ({
      x: EARTH_RADIUS_M * ((lng * Math.PI) / 180) * Math.cos(refLat),
      y: EARTH_RADIUS_M * ((lat * Math.PI) / 180),
    }),
    toLatLng: ({ x, y }) => [
      (y / EARTH_RADIUS_M) * (180 / Math.PI),
      (x / (EARTH_RADIUS_M * Math.cos(refLat))) * (180 / Math.PI),
    ],
  };
}

function interpolate(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function resample(points, stepMeters) {
  if (points.length < 2) return points.slice();
  const project = toLocalProject(points);
  const xy = points.map(project.toXY);
  const out = [xy[0]];
  let carry = 0;
  for (let i = 1; i < xy.length; i++) {
    let a = xy[i - 1];
    const b = xy[i];
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    while (carry + segLen >= stepMeters && segLen > 0) {
      const t = (stepMeters - carry) / segLen;
      const p = interpolate(a, b, t);
      out.push(p);
      a = p;
      segLen = Math.hypot(b.x - a.x, b.y - a.y);
      carry = 0;
    }
    carry += segLen;
  }
  out.push(xy[xy.length - 1]);
  return out.map(project.toLatLng);
}

function smooth(points, window) {
  if (window <= 1 || points.length <= window) return points.slice();
  const project = toLocalProject(points);
  const xy = points.map(project.toXY);
  const half = Math.floor(window / 2);
  const out = xy.map((p, i) => {
    if (i < half || i >= xy.length - half) return p;
    let x = 0;
    let y = 0;
    for (let j = i - half; j <= i + half; j++) {
      x += xy[j].x;
      y += xy[j].y;
    }
    return { x: x / window, y: y / window };
  });
  return out.map(project.toLatLng);
}

function writeGpx(points, name) {
  const pts = points
    .map(
      ([lat, lng]) =>
        `      <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso sneaker clean trace" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const inputAbs = path.resolve(root, args.input);
  const outAbs = path.resolve(root, args.out);
  const points = parseGpxTrackpoints(await fs.readFile(inputAbs, "utf8"));
  let cleaned = resample(points, args.stepMeters);
  for (let i = 0; i < args.passes; i++) {
    cleaned = smooth(cleaned, args.smoothWindow);
  }
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.writeFile(outAbs, writeGpx(cleaned, "cleaned-sneaker-trace"));
  console.log(
    JSON.stringify(
      {
        inputPoints: points.length,
        outputPoints: cleaned.length,
        inputDistanceMeters: pathDistanceMeters(points),
        outputDistanceMeters: pathDistanceMeters(cleaned),
        out: path.relative(root, outAbs),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
