/**
 * Interpretation benchmark designs — Nike swoosh, Apple mark, tiger.
 *
 * Same method as scripts/gas-interp-v4.ts (which produced the GAS winner):
 * author a one-line interpretive sketch as smooth vectors in grid-aligned
 * meters, compile with the PRODUCTION lattice compiler, render a sheet.
 *
 * Run: npx tsx scripts/interp-designs.ts <nike|apple|tiger|all>
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
  const det = X_AXIS.e * Y_AXIS.n - Y_AXIS.e * X_AXIS.n;
  return [(e * Y_AXIS.n - Y_AXIS.e * n) / det, (X_AXIS.e * n - e * X_AXIS.n) / det];
}

// Column x-positions (from 10th Ave, measured along 36th St):
// 11th=-272 10th=0 9th=272 8th=548 7th=821 6th=1097 5th=1406 Mad=1560
// Park=1707 Lex=1870 3rd=2026 2nd=2242 1st=2471. Rows: y=80*(street-17).
type Pt = [number, number];
const row = (street: number) => (street - 17) * 80;
const AVE_10 = 0, AVE_9 = 272, AVE_8 = 548, AVE_7 = 821, AVE_6 = 1097;
const AVE_5 = 1406, MAD = 1560, PARK = 1707, LEX = 1870, AVE_3 = 2026;
const AVE_2 = 2242, AVE_1 = 2471;

function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, steps = 24): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
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

class Pen {
  pts: Pt[] = [];
  add(...p: Pt[]) { this.pts.push(...p); return this; }
  arc(...a: Parameters<typeof arc>) { this.pts.push(...arc(...a)); return this; }
  bez(...b: Parameters<typeof bezier>) { this.pts.push(...bezier(...b)); return this; }
}

// ---------------------------------------------------------------------------
// NIKE SWOOSH — closed outline, full island width, rows 28-39.
// Curves bulge vertically (cheap 80 m rows); tail tip and point tip are
// out-and-back corners, which the compiler treats first-class.
// ---------------------------------------------------------------------------
function nikeSketch(): Pt[] {
  // True swoosh geometry, vertically exaggerated 1.35x so the mid-body is
  // ~3 street rows thick (thinner merges into a single line on compile).
  // Key x-landmarks pinned to real avenues: tail tip on 10th, inner corner
  // on 8th, low point at 7th & 23rd, tip at 1st & 39th (clear of Tudor City).
  // Rows 17-34: the tail must NOT sit on the Penn South superblocks
  // (8th-9th Ave, 23rd-29th) — the whole west side 23rd-42nd is a junction
  // desert (Penn South, Penn Station, Port Authority, Hudson Yards).
  const W = 2471;
  const y0 = row(17);
  const P = (fx: number, fy: number): Pt => [fx * W, y0 + fy * 1.6 * W];
  const p = new Pen();
  p.add(P(0, 0.2));                                       // tail tip (10th Ave)
  p.bez(P(0, 0.2), P(0.05, 0.09), P(0.18, 0.025), 12);    // tail underside dive
  p.bez(P(0.18, 0.025), P(0.32, 0.005), P(0.5, 0.025), 14); // bottom of the sweep
  p.bez(P(0.5, 0.025), P(0.68, 0.06), P(0.82, 0.14), 14);   // straightening rise
  p.bez(P(0.82, 0.14), P(0.92, 0.22), P(1.0, 0.35), 10);    // steep to the point
  p.bez(P(1.0, 0.35), P(0.8, 0.155), P(0.58, 0.095), 16);   // concave top edge
  p.bez(P(0.58, 0.095), P(0.4, 0.06), P(0.222, 0.085), 10); // to inner corner (8th)
  p.bez(P(0.222, 0.085), P(0.11, 0.12), P(0, 0.2), 10);     // tail top edge
  return p.pts;
}

// ---------------------------------------------------------------------------
// APPLE MARK — body 9th Ave -> 2nd Ave, rows 22-49; bite reaches in to the
// Lex line (rows 31-39, clear of Grand Central); leaf is a lens-shaped loop
// hung on the stem notch, tip near Lex & 53rd.
// ---------------------------------------------------------------------------
function appleSketch(): Pt[] {
  const p = new Pen();
  const notch: Pt = [1257, 2360];
  p.add(notch);
  p.bez(notch, [1080, 2570], [900, 2530], 12);        // top-left bump
  p.bez([900, 2530], [420, 2350], [272, 1800], 16);   // left shoulder
  p.bez([272, 1800], [250, 1400], [400, 1000], 14);   // left side bulge (9th Ave)
  p.bez([400, 1000], [500, 480], [1100, 420], 16);    // bottom-left arc
  p.bez([1100, 420], [1700, 430], [2000, 800], 16);   // bottom-right arc
  p.bez([2000, 800], [2230, 950], [2242, 1150], 10);  // right side below bite
  p.bez([2242, 1150], [1850, 1250], [1850, 1480], 12); // BITE upper... in
  p.bez([1850, 1480], [1850, 1710], [2242, 1800], 12); // BITE ...and out
  p.bez([2242, 1800], [2280, 2080], [2100, 2330], 12); // right side above bite
  p.bez([2100, 2330], [1900, 2560], [1600, 2520], 12); // top-right bump
  p.bez([1600, 2520], [1400, 2560], notch, 10);        // dip to the notch
  // leaf: steep lens staying WEST of Park Ave (47th-49th medians are
  // uncrossable) — tip lands at Madison & 55th
  p.bez(notch, [1520, 2660], [1650, 3050], 12);        // leaf outer edge
  p.bez([1650, 3050], [1330, 2830], notch, 12);        // leaf inner edge, close
  return p.pts;
}

// ---------------------------------------------------------------------------
// TIGER — side profile facing west. Nose overhangs the front legs (animal
// grammar), one ear tick, arched back with FOUR stripe spurs (out-and-back
// retraces), curled tail, two pants-style leg pairs, belly line.
// Body rows 21-40, full width 10th -> 2nd Ave.
// ---------------------------------------------------------------------------
function tigerSketch(): Pt[] {
  // v2 — FRONTAL TIGER FACE filling the canvas (10th Ave -> 2nd Ave,
  // 22nd -> 55th St). Lesson from Ralph's round-2 feedback + the reference
  // art: recognizability comes from feature DENSITY at scale, not minimal
  // icons. Face centered on 6th Ave for symmetry. Features: ear triangles,
  // fur-ruff zigzag cheeks, three forehead stripes (7th/6th/5th), diamond
  // eyes (8th<->7th and 5th<->3rd), triangle nose, whisker arcs, jaw.
  // Blockers honored: top edge on 50th (Park medians 47-49), brow line on
  // 39th (Port Authority owns 8th at 40-42), everything else mid-island.
  const p = new Pen();
  const CX = 1097; // 6th Ave — face centerline
  // PASS 1: outline, counterclockwise from the chin
  p.add([CX, 400]);                                   // chin center (6th & 22nd)
  p.add([410, 400]);                                  // bottom edge west
  p.add([0, 720]);                                    // bottom-left chamfer to 10th
  p.add([0, 1040]);                                   // up 10th to the ruff zone
  p.add([272, 1200], [0, 1360], [272, 1520]);        // left fur ruff (lower teeth)
p.add([548, 1520], [272, 1520]);                    // left cheek stripe (out-and-back to 8th)
p.add([0, 1680], [272, 1840], [0, 2000]);           // left fur ruff (upper teeth)
  p.add([0, 2560]);                                   // up 10th to the temple
  p.add([272, 2640]);                                 // top-left corner
  p.add([548, 3060], [821, 2640]);                    // LEFT EAR triangle (apex 8th & 55th)
  p.add([821, 2140], [821, 2640]);                    // forehead stripe 1 (down 7th, retrace)
  p.add([CX, 2640]);
  p.add([CX, 2080], [CX, 2640]);                      // forehead stripe 2 (down 6th, above Bryant Pk corner)
  p.add([1406, 2640]);
  p.add([1406, 2160], [1406, 2640]);                  // forehead stripe 3 (down 5th)
  p.add([1421, 2640]);
  p.add([1707, 3060], [1970, 2640]);                  // RIGHT EAR triangle (apex Park & 55th)
  p.add([2242, 2560]);                                // top-right corner to 2nd Ave
  p.add([2242, 2000]);                                // down 2nd to the ruff zone
  p.add([1970, 1840], [2242, 1680], [1970, 1520]);   // right fur ruff (upper teeth)
p.add([1707, 1520], [1970, 1520]);                  // right cheek stripe (out-and-back to Park)
p.add([2242, 1360], [1970, 1200], [2242, 1040]);   // right fur ruff (lower teeth)
  p.add([2242, 720]);                                 // down 2nd
  p.add([1832, 400]);                                 // bottom-right chamfer
  p.add([CX, 400]);                                   // close at the chin
  // PASS 2: interior, straight up the centerline
  p.add([CX, 880]);                                   // muzzle junction
  p.bez([CX, 880], [950, 860], [821, 1000], 8);       // left muzzle arc (ends on 7th)
  p.bez([821, 1000], [950, 860], [CX, 880], 8);       // ...retrace back
  p.bez([CX, 880], [1250, 860], [1406, 1000], 8);     // right muzzle arc (ends on 5th)
  p.bez([1406, 1000], [1250, 860], [CX, 880], 8);     // ...retrace back
  p.add([CX, 1120]);                                  // nose bottom
  p.add([821, 1360], [1406, 1360], [CX, 1120]);       // NOSE triangle (closed loop)
  p.add([CX, 1760]);                                  // nose bridge up to the brow
  p.add([548, 1760]);                                 // brow line west along 39th
  p.add([272, 1600], [548, 1440], [821, 1600], [548, 1760]); // LEFT EYE diamond
  p.add([CX, 1760]);                                  // retrace brow back to center
  p.add([1707, 1760]);                                // brow line east
  p.add([1406, 1600], [1707, 1440], [2026, 1600], [1707, 1760]); // RIGHT EYE diamond
  p.add([CX, 1760]);                                  // retrace to center — END
  return p.pts;
}

// ---------------------------------------------------------------------------
// Rendering (same as gas-interp-v4)
// ---------------------------------------------------------------------------
function localSvg(paths: { pts: Pt[]; color: string; width: number }[], w = 900) {
  const all = paths.flatMap((p) => p.pts);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs) - 150;
  const maxX = Math.max(...xs) + 150;
  const minY = Math.min(...ys) - 150;
  const maxY = Math.max(...ys) + 150;
  const scale = w / (maxX - minX);
  const h = Math.round((maxY - minY) * scale);
  const px = ([x, y]: Pt) => `${((x - minX) * scale).toFixed(1)} ${((maxY - y) * scale).toFixed(1)}`;
  const body = paths
    .map(
      (p) =>
        `<path d="${p.pts.map((q, i) => `${i === 0 ? "M" : "L"} ${px(q)}`).join(" ")}" fill="none" stroke="${p.color}" stroke-width="${p.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("\n");
  return {
    svg: `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="white"/>${body}</svg>`,
  };
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
      `<path d="${d}" fill="none" stroke="#e8253f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eee" } })
    .composite([...tiles, { input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(file);
}

// ---------------------------------------------------------------------------
// APPLE v2 — same body Ralph liked, plus: FAT leaf (the v1 lens compiled to
// an unreadable zigzag stub), the bottom dimple every Apple mark has, and a
// deeper top notch. Leaf crossings stay off the Park Ave column (medians
// uncrossable 47-49); tip at Madison & 55th.
// ---------------------------------------------------------------------------
function apple2Sketch(): Pt[] {
  const p = new Pen();
  // Notch ON the 5th Ave column — the v1 mid-block notch made every leaf
  // stroke pin-jitter between 6th and 5th.
  const notch: Pt = [1406, 2320];
  p.add(notch);
  p.bez(notch, [1080, 2570], [900, 2530], 12);        // top-left bump
  p.bez([900, 2530], [420, 2350], [272, 1800], 16);   // left shoulder
  p.bez([272, 1800], [250, 1400], [400, 1000], 14);   // left side bulge (9th Ave)
  p.bez([400, 1000], [480, 520], [1000, 440], 16);    // bottom-left arc
  p.bez([1000, 440], [1120, 430], [1170, 620], 6);    // into the bottom dimple (2+ rows deep)
  p.bez([1170, 620], [1230, 430], [1350, 440], 6);    // out of the dimple
  p.bez([1350, 440], [1780, 470], [2000, 800], 16);   // bottom-right arc
  p.bez([2000, 800], [2230, 950], [2242, 1150], 10);  // right side below bite
  p.bez([2242, 1150], [1850, 1250], [1850, 1480], 12); // BITE upper... in
  p.bez([1850, 1480], [1850, 1710], [2242, 1800], 12); // BITE ...and out
  p.bez([2242, 1800], [2280, 2080], [2100, 2330], 12); // right side above bite
  p.bez([2100, 2330], [1900, 2560], [1600, 2500], 12); // top-right bump
  p.bez([1600, 2500], [1400, 2560], notch, 10);        // dip to the notch
  // FAT leaf: waist ~2 avenue columns wide (the v1 lens collapsed to a
  // stub), tilted NE, tip at Madison & 57th. Crossings stay in the
  // 5th-Madison corridor — never the Park column (medians 47-49).
  p.bez(notch, [1780, 2620], [1560, 3180], 14);        // leaf outer (east) edge
  p.bez([1560, 3180], [1150, 2870], notch, 14);        // leaf inner (west) edge
  return p.pts;
}

// ---------------------------------------------------------------------------
// NIKE LOCKUP v2 — the "NIKEBLOCK" Ralph preferred over the lone swoosh:
// block letters N-I-K-E (baseline 47th, caps 55th — the clean band above
// the midtown trap belt) over the verified swoosh geometry raised ~10 rows
// (tail tip 10th & 36, point tip 1st & 44, clear of Tudor City 40-43; the
// inner corner is pulled to 8th & ~30.7, below the Penn Station desert).
// One-line plan: swoosh loop first, its closing tail tip flows up 10th Ave
// into N's left stroke (reads as a descender); letters connect along the
// baseline (underline) and cap row; only straight strokes are retraced.
// ---------------------------------------------------------------------------
function nike2Sketch(): Pt[] {
  const W = 2471;
  const LIFT = 800; // +10 rows over the verified rows-17-34 swoosh
  const P = (fx: number, fy: number): Pt => [fx * W, fy * 1.6 * W + LIFT];
  const p = new Pen();
  // swoosh (closed loop, tail tip -> around -> tail tip)
  p.add(P(0, 0.2));
  p.bez(P(0, 0.2), P(0.05, 0.09), P(0.18, 0.025), 12);
  p.bez(P(0.18, 0.025), P(0.32, 0.005), P(0.5, 0.025), 14);
  p.bez(P(0.5, 0.025), P(0.68, 0.06), P(0.82, 0.14), 14);
  p.bez(P(0.82, 0.14), P(0.92, 0.22), P(1.0, 0.35), 10);
  p.bez(P(1.0, 0.35), P(0.8, 0.155), P(0.58, 0.095), 16);
  p.bez(P(0.58, 0.095), P(0.4, 0.06), P(0.222, 0.075), 10); // inner corner low: off Penn
  p.bez(P(0.222, 0.075), P(0.11, 0.12), P(0, 0.2), 10);
  // Letters live at rows 50-58: above the GCT/Bryant/PA trap belt AND the
  // Park Ave medians (47-49), so E's bars can cross Park at full width.
  // N spans TWO columns so its diagonal staircases legibly (the 1-column
  // version compiled as an H).
  const BASE = row(50);
  const CAP = row(58);
  // connector: up 10th into N (colinear with N's left stroke = descender)
  p.add([AVE_10, BASE]);
  // N: left stroke, 2-column diagonal, right stroke — exit at cap
  p.add([AVE_10, CAP]);
  p.add([AVE_8, BASE]);           // diagonal crosses 9th & 54
  p.add([AVE_8, CAP]);
  // cap connector to I, then I drawn top-down (no retrace needed)
  p.add([AVE_7, CAP]);
  p.add([AVE_7, BASE]);
  // baseline connector to K (vert on 6th, arm/leg tips on 5th)
  p.add([AVE_6, BASE]);
  p.add([AVE_6, row(54)]);        // lower stem up
  p.add([AVE_6, BASE]);           // retrace (hidden)
  p.add([AVE_5, BASE]);           // underline through the cell
  p.add([AVE_6, row(54)]);        // leg (drawn upward to the waist)
  p.add([AVE_6, CAP]);            // upper stem
  p.add([AVE_6, row(54)]);        // retrace (hidden)
  p.add([AVE_5, CAP]);            // arm — exit at cap
  // cap connector to E (vert on Madison, full bars to Lex crossing Park)
  p.add([MAD, CAP]);
  p.add([LEX, CAP]);              // top bar
  p.add([MAD, CAP]);              // retrace (hidden)
  p.add([MAD, row(54)]);
  p.add([LEX, row(54)]);          // middle bar
  p.add([MAD, row(54)]);          // retrace (hidden)
  p.add([MAD, BASE]);
  p.add([LEX, BASE]);             // bottom bar — END
  return p.pts;
}

// ---------------------------------------------------------------------------
// LION — east-facing head with a ZIGZAG MANE on the fine east grid
// (Mad/Park/Lex ~150 m apart carry the teeth), long body stretching west
// where straight lines are cheap, pants-style legs on avenue columns,
// tail drawn LAST as the route's open end (animal grammar). Organic and
// asymmetric on purpose — the symmetric tiger face read as clip-art.
// Blockers honored: belly on 22nd (Penn South has no through streets
// 23-29 between 8th-9th), mane bottom stays above Gramercy (Lex 20-21),
// mane west teeth land on Madison (Madison Sq Park's east sidewalk),
// muzzle tip at 1st & 31, everything under row 39 (GCT starts at 40).
// ---------------------------------------------------------------------------
function lionSketch(): Pt[] {
  const p = new Pen();
  const CX = 2130;                 // head center x (3rd-2nd)
  const CY = row(30);              // head center y (30th St)
  // MANE: zigzag ring, chin-side around the west to the crown. Teeth
  // alternate inner ~360 / outer ~580 (vertical squish 0.92). Computed
  // first so the body can join an exact tooth.
  const teeth: Pt[] = [];
  const N_TEETH = 13;
  for (let i = 0; i <= N_TEETH; i++) {
    const a = ((-60 - (200 * i) / N_TEETH) * Math.PI) / 180; // -60 -> -260 (=+100)
    const r = i % 2 === 0 ? 360 : 580;
    teeth.push([CX + r * Math.cos(a), CY + r * 0.92 * Math.sin(a)]);
  }
  p.add(...teeth);
  // FACE — few features, each 2+ blocks: brow slope, muzzle to 1st Ave,
  // OPEN JAW (a two-column V, the reference-tiger trick), chin into the
  // mane's chin-side tooth.
  const crown = teeth[teeth.length - 1];
  const chinTooth = teeth[0];
  p.bez(crown, [2260, row(37)], [2360, row(35)], 10);            // brow slope
  p.bez([2360, row(35)], [AVE_1, row(34.6)], [AVE_1, row(32.6)], 8); // muzzle top
  p.add([2150, row(31)]);          // JAW V: deep back in (2 columns)
  p.add([AVE_1, row(29.4)]);       // lower jaw back out to 1st
  p.bez([AVE_1, row(29.4)], [2400, row(27.2)], [2260, row(26.4)], 8); // jaw underside
  p.bez([2260, row(26.4)], chinTooth, chinTooth, 6);             // chin joins the mane
  // BODY from the chin tooth: chest low under the mane (below Madison Sq
  // Park's 23rd-26th block), legs on avenue columns, belly on 22nd
  // (Penn South has no through streets 23-29).
  p.bez(chinTooth, [1950, row(23.5)], [1560, row(22.3)], 10);    // chest sweep
  p.add([AVE_5, row(22)]);         // to the front leg
  p.add([AVE_5, row(14)]);         // front leg front (5th Ave)
  p.add([AVE_6, row(14)]);         // under the front paw
  p.add([AVE_6, row(22)]);         // front leg back
  p.add([AVE_9, row(22)]);         // belly west along 22nd
  p.add([AVE_9, row(14)]);         // hind leg front
  p.add([AVE_10, row(14)]);        // under the hind paw
  p.add([AVE_10, row(30)]);        // hind leg back + rump up 10th
  p.bez([AVE_10, row(30)], [-60, row(35)], [272, row(36)], 10);  // rump arc
  p.add(teeth[9]);                 // back: ONE straight line into a real tooth
  p.add([272, row(36)]);           // retrace the straight back (hidden)
  // TAIL: the open end — big S over the rump, curling into the 11th Ave
  // corridor (dead only at 30-33) with a 2-block hook.
  p.bez([272, row(36)], [60, row(38.5)], [-140, row(40)], 8);    // tail rise
  p.bez([-140, row(40)], [-300, row(41.5)], [-100, row(42.3)], 8); // curl over
  p.add([180, row(42)]);           // tip hook east (2 blocks — survives compile)
  return p.pts;
}

// ---------------------------------------------------------------------------
// GAS v6 — designed FROM the city (Ralph's standing directive): the hose IS
// Broadway (Flatiron -> Columbus Circle), the coil IS Madison Square Park's
// perimeter, the headphone ear cup IS Columbus Circle (an actual circle),
// and the head IS Central Park's curved lower drive loop (West Drive ->
// Terrace Drive -> East Drive), jaw on Central Park South. Broadway threads
// the pump-torso air gap and crosses the chest once — like the logo's hose.
// Landmark coordinates measured from the real lattice (see session notes).
// ---------------------------------------------------------------------------
function gasV6Sketch(): Pt[] {
  const p = new Pen();
  // PUMP 10th -> 8th, 22nd -> 56th (bottom on 22nd: Penn South has no
  // through streets 23-29 between 8th-9th). Window upper-left drawn as a
  // spur whose shared edge is filled on the way back down (no gaps).
  // Pump and figure share the 38th St ground line (logo proportions:
  // pump ~ figure height, head:body ~ 1:2). Pump 10th -> 8th, 38th -> 64th.
  p.add([AVE_8, row(43)]);         // boss (8th & 43rd — clear of PA 40-42)
  p.add([AVE_8, row(38)]);
  p.add([AVE_10, row(38)]);        // bottom along 38th
  p.add([AVE_10, row(54)]);        // up 10th to the window
  p.add([AVE_9, row(54)]);         // window bottom (54th)
  p.add([AVE_9, row(60)]);         // window right side up 9th
  p.add([AVE_10, row(60)]);        // window top (60th)
  p.add([AVE_10, row(54)]);        // fill the shared pump-left edge (fresh ink)
  p.add([AVE_10, row(64)]);        // re-ascend (54-60 hidden retrace) to the top
  p.add([AVE_8, row(64)]);         // pump top along 64th
  p.add([AVE_8, row(43)]);         // down 8th (PA 40-42 is passage) — boss
  // HOSE: coil (proven v4 grammar — full loop entered and exited at the
  // top, tangents on real avenues, 600 m across so it holds its own at
  // squint scale), then slack swinging out to Park Ave S, drooping down
  // to the Flatiron, and riding Broadway's diagonal to Columbus Circle.
  p.bez([AVE_8, row(43)], [800, row(40)], [1000, row(38.9)], 10); // boss to coil top
  p.arc(AVE_6, 1440, 300, 300, 100, -260, 40);                    // the coil (6th & 35th)
  p.bez([1150, 1735], [1600, 1560], [PARK, row(33)], 12);         // slack swings to Park
  p.add([PARK, row(23)]);          // hose droops down Park Ave S
  p.add([AVE_5, row(23)]);         // west along 23rd to the Flatiron
  p.add([1097, 1364]);             // Broadway @ Herald Square (34th)
  p.add([809, 2388]);              // Broadway @ Times Square (45th)
  p.add([704, 2890]);              // Broadway @ 52nd
  // EAR CUP: Columbus Circle, a real circle. Enter from Broadway's SE.
  // Coarse sampling (8 steps): fine steps pinned adjacent ring nodes whose
  // legal walk (crossings, one-ways) is 2x the chain hop.
  p.arc(540, 3359, 130, 130, -60, 300, 8);
  // HEAD: Central Park lower loop, pinned to REAL drive junctions (the
  // park's unnamed footpaths aren't in the lattice, so mid-drive points
  // must land on actual crossings or the compiler shortcuts across the
  // 65th St Transverse — the first compile decapitated the head).
  p.add([540, row(60.9)]);         // West Drive / CPW chain up from Columbus
  p.add([540, row(63.9)]);
  p.add([540, row(66.9)]);
  p.add([553, row(67.0)]);         // drive curves into the park
  p.add([670, row(70.1)]);
  p.add([708, row(71.1)]);
  p.add([833, row(70.8)]);         // Terrace Drive west end
  p.add([1021, row(71.2)]);
  p.add([1170, row(72.3)]);        // crown — Terrace peaks east of center
  p.add([1348, row(71.8)]);
  p.add([1402, row(70.8)]);        // East Drive / 5th chain down
  p.add([1402, row(66.8)]);
  p.add([1402, row(62.8)]);
  p.add([1401, row(60.9)]);        // East Drive ends above Grand Army Plaza
  p.add([548, row(59)]);           // jaw: Central Park South back to Columbus
  // BODY: retrace the jaw east (hidden), torso 7th -> Madison, legs with
  // Bryant Park sitting harmlessly in the notch (crotch bar = 42nd, its
  // north edge). Broadway crosses the chest at ~45th — the logo's hose.
  p.add([AVE_7, row(59)]);         // hidden retrace along CPS to the left shoulder
  p.add([AVE_7, row(38)]);         // torso-left + outer left leg, one line down 7th
  p.add([AVE_6, row(38)]);         // left foot on the 38th St ground line
  p.add([AVE_6, row(49)]);         // inner left leg up 6th
  p.add([AVE_5, row(49)]);         // crotch across 49th (through Rockefeller Center)
  p.add([AVE_5, row(38)]);         // inner right leg down 5th
  p.add([MAD, row(38)]);           // right foot (38th)
  p.add([MAD, row(59)]);           // outer right leg + torso up Madison
  p.add([AVE_5, row(59)]);         // shoulder west — ends at Grand Army (already inked)
  return p.pts;
}

// ---------------------------------------------------------------------------
// NIKE v3 — the FULL lockup Ralph asked for: fat swoosh on top (rows 41-53,
// both edges threading the only legal Park-column crossings: <=41st or
// >=50th; 8th Ave crossed at 43+, clear of Port Authority), "JUST" at rows
// 30-38 (fine-trio T), "DO IT." at rows 14-22 with every bottom bar on
// 14th St. One line: swoosh -> left-margin stub -> JUST (west to east) ->
// the two T-stems align vertically as the line-to-line connector ->
// DO IT. (east to west) ending at the D. Only straight strokes retrace.
// ---------------------------------------------------------------------------
function nike3Sketch(): Pt[] {
  const p = new Pen();
  // SWOOSH (closed loop from the tail tip at 10th & 46th)
  p.add([AVE_10, row(46)]);
  p.bez([AVE_10, row(46)], [180, row(43.5)], [AVE_8, row(43)], 10);
  p.bez([AVE_8, row(43)], [850, row(41.2)], [AVE_5, row(41)], 14);
  p.bez([AVE_5, row(41)], [1700, row(40.8)], [LEX, row(41)], 10);
  p.bez([LEX, row(41)], [2100, row(42)], [AVE_2, row(45)], 10);
  p.bez([AVE_2, row(45)], [2400, row(48.5)], [AVE_1, row(53)], 10);  // the point
  p.bez([AVE_1, row(53)], [2260, row(51.5)], [LEX, row(51)], 10);
  p.bez([LEX, row(51)], [1560, row(50.3)], [AVE_5, row(50)], 10);
  p.bez([AVE_5, row(50)], [1150, row(49)], [AVE_7, row(47.5)], 10);
  p.bez([AVE_7, row(47.5)], [640, row(46.8)], [AVE_8, row(47)], 6);  // inner corner
  p.bez([AVE_8, row(47)], [250, row(47.5)], [AVE_10, row(46)], 8);   // tail top
  // stub down the left margin into J (reads as the text block's left edge)
  p.add([AVE_10, row(38)]);
  // J
  p.add([AVE_9, row(38)]);         // bar
  p.add([AVE_9, row(30)]);         // stem
  p.add([AVE_10, row(30)]);        // hook
  p.add([AVE_8, row(30)]);         // baseline connector (retraces the hook, then fresh)
  // U
  p.add([AVE_8, row(38)]);         // left stem up
  p.add([AVE_8, row(30)]);         // retrace (hidden)
  p.add([AVE_7, row(30)]);         // bottom
  p.add([AVE_7, row(38)]);         // right stem — exit at cap
  p.add([AVE_6, row(38)]);         // cap connector
  // S (block: top bar, upper-left stem, mid bar, lower-right stem, bottom bar)
  p.add([AVE_5, row(38)]);
  p.add([AVE_6, row(38)]);         // retrace (hidden)
  p.add([AVE_6, row(34)]);
  p.add([AVE_5, row(34)]);
  p.add([AVE_5, row(30)]);
  p.add([AVE_6, row(30)]);         // bottom bar, ends baseline-west
  // baseline connector east to T (retraces S's bottom bar, then fresh)
  p.add([PARK, row(30)]);
  // T of JUST: stem on Park (fine trio), bar Madison -> Lex on 38th
  p.add([PARK, row(38)]);
  p.add([MAD, row(38)]);           // bar west half
  p.add([PARK, row(38)]);          // retrace (hidden)
  p.add([LEX, row(38)]);           // bar east half
  p.add([PARK, row(38)]);          // retrace (hidden)
  p.add([PARK, row(30)]);          // stem retrace down (hidden)
  // line-to-line connector: the two T stems align vertically
  p.add([PARK, row(22)]);
  // T of DO IT.: bar 5th -> 3rd on 22nd, stem Park Ave S 14-22
  p.add([AVE_5, row(22)]);         // bar west half
  p.add([PARK, row(22)]);          // retrace (hidden)
  p.add([AVE_3, row(22)]);         // bar east half
  // period (3rd -> 2nd, rows 14-16) hung from the bar via a short stub
  p.add([AVE_3, row(16)]);
  p.add([AVE_2, row(16)]);
  p.add([AVE_2, row(14)]);
  p.add([AVE_3, row(14)]);
  p.add([AVE_3, row(16)]);         // period closed
  p.add([AVE_3, row(22)]);         // retrace the stub (hidden)
  p.add([PARK, row(22)]);          // retrace bar back to the stem (hidden)
  p.add([PARK, row(14)]);          // T stem down to 14th
  p.add([AVE_6, row(14)]);         // 14th St west along Union Square's south side
  // I
  p.add([AVE_6, row(22)]);
  p.add([AVE_6, row(14)]);         // retrace (hidden)
  p.add([AVE_7, row(14)]);         // baseline connector
  // O
  p.add([AVE_7, row(22)]);
  p.add([AVE_8, row(22)]);
  p.add([AVE_8, row(14)]);
  p.add([AVE_7, row(14)]);         // O closed
  p.add([AVE_8, row(14)]);         // retrace bottom (hidden)
  p.add([AVE_9, row(14)]);         // baseline connector
  // D
  p.add([AVE_9, row(22)]);
  p.add([AVE_10, row(22)]);
  p.add([AVE_10, row(14)]);
  p.add([AVE_9, row(14)]);         // D closed — END
  return p.pts;
}

// ---------------------------------------------------------------------------
// GAS v7 — ONE bold silhouette (the medium rewards single closed shapes;
// the full badge kept reading as a wireframe). Just the person: head =
// Central Park's lower drive loop, ear cup = Columbus Circle, and the hose
// reduced to a headphone wire — Broadway's diagonal drooping through the
// Flatiron, around Park Ave S, ending in a dangling coiled plug (the
// route's open start). Chunky torso and pants legs centered under the head.
// ---------------------------------------------------------------------------
function gasV7Sketch(): Pt[] {
  const p = new Pen();
  // DANGLING PLUG: a closed coil BELOW the feet (6th & 24th-25th — clear
  // of Madison Sq Park to its east and Penn South to its west), joined by
  // a short tangent to the Flatiron where the wire picks up Broadway.
  p.arc(AVE_6, 600, 300, 300, 0, -360, 40);                       // the plug coil
  p.bez([1397, 600], [1450, 520], [1422, 435], 6);                // tangent to the Flatiron
  p.add([1097, 1364]);             // WIRE: Broadway @ Herald Square (34th)
  p.add([809, 2388]);              // Broadway @ Times Square (45th)
  p.add([704, 2890]);              // Broadway @ 52nd
  // EAR CUP: Columbus Circle (coarse ring — plaza nodes)
  p.arc(540, 3359, 130, 130, -60, 300, 8);
  // HEAD: Central Park lower drive loop, junction-pinned
  p.add([540, row(60.9)]);
  p.add([540, row(63.9)]);
  p.add([540, row(66.9)]);
  p.add([553, row(67.0)]);
  p.add([670, row(70.1)]);
  p.add([708, row(71.1)]);
  p.add([833, row(70.8)]);
  p.add([1021, row(71.2)]);
  p.add([1170, row(72.3)]);        // crown — Terrace Drive peaks east of center
  p.add([1348, row(71.8)]);
  p.add([1402, row(70.8)]);
  p.add([1402, row(66.8)]);
  p.add([1402, row(62.8)]);
  p.add([1401, row(60.9)]);
  p.add([548, row(59)]);           // jaw: Central Park South back to Columbus
  // BODY: bigger than v6 (the pump's space goes into the figure) —
  // torso 7th -> Madison, legs 30th-45th, crotch on 45th.
  p.add([AVE_7, row(59)]);         // hidden retrace along CPS to the left shoulder
  p.add([AVE_7, row(30)]);         // torso-left + outer left leg down 7th
  p.add([AVE_6, row(30)]);         // left foot (30th)
  p.add([AVE_6, row(45)]);         // inner left leg up 6th
  p.add([AVE_5, row(45)]);         // crotch across 45th
  p.add([AVE_5, row(30)]);         // inner right leg down 5th
  p.add([MAD, row(30)]);           // right foot (30th)
  p.add([MAD, row(59)]);           // outer right leg + torso up Madison
  p.add([AVE_5, row(59)]);         // shoulder west — ends at Grand Army
  return p.pts;
}

type Design = { name: string; ref?: string; sketch: () => Pt[] };
const DESIGNS: Design[] = [
  { name: "nike", ref: "nike.png", sketch: nikeSketch },
  { name: "apple", sketch: appleSketch },
  { name: "tiger", ref: "TIGER.webp", sketch: tigerSketch },
  { name: "apple2", sketch: apple2Sketch },
  { name: "nike2", ref: "nike.png", sketch: nike2Sketch },
  { name: "lion", ref: "lion.webp", sketch: lionSketch },
  { name: "gas-v6", ref: "gas.png", sketch: gasV6Sketch },
  { name: "nike3", ref: "nike.png", sketch: nike3Sketch },
  { name: "gas-v7", ref: "gas.png", sketch: gasV7Sketch },
];

async function runDesign(d: Design, graph: ReturnType<typeof buildLatticeGraph>) {
  const OUT = path.join(process.cwd(), "tmp-interp-designs", d.name);
  await fs.mkdir(OUT, { recursive: true });
  const sketch = d.sketch();
  const sk = localSvg([{ pts: sketch, color: "#111", width: 7 }]);
  await sharp(Buffer.from(sk.svg)).png().toFile(path.join(OUT, "1-sketch.png"));

  const placed = sketch.map(toLatLng);
  const result = compileContourToLattice(placed, graph, { sampleMeters: 38, pinRadiusMeters: 150 });
  if (!result) throw new Error(`${d.name}: compile returned null`);
  const stats = {
    km: Number(result.km.toFixed(1)),
    meanDev: Number(result.meanDeviationMeters.toFixed(1)),
    maxDev: Number(result.maxDeviationMeters.toFixed(1)),
    legs: result.legCount,
    skippedPins: result.skippedPins,
  };
  console.log(d.name, stats);

  const compiledLocal = result.chain.map(toLocal);
  const cs = localSvg([
    { pts: sketch, color: "#f2b8c0", width: 4 },
    { pts: compiledLocal, color: "#111", width: 6 },
  ]);
  await sharp(Buffer.from(cs.svg)).png().toFile(path.join(OUT, "2-compiled.png"));
  await renderMap(result.chain, path.join(OUT, "3-map.png"));

  const cell = 620;
  const cols: { file: string; label: string }[] = [];
  if (d.ref) cols.push({ file: path.join(process.cwd(), d.ref), label: "1. reference" });
  cols.push(
    { file: path.join(OUT, "1-sketch.png"), label: `${cols.length + 1}. interpretive sketch` },
    { file: path.join(OUT, "2-compiled.png"), label: `${cols.length + 2}. compiled to streets` },
    { file: path.join(OUT, "3-map.png"), label: `${cols.length + 3}. on the map (${stats.km} km)` },
  );
  const fit = async (file: string) =>
    sharp(file).resize(cell, cell, { fit: "contain", background: "#fff" }).png().toBuffer();
  const label = (t: string) =>
    Buffer.from(`<svg width="${cell}" height="40"><text x="10" y="28" font-family="Arial" font-size="24" font-weight="700" fill="#111">${t}</text></svg>`);
  const composites: sharp.OverlayOptions[] = [];
  for (let i = 0; i < cols.length; i++) {
    composites.push({ input: await fit(cols[i].file), left: 10 + i * (cell + 10), top: 60 });
    composites.push({ input: label(cols[i].label), left: 10 + i * (cell + 10), top: 10 });
  }
  await sharp({
    create: { width: cell * cols.length + 10 * (cols.length + 1), height: cell + 70, channels: 4, background: "#fff" },
  })
    .composite(composites)
    .png()
    .toFile(path.join(OUT, "SHEET.png"));

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${d.name} interpretation</name><trkseg>
${result.chain.map(([la, ln]) => `    <trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  await fs.writeFile(path.join(OUT, `${d.name.toUpperCase()}.gpx`), gpx, "utf8");
  await fs.writeFile(path.join(OUT, "meta.json"), JSON.stringify(stats, null, 2), "utf8");
}

async function main() {
  const which = process.argv[2] ?? "all";
  const latticeData = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "lib", "data", "manhattan-lattice.json"), "utf8"),
  ) as LatticeData;
  const graph = buildLatticeGraph(latticeData);
  for (const d of DESIGNS) {
    if (which !== "all" && which !== d.name) continue;
    await runDesign(d, graph);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
