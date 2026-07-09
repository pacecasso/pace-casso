/**
 * Private validation for lib/latticeCompiler.ts against the real Manhattan
 * lattice: compile a heart (LES), star (Chelsea), and circle (Midtown),
 * render input vs compiled chain, print fidelity stats.
 *
 * Run: npx tsx scripts/validate-lattice-compiler.ts
 * Output: tmp-lattice-validate/<shape>.png
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import latticeData from "../lib/data/manhattan-lattice.json";
import {
  buildLatticeGraph,
  compileContourToLattice,
  type LatLng,
  type LatticeData,
} from "../lib/latticeCompiler";

const OUT = path.join(process.cwd(), "tmp-lattice-validate");

const graph = buildLatticeGraph(latticeData as unknown as LatticeData);

/** normalized (x right, y up, roughly [-1,1]) -> lat/lng around a center */
function place(
  pts: [number, number][],
  center: LatLng,
  spanMeters: number,
): LatLng[] {
  const mLat = 111320;
  const mLng = mLat * Math.cos((center[0] * Math.PI) / 180);
  return pts.map(([x, y]) => [
    center[0] + (y * spanMeters) / 2 / mLat,
    center[1] + (x * spanMeters) / 2 / mLng,
  ]);
}

function heart(n = 120): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const x = 16 * Math.sin(t) ** 3;
    const y =
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      Math.cos(4 * t);
    out.push([x / 17, y / 17]);
  }
  return out;
}

function star(points = 5): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= points * 2; i++) {
    const r = i % 2 === 0 ? 1 : 0.42;
    const a = Math.PI / 2 + (i * Math.PI) / points;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

function circle(n = 90): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  return out;
}

const CASES: {
  name: string;
  shape: [number, number][];
  center: LatLng;
  spanM: number;
}[] = [
  { name: "heart-les", shape: heart(), center: [40.7175, -73.9875], spanM: 950 },
  { name: "star-chelsea", shape: star(), center: [40.7455, -73.9985], spanM: 1500 },
  { name: "circle-midtown", shape: circle(), center: [40.7555, -73.985], spanM: 1100 },
  { name: "heart-les-big", shape: heart(), center: [40.7185, -73.986], spanM: 1400 },
];

function toSvgPath(
  pts: LatLng[],
  proj: (p: LatLng) => [number, number],
): string {
  return pts
    .map((p, i) => {
      const [x, y] = proj(p);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  for (const c of CASES) {
  const placed = place(c.shape, c.center, c.spanM);
  const t0 = Date.now();
  const result = compileContourToLattice(placed, graph);
  const ms = Date.now() - t0;
  if (!result) {
    console.log(`${c.name}: FAILED to compile (${ms} ms)`);
    continue;
  }
  console.log(
    `${c.name}: ${result.km.toFixed(2)} km (input ${result.inputKm.toFixed(2)}), ` +
      `meanDev ${result.meanDeviationMeters.toFixed(1)} m, maxDev ${result.maxDeviationMeters.toFixed(0)} m, ` +
      `legs ${result.legCount}, skipped ${result.skippedPins}, junctions ${result.junctions.length}, ${ms} ms`,
  );

  // render: input (blue dashed) vs chain (red) + lattice context
  const all = [...placed, ...result.chain];
  const lats = all.map((p) => p[0]);
  const lngs = all.map((p) => p[1]);
  const pad = 0.0012;
  const minLat = Math.min(...lats) - pad;
  const maxLat = Math.max(...lats) + pad;
  const minLng = Math.min(...lngs) - pad;
  const maxLng = Math.max(...lngs) + pad;
  const W = 900;
  const mLng = Math.cos((c.center[0] * Math.PI) / 180);
  const H = Math.round(
    (W * (maxLat - minLat)) / ((maxLng - minLng) * mLng),
  );
  const proj = (p: LatLng): [number, number] => [
    ((p[1] - minLng) / (maxLng - minLng)) * W,
    ((maxLat - p[0]) / (maxLat - minLat)) * H,
  ];

  let latticeSvg = "";
  const data = latticeData as unknown as LatticeData;
  for (const [a, b, , via] of data.edges) {
    const pa = data.nodes[a];
    const pb = data.nodes[b];
    if (
      (pa[0] < minLat || pa[0] > maxLat || pa[1] < minLng || pa[1] > maxLng) &&
      (pb[0] < minLat || pb[0] > maxLat || pb[1] < minLng || pb[1] > maxLng)
    ) {
      continue;
    }
    const pts = [pa, ...via, pb];
    latticeSvg += `<path d="${toSvgPath(pts, proj)}" stroke="#d8d3ca" stroke-width="1.5" fill="none"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#f7f4ee"/>
    ${latticeSvg}
    <path d="${toSvgPath(placed, proj)}" stroke="#1d6fd8" stroke-width="2.5" stroke-dasharray="7,5" fill="none" opacity="0.8"/>
    <path d="${toSvgPath(result.chain, proj)}" stroke="#dc2626" stroke-width="3.5" fill="none" stroke-linejoin="round"/>
  </svg>`;
  const file = path.join(OUT, `${c.name}.png`);
  await sharp(Buffer.from(svg)).png().toFile(file);
  console.log(`  -> ${file}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
