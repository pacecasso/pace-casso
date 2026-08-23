/**
 * Downtown wordmark generator — letters on the FINE LES/Chinatown grid
 * (streets ~70-95 m apart, vs midtown's 272 m avenues) where the reference
 * LOVE (the only route the blind judge scores 8) was actually drawn.
 * Fine grid => compact letters, smooth diagonals, tight word that groups.
 *
 * Run:   npx tsx scripts/wordmark-downtown.ts "LOVE"
 * Judge: node scripts/blind-squint-test.mjs tmp-wordmark/dt-LOVE/3-map.png
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildLatticeGraph, compileContourToLattice, type LatLng, type LatticeData } from "../lib/latticeCompiler";

type Pt = [number, number]; // [colIndex, rowIndex] in downtown-grid space
type LLFn = (col: number, rowIdx: number) => LatLng;

async function loadGrid(): Promise<LLFn> {
  const gridRaw = JSON.parse(await fs.readFile(path.join(process.cwd(), "tmp-wordmark", "downtown-grid.json"), "utf8")) as {
    COLS: string[]; ROWS: string[]; grid: Record<string, [number, number]>;
  };
  const NC = gridRaw.COLS.length, NR = gridRaw.ROWS.length;
  // Complete the grid: fill missing corners by iterative neighbor-averaging.
  const cell: (LatLng | null)[][] = [];
  for (let c = 0; c < NC; c++) { cell[c] = []; for (let r = 0; r < NR; r++) cell[c][r] = gridRaw.grid[`${gridRaw.COLS[c]}|${gridRaw.ROWS[r]}`] ?? null; }
  for (let pass = 0; pass < 12; pass++) {
    for (let c = 0; c < NC; c++) for (let r = 0; r < NR; r++) {
      if (cell[c][r]) continue;
      const nb: LatLng[] = [];
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const cc = c + dc, rr = r + dr;
        if (cc >= 0 && cc < NC && rr >= 0 && rr < NR && cell[cc][rr]) nb.push(cell[cc][rr]!);
      }
      if (nb.length >= 2) cell[c][r] = [nb.reduce((s, p) => s + p[0], 0) / nb.length, nb.reduce((s, p) => s + p[1], 0) / nb.length];
    }
  }
  return (col, rowIdx) => {
    const c0 = Math.max(0, Math.min(NC - 2, Math.floor(col))), r0 = Math.max(0, Math.min(NR - 2, Math.floor(rowIdx)));
    const fc = col - c0, fr = rowIdx - r0;
    const p00 = cell[c0][r0]!, p10 = cell[c0 + 1][r0]!, p01 = cell[c0][r0 + 1]!, p11 = cell[c0 + 1][r0 + 1]!;
    const lat = p00[0] * (1 - fc) * (1 - fr) + p10[0] * fc * (1 - fr) + p01[0] * (1 - fc) * fr + p11[0] * fc * fr;
    const lng = p00[1] * (1 - fc) * (1 - fr) + p10[1] * fc * (1 - fr) + p01[1] * (1 - fc) * fr + p11[1] * fc * fr;
    return [lat, lng];
  };
}

// Glyphs in (col, row) space. cL<cM<cR are column indices; rT<rM<rB are row
// indices (rT = north/top = smaller index). Enter/exit at the baseline.
type C = { cL: number; cM: number; cR: number };
type R = { rB: number; rM: number; rT: number };
const G: Record<string, (c: C, r: R) => Pt[]> = {
  L: ({ cL, cR }, { rB, rT }) => [[cL, rB], [cL, rT], [cL, rB], [cR, rB]],
  O: ({ cL, cR }, { rB, rT }) => [[cL, rB], [cL, rT], [cR, rT], [cR, rB], [cL, rB]],
  V: ({ cL, cM, cR }, { rB, rT }) => [[cL, rT], [cM, rB], [cR, rT]], // pure wedge, no side stems (reads V not N)
  E: ({ cL, cM, cR }, { rB, rM, rT }) => [[cR, rB], [cL, rB], [cL, rT], [cR, rT], [cL, rT], [cL, rM], [cM, rM], [cL, rM], [cL, rB], [cR, rB]],
  N: ({ cL, cR }, { rB, rT }) => [[cL, rB], [cL, rT], [cR, rB], [cR, rT], [cR, rB]],
  U: ({ cL, cR }, { rB, rT }) => [[cL, rT], [cL, rB], [cR, rB], [cR, rT], [cR, rB]],
  R: ({ cL, cM, cR }, { rB, rM, rT }) => [[cL, rB], [cL, rT], [cR, rT], [cR, rM], [cL, rM], [cR, rB]],
  C: ({ cL, cR }, { rB, rT }) => [[cR, rB], [cL, rB], [cL, rT], [cR, rT]],
  Y: ({ cL, cM, cR }, { rB, rM, rT }) => [[cM, rB], [cM, rM], [cL, rT], [cM, rM], [cR, rT], [cM, rM], [cM, rB]],
  I: ({ cM }, { rB, rT }) => [[cM, rB], [cM, rT]],
  T: ({ cL, cM, cR }, { rB, rT }) => [[cM, rB], [cM, rT], [cL, rT], [cR, rT], [cM, rT], [cM, rB]],
  A: ({ cL, cM, cR }, { rB, rM, rT }) => [[cL, rB], [cM, rT], [cR, rB], [cR, rM], [cL, rM], [cL, rB]],
  P: ({ cL, cR }, { rB, rM, rT }) => [[cL, rB], [cL, rT], [cR, rT], [cR, rM], [cL, rM]],
  D: ({ cL, cR }, { rB, rT }) => [[cL, rB], [cL, rT], [cR, rT], [cR, rB], [cL, rB]],
  H: ({ cL, cR }, { rB, rM, rT }) => [[cL, rT], [cL, rB], [cL, rM], [cR, rM], [cR, rT], [cR, rB]],
};

const meters = ([la1, lo1]: LatLng, [la2, lo2]: LatLng) => Math.hypot((la2 - la1) * 111320, (lo2 - lo1) * 111320 * Math.cos((la1 * Math.PI) / 180));
// densify diagonals so the compiler staircases them on the fine grid
function densify(pts: LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    if (i === pts.length - 1) break;
    const a = pts[i], b = pts[i + 1];
    if (meters(a, b) > 120 && Math.abs(a[0] - b[0]) > 0.0004 && Math.abs(a[1] - b[1]) > 0.0004) {
      const steps = Math.max(2, Math.round(meters(a, b) / 70));
      for (let s = 1; s < steps; s++) out.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
    }
  }
  return out;
}

function wordSketch(word: string, letterCols: number, gapCols: number, rT: number, rB: number, ll: LLFn): LatLng[] {
  const letters = word.toUpperCase().split("").filter((ch) => G[ch]);
  const rows: R = { rB, rM: (rB + rT) / 2, rT };
  const pts: Pt[] = [];
  let x = 0;
  letters.forEach((ch, i) => {
    const cols: C = { cL: x, cM: x + letterCols / 2, cR: x + letterCols };
    const g = G[ch](cols, rows);
    if (i > 0) { const prev = pts[pts.length - 1]; pts.push([prev[0], rB], [g[0][0], rB]); }
    pts.push(...g);
    x += letterCols + gapCols;
  });
  return densify(pts.map(([c, r]) => ll(c, r)));
}

// ---- rendering ----
const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z; };
async function renderMap(chain: LatLng[], file: string, w = 1400, h = 1000) {
  let zoom = 15;
  for (let z = 17; z >= 12; z--) {
    const xs = chain.map((p) => lonToX(p[1], z)), ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.8 && Math.max(...ys) - Math.min(...ys) <= h * 0.8) { zoom = z; break; }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom)), ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: sharp.OverlayOptions[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++)
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, { headers: { "User-Agent": "pace-casso route preview (dev)" } });
      if (!res.ok) continue;
      tiles.push({ input: Buffer.from(await res.arrayBuffer()), left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
    }
  const d = chain.map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
  const overlay = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="#7f1024" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/><path d="${d}" fill="none" stroke="#e8253f" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eee" } }).composite([...tiles, { input: overlay, left: 0, top: 0 }]).png().toFile(file);
}

async function main() {
  const word = (process.argv[2] ?? "LOVE").toUpperCase();
  const letterCols = Number(process.argv[3] ?? 2.4);
  const gapCols = Number(process.argv[4] ?? 1);
  const rT = Number(process.argv[5] ?? 0);   // Houston (north/top)
  const rB = Number(process.argv[6] ?? 5);   // Grand (south/baseline)
  const OUT = path.join(process.cwd(), "tmp-wordmark", `dt-${word}`);
  await fs.mkdir(OUT, { recursive: true });

  const ll = await loadGrid();
  const chainLL = wordSketch(word, letterCols, gapCols, rT, rB, ll);
  const latticeData = JSON.parse(await fs.readFile(path.join(process.cwd(), "lib", "data", "manhattan-lattice.json"), "utf8")) as LatticeData;
  const graph = buildLatticeGraph(latticeData);
  const result = compileContourToLattice(chainLL, graph, { sampleMeters: 30, pinRadiusMeters: 90 });
  if (!result) throw new Error("compile null");
  console.log(`dt-${word}`, { km: +result.km.toFixed(1), meanDev: +result.meanDeviationMeters.toFixed(1), maxDev: +result.maxDeviationMeters.toFixed(1), legs: result.legCount, skipped: result.skippedPins });
  await renderMap(result.chain, path.join(OUT, "3-map.png"));
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${word}</name><trkseg>\n${result.chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>`;
  await fs.writeFile(path.join(OUT, `${word}.gpx`), gpx, "utf8");
  console.log("  -> node scripts/blind-squint-test.mjs " + path.join("tmp-wordmark", `dt-${word}`, "3-map.png").replace(/\\/g, "/"));
}
main().catch((e) => { console.error(e); process.exit(1); });
