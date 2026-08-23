import fs from "node:fs/promises";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseGpxTrackpoints, pathDistanceMeters } = jiti(
  "../lib/streetRouteProof.ts",
);

function parseArgs(argv) {
  const args = {
    out: null,
    radius: 4,
    ratio: 2.25,
    maxShiftMeters: 10,
    passes: 1,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--radius") args.radius = Number(argv[++i]);
    else if (arg === "--ratio") args.ratio = Number(argv[++i]);
    else if (arg === "--max-shift-m") args.maxShiftMeters = Number(argv[++i]);
    else if (arg === "--passes") args.passes = Number(argv[++i]);
    else pos.push(arg);
  }
  if (pos.length !== 1 || !args.out) {
    throw new Error(
      "Usage: node scripts/sneaker-axis-cleanup.mjs <input.gpx> --out <output.gpx>",
    );
  }
  return { ...args, input: pos[0] };
}

const EARTH_RADIUS_M = 6_371_000;

function projector(points) {
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

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function clampShift(current, target, maxShift) {
  const delta = target - current;
  if (Math.abs(delta) <= maxShift) return target;
  return current + Math.sign(delta) * maxShift;
}

function cleanup(points, options) {
  if (points.length < options.radius * 2 + 3) return points.slice();
  const project = projector(points);
  let xy = points.map(project.toXY);

  for (let pass = 0; pass < options.passes; pass++) {
    const next = xy.map((p) => ({ ...p }));
    for (let i = options.radius; i < xy.length - options.radius; i++) {
      const window = xy.slice(i - options.radius, i + options.radius + 1);
      const first = window[0];
      const last = window[window.length - 1];
      const dx = Math.abs(last.x - first.x);
      const dy = Math.abs(last.y - first.y);
      if (dx > dy * options.ratio) {
        next[i].y = clampShift(
          xy[i].y,
          median(window.map((p) => p.y)),
          options.maxShiftMeters,
        );
      } else if (dy > dx * options.ratio) {
        next[i].x = clampShift(
          xy[i].x,
          median(window.map((p) => p.x)),
          options.maxShiftMeters,
        );
      }
    }
    xy = next;
  }

  return xy.map(project.toLatLng);
}

function gpx(points) {
  const pts = points
    .map(
      ([lat, lng]) =>
        `      <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso sneaker axis cleanup" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>axis-cleaned-sneaker</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const input = path.resolve(root, args.input);
  const out = path.resolve(root, args.out);
  const points = parseGpxTrackpoints(await fs.readFile(input, "utf8"));
  const cleaned = cleanup(points, args);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, gpx(cleaned));
  console.log(
    JSON.stringify(
      {
        inputPoints: points.length,
        outputPoints: cleaned.length,
        inputDistanceMeters: pathDistanceMeters(points),
        outputDistanceMeters: pathDistanceMeters(cleaned),
        out: path.relative(root, out),
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
