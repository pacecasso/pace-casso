/**
 * WORDMARK generator — the blind-judge said the ONLY reference that reads
 * cold is LOVE (8/10, a clean single-stroke wordmark); every shape/figure
 * we make scores 2-5. So: big, clean, well-separated single-stroke letters,
 * strokes pinned to real avenue columns, nothing else.
 *
 * Run:    npx tsx scripts/wordmark-designs.ts "NYC" [rowBottom]
 * Judge:  node scripts/blind-squint-test.mjs tmp-wordmark/<word>/3-map.png
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

const ORIGIN_10TH_17TH: [number, number] = [40.744061, -74.006811];
const STREET_BEARING = 119;
const AVENUE_BEARING = 29;
const M_PER_LAT = 111320;
function unit(deg: number) { const r = (deg * Math.PI) / 180; return { e: Math.sin(r), n: Math.cos(r) }; }
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
  const det = X_AXIS.e * Y_AXIS.n - Y_AXIS.e * X_AXIS.n;
  return [(e * Y_AXIS.n - Y_AXIS.e * n) / det, (X_AXIS.e * n - e * X_AXIS.n) / det];
}

type Pt = [number, number];
const row = (s: number) => (s - 17) * 80;
// Real avenue x-positions (meters east of 10th Ave, measured along 36th).
const AVE: Record<string, number> = {
  "10": 0, "9": 272, "8": 548, "7": 821, "6": 1097, "5": 1406,
  MAD: 1560, PARK: 1707, LEX: 1870, "3": 2026, "2": 2242, "1": 2471,
};

/**
 * Each letter is drawn from three avenue columns (cL,cM,cR) and three
 * street rows (rB,rM,rT). Every vertex lands on a real avenue×street
 * junction, so pinning is exact and strokes never wobble. Letters enter
 * and exit at the baseline so a shared baseline row links them (reads as
 * an underline, like the LOVE reference's letters sitting on a line).
 */
type Cols = { cL: number; cM: number; cR: number };
type Rows = { rB: number; rM: number; rT: number };
type Glyph = (c: Cols, r: Rows) => Pt[];

const GLYPHS: Record<string, Glyph> = {
  N: ({ cL, cR }, { rB, rT }) => [[cL, rB], [cL, rT], [cR, rB], [cR, rT], [cR, rB]],
  Y: ({ cL, cM, cR }, { rB, rM, rT }) => [[cM, rB], [cM, rM], [cL, rT], [cM, rM], [cR, rT], [cM, rM], [cM, rB]],
  C: ({ cL, cR }, { rB, rT }) => [[cR, rB], [cL, rB], [cL, rT], [cR, rT]], // open on the right
  L: ({ cL, cR }, { rB, rT }) => [[cL, rB], [cL, rT], [cL, rB], [cR, rB]],
  O: ({ cL, cR }, { rB, rT }) => [[cL, rB], [cL, rT], [cR, rT], [cR, rB], [cL, rB]],
  V: ({ cL, cM, cR }, { rB, rT }) => [[cL, rB], [cL, rT], [cM, rB], [cR, rT], [cR, rB]],
  E: ({ cL, cM, cR }, { rB, rM, rT }) => [[cR, rB], [cL, rB], [cL, rT], [cR, rT], [cL, rT], [cL, rM], [cM, rM], [cL, rM], [cL, rB], [cR, rB]],
  R: ({ cL, cM, cR }, { rB, rM, rT }) => [[cL, rB], [cL, rT], [cR, rT], [cR, rM], [cL, rM], [cR, rB]],
  U: ({ cL, cR }, { rB, rT }) => [[cL, rT], [cL, rB], [cR, rB], [cR, rT], [cR, rB]],
  A: ({ cL, cM, cR }, { rB, rM, rT }) => [[cL, rB], [cM, rT], [cR, rB], [cR, rM], [cL, rM], [cL, rB]],
  S: ({ cL, cR }, { rB, rM, rT }) => [[cL, rB], [cR, rB], [cR, rM], [cL, rM], [cL, rT], [cR, rT]],
  T: ({ cL, cM, cR }, { rB, rT }) => [[cM, rB], [cM, rT], [cL, rT], [cR, rT], [cM, rT], [cM, rB]],
  P: ({ cL, cR }, { rB, rM, rT }) => [[cL, rB], [cL, rT], [cR, rT], [cR, rM], [cL, rM]],
  G: ({ cL, cM, cR }, { rB, rM, rT }) => [[cR, rT], [cL, rT], [cL, rB], [cR, rB], [cR, rM], [cM, rM]],
  D: ({ cL, cR }, { rB, rT }) => [[cL, rB], [cL, rT], [cR, rT], [cR, rB], [cL, rB]],
  I: ({ cM }, { rB, rT }) => [[cM, rB], [cM, rT]],
};

/**
 * Column triples per letter slot — chosen so each letter's three strokes
 * sit on real, well-separated avenues. Twelve avenues across the island
 * give room for ~4 wide letters. Rows come from the clean "wordmark shelf"
 * (default 50-58: above the GCT/PA/Bryant traps, Park medians end at 49 so
 * E/C bars can cross the east avenues full width).
 */
const SLOTS3: Cols[] = [
  { cL: AVE["10"], cM: AVE["9"], cR: AVE["8"] }, // width 548
  { cL: AVE["7"], cM: AVE["6"], cR: AVE["5"] },  // width 585
  { cL: AVE.MAD, cM: AVE.LEX, cR: AVE["2"] },    // width 682 (skip Park/3rd to stay wide)
];
const SLOTS4: Cols[] = [
  { cL: AVE["10"], cM: AVE["9"], cR: AVE["8"] },
  { cL: AVE["7"], cM: AVE["6"], cR: AVE["5"] },
  { cL: AVE.MAD, cM: AVE.PARK, cR: AVE.LEX },  // keep the E slot wide ([3,2,1]) — the winning trade
  { cL: AVE["3"], cM: AVE["2"], cR: AVE["1"] },
];
const slotsFor = (n: number) => (n <= 3 ? SLOTS3 : SLOTS4);

