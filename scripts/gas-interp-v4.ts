/**
 * GAS logo interpretation v4 — "artist sketch" pipeline proof.
 *
 * The thesis (from studying lion.webp / TIGER.webp / HEART.webp):
 *   1. Reference GPS art is HUGE (whole neighborhoods), so block-size
 *      stairsteps read as organic curves at squint distance.
 *   2. Identity features are never dropped — they are exaggerated.
 *      For gas.png that means: the curly hose, the round head, the
 *      headphone band, the nozzle-at-ear pose.
 *   3. Composition bends to the medium: boxy parts on coarse avenue
 *      columns, curvy parts where resolution allows; pen-lifts hidden
 *      by retracing own ink.
 *
 * This script authors the one-line interpretive sketch as smooth vector
 * geometry in grid-aligned meters, places it on the real Midtown grid,
 * compiles it with the PRODUCTION lattice compiler, and renders a
 * comparison sheet (logo | sketch | compiled | map) for squint review.
 *
 * Run: npx tsx scripts/gas-interp-v4.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  buildLatticeGraph,
  compileContourToLattice,
  type LatLng,
  type LatticeData,
} from "../lib/latticeCompiler";
// Real 10th Ave & 17th St junction (resolved once via scripts/gas-spike-lattice.mjs)
const ORIGIN_10TH_17TH: [number, number] = [40.744061, -74.006811];

const OUT = path.join(process.cwd(), "tmp-gas-interp-v4");

// ---------------------------------------------------------------------------
// Grid frame: x east along streets (bearing 119°), y north along avenues (29°)
// ---------------------------------------------------------------------------
const STREET_BEARING = 119;
const AVENUE_BEARING = 29;
const M_PER_LAT = 111320;

function unit(deg: number): { e: number; n: number } {
  const r = (deg * Math.PI) / 180;
  return { e: Math.sin(r), n: Math.cos(r) };
}
const X_AXIS = unit(STREET_BEARING);
const Y_AXIS = unit(AVENUE_BEARING);

const origin: LatLng = ORIGIN_10TH_17TH;

function toLatLng([x, y]: [number, number]): LatLng {
  const e = x * X_AXIS.e + y * Y_AXIS.e;
  const n = x * X_AXIS.n + y * Y_AXIS.n;
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng];
}

function toLocal([lat, lng]: LatLng): [number, number] {
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng;
  // invert the 2x2 [Xe Ye; Xn Yn]
  const det = X_AXIS.e * Y_AXIS.n - Y_AXIS.e * X_AXIS.n;
  const x = (e * Y_AXIS.n - Y_AXIS.e * n) / det;
  const y = (X_AXIS.e * n - e * X_AXIS.n) / det;
  return [x, y];
}

// ---------------------------------------------------------------------------
// Sketch DSL: points in meters. x=0 at 10th Ave, y=0 at 17th St.
// REAL column x-positions (measured along 36th St): 11th=-272 10th=0 9th=272
// 8th=548 7th=821 6th=1097 5th=1406 Mad=1560 Park=1707 Lex=1870 3rd=2026
// 2nd=2242 1st=2471.  Rows: y = 80 * (street - 17)  (measured 79.8 m/row)
// ---------------------------------------------------------------------------
type Pt = [number, number];

function arc(
  cx: number, cy: number, rx: number, ry: number,
  startDeg: number, endDeg: number, steps = 24,
): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((startDeg + ((endDeg - startDeg) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

function bezier(p0: Pt, p1: Pt, p2: Pt, steps = 20): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  return out;
}

const row = (street: number) => (street - 17) * 80;

function buildSketch(): Pt[] {
  const pts: Pt[] = [];
  const add = (...p: Pt[]) => pts.push(...p);
  const addArc = (...a: Parameters<typeof arc>) => pts.push(...arc(...a));
  const addBez = (...b: Parameters<typeof bezier>) => pts.push(...bezier(...b));

  // --- PUMP (10th Ave -> 6th Ave, 21st -> 51st St), rounded top corners.
  //     Route STARTS at the hose boss and draws down-and-around, so the
  //     outline (including the bottom-right corner) closes completely and
  //     the pen returns to the boss with zero visible connector. ---
  add([1097, row(33)]);           // start: hose boss (6th & 33rd)
  add([1097, row(21)]);           // pump right side below the boss — closes the corner
  add([0, row(21)]);              // bottom edge west along 21st
  add([0, row(49)]);              // up 10th Ave
  add([272, row(51)]);            // rounded top-left (chamfer to 9th & 51st)
  add([821, row(51)]);            // top edge along 51st to 7th
  add([1097, row(49)]);           // rounded top-right (6th & 49th)
  add([1097, row(48)]);           // down 6th Ave to window spur row
  // window (big, upper-left like the logo): spur west along 48th, loop, retrace.
  // Bottom edge sits at 43rd — 41st would cross the dead Port Authority
  // corner at 8th & 41st and jog.
  add([821, row(48)]);            // spur to window top-right (7th & 48th)
  add([272, row(48)]);            // window top edge (9th & 48th)
  add([272, row(44)]);            // window left side down 9th
  add([821, row(44)]);            // window bottom edge (7th & 44th, above Times Sq bowtie)
  add([821, row(48)]);            // window right side up (loop closed)
  add([1097, row(48)]);           // retrace spur back to pump right side
  add([1097, row(33)]);           // down 6th Ave back to the boss — pump complete

  // --- HOSE: full clockwise coil entered and exited at the top with
  //     flowing tangents (enter heading east, exit heading east-up).
  //     Boss at 33rd, loop top at 33.5, exit climbing steeply — each of
  //     the three strands owns its own street row, no parallel clutter.
  //     Loop bottom pins to 26th (Madison Sq Park north sidewalk); the
  //     rise hugs Lex because Grand Central blocks the Mad-Park interior.
  addBez([1097, row(33)], [1250, 1300], [1354, 1295], 10);
  addArc(1406, 1000, 300, 300, 100, -260, 40);
  addBez([1458, 1295], [1600, 1650], [1870, row(39)], 16);
  add([1870, 2260]);              // rise up Lex from the shoulder to the ear

  // --- HEADPHONES + HEAD (center 2170,2260; W ear on Lex, E ear on 1st).
  //     No cup ticks: on this grid they collapse invisibly into the head
  //     sides — the band alone reads as headphones, and the hose ending
  //     at the ear implies the nozzle. Jaw stays north of the Tudor City
  //     viaduct geometry at 1st Ave & 42nd. ---
  addBez([1870, 2260], [1890, 2740], [2170, 2760], 14);  // band left half
  addBez([2170, 2760], [2450, 2740], [2471, 2260], 14);  // band right half
  addArc(2170, 2260, 301, 280, 0, -180, 18);   // jaw: E -> S -> W under the band
  addArc(2170, 2260, 301, 280, -180, -90, 9);  // retrace jaw half back to S (hidden)

  // --- BODY: stocky. Torso Lex -> 1st; legs one block wide with a real
  //     two-column notch between them (Lex/3rd left leg, 2nd/1st right) ---
  add([2170, row(39)]);           // short neck from jaw bottom to shoulder row
  add([1870, row(39)]);           // left shoulder (Lex & 39th — 40th & 1st corner pins into the Tudor City ramp)
  add([1870, row(21)]);           // left torso side + outer left leg down Lex
  add([2026, row(21)]);           // along 21st under the left leg
  add([2026, row(33)]);           // up 3rd Ave: inner left leg to the crotch
  add([2242, row(33)]);           // crotch across 33rd to 2nd Ave
  add([2242, row(21)]);           // down 2nd Ave: inner right leg
  add([2471, row(21)]);           // along 21st under the right leg
  add([2471, row(39)]);           // outer right leg + torso side up 1st Ave
  add([2170, row(39)]);           // close shoulders back at the neck

  return pts;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
function localSvg(paths: { pts: Pt[]; color: string; width: number }[], w = 900): {
  svg: string; width: number; height: number;
} {
  const all = paths.flatMap((p) => p.pts);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs) - 150;
  const maxX = Math.max(...xs) + 150;
  const minY = Math.min(...ys) - 150;
  const maxY = Math.max(...ys) + 150;
  const scale = w / (maxX - minX);
  const h = Math.round((maxY - minY) * scale);
  const px = ([x, y]: Pt) =>
    `${((x - minX) * scale).toFixed(1)} ${((maxY - y) * scale).toFixed(1)}`;
  const body = paths
    .map(
      (p) =>
        `<path d="${p.pts.map((q, i) => `${i === 0 ? "M" : "L"} ${px(q)}`).join(" ")}" ` +
        `fill="none" stroke="${p.color}" stroke-width="${p.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("\n");
  return {
    svg: `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="white"/>${body}</svg>`,
    width: w,
    height: h,
  };
}

const TILE = 256;
function lonToX(lon: number, z: number) { return ((lon + 180) / 360) * TILE * 2 ** z; }
function latToY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
}

async function renderMap(chain: LatLng[], file: string, w = 1400, h = 1100) {
  let zoom = 13;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z));
    const ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.8 && Math.max(...ys) - Math.min(...ys) <= h * 0.8) {
      zoom = z;
      break;
    }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom));
  const ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2;
  const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: sharp.OverlayOptions[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
        headers: { "User-Agent": "pace-casso route preview (dev)" },
      });
      if (!res.ok) continue;
      tiles.push({
        input: Buffer.from(await res.arrayBuffer()),
        left: Math.round(tx * TILE - vx),
        top: Math.round(ty * TILE - vy),
      });
    }
  }
  const d = chain
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`)
    .join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${d}" fill="none" stroke="#7f1024" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>` +
      `<path d="${d}" fill="none" stroke="#e8253f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`,
  );
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eee" } })
    .composite([...tiles, { input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(file);
}

async function main() {
await fs.mkdir(OUT, { recursive: true });
console.log("origin (10th & 17th):", origin);

const sketch = buildSketch();
let sketchKm = 0;
for (let i = 1; i < sketch.length; i++) {
  sketchKm += Math.hypot(sketch[i][0] - sketch[i - 1][0], sketch[i][1] - sketch[i - 1][1]) / 1000;
}

// 1. sketch-only render
const sk = localSvg([{ pts: sketch, color: "#111", width: 7 }]);
await sharp(Buffer.from(sk.svg)).png().toFile(path.join(OUT, "1-sketch.png"));

// 2. compile with the production lattice compiler
const latticeData = JSON.parse(
  await fs.readFile(path.join(process.cwd(), "lib", "data", "manhattan-lattice.json"), "utf8"),
) as LatticeData;
const graph = buildLatticeGraph(latticeData);
const placed = sketch.map(toLatLng);
const result = compileContourToLattice(placed, graph, {
  sampleMeters: 38,
  pinRadiusMeters: 150,
});
if (!result) throw new Error("compile returned null");
console.log({
  km: result.km.toFixed(1),
  inputKm: result.inputKm.toFixed(1),
  meanDev: result.meanDeviationMeters.toFixed(1),
  maxDev: result.maxDeviationMeters.toFixed(1),
  legs: result.legCount,
  skippedPins: result.skippedPins,
  junctions: result.junctions.length,
});

// 3. compiled silhouette (local frame, sketch ghost underneath)
const compiledLocal = result.chain.map(toLocal);
const cs = localSvg([
  { pts: sketch, color: "#f2b8c0", width: 4 },
  { pts: compiledLocal, color: "#111", width: 6 },
]);
await sharp(Buffer.from(cs.svg)).png().toFile(path.join(OUT, "2-compiled.png"));

// 4. map render
await renderMap(result.chain, path.join(OUT, "3-map.png"));

// 5. comparison sheet: logo | sketch | compiled | map
async function fit(file: string, w: number, h: number): Promise<Buffer> {
  return sharp(file).resize(w, h, { fit: "contain", background: "#fff" }).png().toBuffer();
}
const cell = 620;
const sheet = sharp({
  create: { width: cell * 4 + 50, height: cell + 70, channels: 4, background: "#fff" },
});
const label = (t: string, x: number) =>
  Buffer.from(
    `<svg width="${cell}" height="40"><text x="10" y="28" font-family="Arial" font-size="24" font-weight="700" fill="#111">${t}</text></svg>`,
  );
await sheet
  .composite([
    { input: await fit(path.join(process.cwd(), "gas.png"), cell, cell), left: 10, top: 60 },
    { input: await fit(path.join(OUT, "1-sketch.png"), cell, cell), left: cell + 20, top: 60 },
    { input: await fit(path.join(OUT, "2-compiled.png"), cell, cell), left: cell * 2 + 30, top: 60 },
    { input: await fit(path.join(OUT, "3-map.png"), cell, cell), left: cell * 3 + 40, top: 60 },
    { input: label("1. logo", 0), left: 10, top: 10 },
    { input: label("2. interpretive sketch", 0), left: cell + 20, top: 10 },
    { input: label("3. compiled to streets", 0), left: cell * 2 + 30, top: 10 },
    { input: label("4. on the map", 0), left: cell * 3 + 40, top: 10 },
  ])
  .png()
  .toFile(path.join(OUT, "SHEET.png"));

// 6. GPX + meta for later verification
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>GAS interpretation v4</name><trkseg>
${result.chain.map(([la, ln]) => `    <trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
await fs.writeFile(path.join(OUT, "GAS-V4.gpx"), gpx, "utf8");
await fs.writeFile(
  path.join(OUT, "meta.json"),
  JSON.stringify(
    {
      sketchKm: Number(sketchKm.toFixed(2)),
      routeKm: Number(result.km.toFixed(2)),
      meanDeviationMeters: Number(result.meanDeviationMeters.toFixed(1)),
      maxDeviationMeters: Number(result.maxDeviationMeters.toFixed(1)),
      legCount: result.legCount,
      skippedPins: result.skippedPins,
      junctionCount: result.junctions.length,
      origin,
    },
    null,
    2,
  ),
  "utf8",
);
console.log("wrote", path.join(OUT, "SHEET.png"));
}

main().catch((e) => { console.error(e); process.exit(1); });