// Force diagonals to staircase: a long straight diagonal with only two
// endpoints lets the street router shortcut into an L. Interpolating points
// every ~110 m makes each land on a junction, so the compile is a clean
// staircase that reads as a diagonal.
function densifyDiagonals(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    if (i === pts.length - 1) break;
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dx > 90 && dy > 90) {
      const steps = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / 110));
      for (let s = 1; s < steps; s++) out.push([x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps]);
    }
  }
  return out;
}

function wordSketch(word: string, rowBottom: number, rowsTall = 14): Pt[] {
  const letters = word.toUpperCase().split("").filter((ch) => GLYPHS[ch]);
  const slots = slotsFor(letters.length);
  if (letters.length > slots.length) throw new Error(`word too long (max ${slots.length})`);
  const rows: Rows = { rB: row(rowBottom), rM: row(rowBottom + rowsTall / 2), rT: row(rowBottom + rowsTall) };
  const pts: Pt[] = [];
  letters.forEach((ch, i) => {
    const g = GLYPHS[ch](slots[i], rows);
    if (i > 0) {
      // baseline connector from previous exit to this glyph's entry:
      // run east along the baseline, then the glyph takes over.
      const prev = pts[pts.length - 1];
      pts.push([prev[0], rows.rB], [g[0][0], rows.rB]);
    }
    pts.push(...g);
  });
  return densifyDiagonals(pts);
}

// ---------------------------------------------------------------------------
// Rendering (shared with interp-designs.ts)
// ---------------------------------------------------------------------------
function localSvg(paths: { pts: Pt[]; color: string; width: number }[], w = 1000) {
  const all = paths.flatMap((p) => p.pts);
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const minX = Math.min(...xs) - 150, maxX = Math.max(...xs) + 150;
  const minY = Math.min(...ys) - 150, maxY = Math.max(...ys) + 150;
  const scale = w / (maxX - minX);
  const h = Math.round((maxY - minY) * scale);
  const px = ([x, y]: Pt) => `${((x - minX) * scale).toFixed(1)} ${((maxY - y) * scale).toFixed(1)}`;
  const body = paths.map((p) =>
    `<path d="${p.pts.map((q, i) => `${i === 0 ? "M" : "L"} ${px(q)}`).join(" ")}" fill="none" stroke="${p.color}" stroke-width="${p.width}" stroke-linecap="round" stroke-linejoin="round"/>`).join("\n");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="white"/>${body}</svg>`;
}

const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
async function renderMap(chain: LatLng[], file: string, w = 1400, h = 1100) {
  let zoom = 13;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z)), ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.82 && Math.max(...ys) - Math.min(...ys) <= h * 0.82) { zoom = z; break; }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom)), ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2;
  const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: sharp.OverlayOptions[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, { headers: { "User-Agent": "pace-casso route preview (dev)" } });
      if (!res.ok) continue;
      tiles.push({ input: Buffer.from(await res.arrayBuffer()), left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
    }
  }
  const d = chain.map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="${d}" fill="none" stroke="#7f1024" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>` +
    `<path d="${d}" fill="none" stroke="#e8253f" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eee" } })
    .composite([...tiles, { input: overlay, left: 0, top: 0 }]).png().toFile(file);
}

async function main() {
  const word = (process.argv[2] ?? "NYC").toUpperCase();
  const rowBottom = Number(process.argv[3] ?? 44);
  const rowsTall = Number(process.argv[4] ?? 14);
  const OUT = path.join(process.cwd(), "tmp-wordmark", word);
  await fs.mkdir(OUT, { recursive: true });

  const sketch = wordSketch(word, rowBottom, rowsTall);
  await sharp(Buffer.from(localSvg([{ pts: sketch, color: "#111", width: 8 }]))).png().toFile(path.join(OUT, "1-sketch.png"));

  const latticeData = JSON.parse(await fs.readFile(path.join(process.cwd(), "lib", "data", "manhattan-lattice.json"), "utf8")) as LatticeData;
  const graph = buildLatticeGraph(latticeData);
  const placed = sketch.map(toLatLng);
  const result = compileContourToLattice(placed, graph, { sampleMeters: 38, pinRadiusMeters: 150 });
  if (!result) throw new Error("compile returned null");
  console.log(word, { km: +result.km.toFixed(1), meanDev: +result.meanDeviationMeters.toFixed(1), maxDev: +result.maxDeviationMeters.toFixed(1), legs: result.legCount, skipped: result.skippedPins });

  const compiledLocal = result.chain.map(toLocal);
  await sharp(Buffer.from(localSvg([{ pts: sketch, color: "#f2b8c0", width: 5 }, { pts: compiledLocal, color: "#111", width: 7 }]))).png().toFile(path.join(OUT, "2-compiled.png"));
  await renderMap(result.chain, path.join(OUT, "3-map.png"));

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${word}</name><trkseg>
${result.chain.map(([la, ln]) => `    <trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  await fs.writeFile(path.join(OUT, `${word}.gpx`), gpx, "utf8");
  console.log("  -> judge:  node scripts/blind-squint-test.mjs " + path.join("tmp-wordmark", word, "3-map.png").replace(/\\/g, "/"));
}
main().catch((e) => { console.error(e); process.exit(1); });
