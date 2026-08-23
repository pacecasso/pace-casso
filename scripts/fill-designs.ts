/**
 * FILL-DESIGN spike — the "ink mass" experiment.
 *
 * Diagnosis (July 15): every reference WOW route (HEART.webp, TIGER.webp,
 * lion.webp, LOVE.png) has variable ink density — solid hatched regions,
 * doubled strokes, dense texture. Our routes are uniform one-line
 * wireframes, which is why geometrically-correct results still read as
 * "sad". This spike adds the missing primitive: REGION FILL — serpentine
 * hatch coverage of the streets inside a boundary polygon, compiled with
 * the production lattice compiler like everything else.
 *
 * Run: npx tsx scripts/fill-designs.ts <heart|all>
 * Verify: npx tsx scripts/gas-interp-v4-verify.ts tmp-fill-designs/heart/HEART.gpx
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

type Pt = [number, number];
const row = (street: number) => (street - 17) * 80;
const AVE_9 = 272, AVE_8 = 548, AVE_7 = 821, AVE_6 = 1097;
const AVE_5 = 1406, MAD = 1560, PARK = 1707, LEX = 1870, AVE_3 = 2026;
const AVE_2 = 2242, AVE_1 = 2471;
const COLS = [AVE_9, AVE_8, AVE_7, AVE_6, AVE_5, MAD, PARK, LEX, AVE_3, AVE_2, AVE_1];
const snapCol = (x: number) => COLS.reduce((b, c) => (Math.abs(c - x) < Math.abs(b - x) ? c : b));

// ---------------------------------------------------------------------------
// Scanline: horizontal line y across a closed polygon -> sorted [x0,x1] segs.
// ---------------------------------------------------------------------------
function scan(poly: Pt[], y: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
      xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
  }
  xs.sort((a, b) => a - b);
  const segs: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) segs.push([xs[i], xs[i + 1]]);
  return segs;
}

// ---------------------------------------------------------------------------
// HEART — parametric classic heart, 8th Ave -> 1st Ave, tip at 13th St,
// lobes topping out on 42nd. One heart unit maps to exactly one street row
// (29 units -> 2320 m). Widest at 34th, dip between lobes at 35th.
//
// Route = outline (tip, up the left side, around both lobes, back to tip)
// then serpentine fill bottom-up: main body rows, left lobe, a hidden
// retrace across the inked 33rd St pass, right lobe.
//
// Fill rows dodge the dead zones:
//   15-16 Union Square (Broadway-Park S), 24-25 Madison Sq Park (Mad-5th),
//   32 Penn Station (7th-8th), 41 Bryant Park (5th-6th), 43+ GCT untouched.
// ---------------------------------------------------------------------------
const H_CX = 1509.5;   // centered in the 8th->1st box
const H_HALFW = 961.5;
const H_Y0 = row(13);  // tip at 13th St (clear of Union Sq 14-17 at the taper)
const H_HEIGHT = 2320; // 29 rows -> lobes top on 42nd

function heartXY(t: number): Pt {
  const hx = 16 * Math.sin(t) ** 3;
  const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
  return [H_CX + (hx / 16) * H_HALFW, H_Y0 + ((hy + 17) / 29) * H_HEIGHT];
}
function heartOutline(): Pt[] {
  const pts: Pt[] = [];
  const N = 240;
  for (let i = 0; i <= N; i++) pts.push(heartXY(Math.PI + (2 * Math.PI * i) / N));
  return pts;
}

const INSET = 100;
const MIN_PASS = 250; // skip hatch rows narrower than ~1 column

function heartSketch(): Pt[] {
  const outline = heartOutline();
  const pts: Pt[] = [...outline];

  // one hatch pass along street s across [x0,x1]; dir +1 = west->east
  const pass = (s: number, seg: [number, number], dir: 1 | -1): boolean => {
    if (seg[1] - seg[0] < MIN_PASS) return false;
    const a = snapCol(seg[0] + INSET);
    const b = snapCol(seg[1] - INSET);
    if (b <= a) return false;
    const y = row(s);
    if (dir === 1) pts.push([a, y], [b, y]);
    else pts.push([b, y], [a, y]);
    return true;
  };

  // main body (single-segment rows): every other street, dodging
  // Madison Sq Park (24,25) and Penn Station (32).
  const MAIN_ROWS = [19, 21, 23, 26, 28, 30, 33];
  let dir: 1 | -1 = 1;
  for (const s of MAIN_ROWS) {
    const segs = scan(outline, row(s));
    if (!segs.length) continue;
    const whole: [number, number] = [segs[0][0], segs[segs.length - 1][1]];
    if (pass(s, whole, dir)) dir = dir === 1 ? -1 : 1;
  }

  // left lobe rows (two-segment rows above the 35th St dip; 41 is Bryant)
  const LOBE_ROWS = [36, 38, 40];
  dir = 1;
  for (const s of LOBE_ROWS) {
    const segs = scan(outline, row(s));
    if (segs.length < 2) continue;
    if (pass(s, segs[0], dir)) dir = dir === 1 ? -1 : 1;
  }

  // hidden transit: down 6th Ave through the left-lobe hatch to the inked
  // 33rd St pass, east along it, up into the right lobe on its west column.
  const r36 = scan(outline, row(36));
  const rightEntry = r36.length >= 2 ? snapCol(r36[1][0] + INSET) : PARK;
  pts.push([AVE_6, row(40)], [AVE_6, row(33)], [rightEntry, row(33)], [rightEntry, row(36)]);

  // right lobe
  dir = 1;
  for (const s of LOBE_ROWS) {
    const segs = scan(outline, row(s));
    if (segs.length < 2) continue;
    if (pass(s, segs[segs.length - 1], dir)) dir = dir === 1 ? -1 : 1;
  }
  return pts;
}

// ---------------------------------------------------------------------------
// HEART-ISLAND — the reference HEART.webp composition: the heart's lower
// taper IS Manhattan's taper. Tip at the Battery, edges riding the
// Hudson/East River shore corridors, lobes in Midtown, dense hatch downtown
// thinning upward. Authored in SCREEN space (north-up meters from the
// Battery) — no grid frame; downtown has no grid, and at this scale
// stairsteps read as curves. Points that land in the river get skipped by
// the pinner and A* pulls the chain onto the shore streets — the island
// clamps the drawing for us.
// ---------------------------------------------------------------------------
const BATTERY: LatLng = [40.7043, -74.0135];
function enToLatLng([e, n]: Pt): LatLng {
  const mPerLng = M_PER_LAT * Math.cos((BATTERY[0] * Math.PI) / 180);
  return [BATTERY[0] + n / M_PER_LAT, BATTERY[1] + e / mPerLng];
}
function latLngToEn([lat, lng]: LatLng): Pt {
  const mPerLng = M_PER_LAT * Math.cos((BATTERY[0] * Math.PI) / 180);
  return [(lng - BATTERY[1]) * mPerLng, (lat - BATTERY[0]) * M_PER_LAT];
}

// Catmull-Rom through anchors (closed), dense sample.
function catmullClosed(anchors: Pt[], per = 14): Pt[] {
  const P = anchors;
  const n = P.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    for (let j = 0; j < per; j++) {
      const t = j / per, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push([...out[0]]);
  return out;
}

// Outline anchors in lat/lng. Order: LEFT CROWN -> dip -> right crown ->
// down the east side -> TIP -> up the west side -> close at left crown.
// (Starting at the crown lets the hatch run top-down afterwards and finish
// the whole route at the Battery tip.)
// The lobes are the WIDEST part of the heart (v2 pinched them): outer edges
// ride 10th Ave and 1st Ave, crowns at 9th&45 / 2nd&45, dip at 5th&34.
// Upper outline in grid coords (blockers are easiest to dodge there), lower
// taper as lat/lng shore anchors. A tall heart: near-vertical sides on
// 10th Ave and 1st Ave from 14th to ~38th, fat round crowns at ~8th&46 and
// ~Lex-3rd&46, dip plunging to 5.5th Ave & 35th. GCT's dead zone
// (Mad-Lex x 42-46) sits under the right lobe's inner slope, which crosses
// that x-band below 42nd. PA (8th & 40-42) sits inside the left lobe —
// the outline only touches 8th Ave at ~45.7.
// KEY INSIGHT (v8): the heart must be upright in SCREEN space, not grid
// space. Manhattan streets lean ~29 degrees, so a crown line drawn along a
// street row tilts the whole heart into a shield. Compensation: the right
// crown sits ~7 street-rows HIGHER than the left (2nd&52 vs 8th&45), the
// dip at Park&37 — level and centered on screen. All anchors are lat/lng.
// Top authored parametrically in EN meters from the Battery (the compiler
// quantizes to real streets; at this scale stairsteps read as curves).
// Level crowns at N6100, round lobes ~1.4 km wide, dip plunging to N5250.
const EN_A = (e: number, n: number): LatLng => enToLatLng([e, n]);
const HEART_ISLAND_ANCHORS: LatLng[] = [
  EN_A(1950, 6100), // LEFT CROWN (~7th & 47th in grid terms)
  EN_A(2450, 5400), // left inner slope — crosses the GCT x-band BELOW 40th
  EN_A(2850, 4600), // DIP — plunges to ~Park & 33rd (classic 0.24H depth)
  EN_A(3200, 5350), // right inner slope — stays east of Lex the whole way
  EN_A(3700, 5950), // RIGHT CROWN (~3rd Ave & 52nd) — a touch lower, organic
  EN_A(4050, 5600), // outer bulge — 1st Ave ~51st (UN campus is 42-48)
  EN_A(3900, 4900), // 1st Ave ~ 42nd
  EN_A(3800, 4600), // 1st Ave ~ 37th
  [40.735, -73.979],   // 1st Ave ~ 20th (Stuy Town stays east)
  [40.727, -73.972],   // East River Park ~ E 6th
  [40.7205, -73.9725], // East River Park ~ Houston
  [40.7115, -73.979],  // Corlears Hook
  [40.7095, -73.9975], // South St & Catherine
  [40.7025, -74.0095], // South St & Broad
  [40.7043, -74.0135], // TIP — Bowling Green / Battery
  [40.709, -74.0148],  // West St & Rector
  [40.7175, -74.0122], // West St & Chambers
  [40.7238, -74.0107], // West St & Canal
  [40.7332, -74.0107], // West St & Christopher
  [40.7424, -74.0079], // 10th Ave & 14th
  EN_A(950, 4900),  // west side ~10th Ave & 26th
  EN_A(1150, 5500), // west shoulder ~10th & 34th
  EN_A(1430, 5950), // left lobe outer bulge (10th Ave — Hudson Yards stays west)
];

function heartIslandSketch(): Pt[] {
  const anchors = HEART_ISLAND_ANCHORS.map(latLngToEn);
  const outline = catmullClosed(anchors, 16);
  const pts: Pt[] = [...outline];
  const H_INSET = 130;
  let dir: 1 | -1 = 1;
  const emit = (a: Pt, b: Pt) => {
    if (dir === 1) pts.push(a, b);
    else pts.push(b, a);
    dir = dir === 1 ? -1 : 1;
  };

  // ZONE 1 (14th-33rd + East Village): hatch along REAL numbered streets —
  // grid-frame rows scanned against the grid-frame outline, endpoints
  // snapped to avenue columns. Screen-horizontal passes here staircase
  // against the 29-degree grid (v2's mid-band mess). Rows dodge Penn
  // Station (32), Madison Sq Park (24-25), Union Sq (15-16), and the
  // broken EV corridors (E5/E8/E9/E11/E12); rows 24-29 clamp west of
  // Penn South's 8th-9th superblock.
  const gridOutline = outline.map((p) => toLocal(enToLatLng(p)));
  const EV_COLS = [...COLS, 2680, 2745, 3020, 3290]; // York-ish, Aves A, B, C
  const snapEv = (x: number) => EV_COLS.reduce((c0, c) => (Math.abs(c - x) < Math.abs(c0 - x) ? c : c0));
  // Pen sequence (outline ended back at the left crown):
  //   left lobe top-down -> full 34th St pass -> right lobe bottom-up ->
  //   down the 1st Ave side -> body rows top-down -> East Village ->
  //   downtown zone -> tip. All connectors are short verticals on avenue
  //   columns; the lobe-to-lobe crossing rides the inked 34th St row, so
  //   the dip notch stays clean.
  // Blocker dodges: left lobe skips 41-42 (PA owns 8th-9th there, Bryant
  // 5th-6th); right lobe's 43 starts at Lex (GCT cross-streets dead
  // Mad-Lex 42-46); 26 clamps east of Penn South; EV rows avoid the
  // broken E5/E8/E9/E11/E12 corridors.
  const toEn = (x: number, y: number): Pt => latLngToEn(toLatLng([x, y]));
  const segsAt = (s: number) => scan(gridOutline, row(s));
  // Hatch ends snap ONTO the boundary column when the outline rides an
  // avenue (clean T-junctions, like the reference); otherwise inset first.
  const snapSeg = (seg: [number, number], clampWest?: number, minLen = 380): [number, number] | null => {
    let sa = snapEv(seg[0]);
    if (sa < seg[0] - 50) sa = snapEv(seg[0] + H_INSET);
    let sb = snapEv(seg[1]);
    if (sb > seg[1] + 50) sb = snapEv(seg[1] - H_INSET);
    if (clampWest !== undefined) sa = Math.max(sa, clampWest);
    return sb - sa < minLen ? null : [sa, sb];
  };
  const push = (x: number, s: number) => pts.push(toEn(x, row(s)));

  // LEFT lobe (grid rows ~34-47), top-down; short crown stubs allowed.
  const leftSeq: { s: number; dir: 1 | -1 }[] = [
    { s: 46, dir: 1 },
    { s: 43, dir: -1 },
    { s: 40, dir: 1 },
    { s: 37, dir: -1 },
    { s: 34, dir: 1 },
  ];
  let leftEnd = AVE_6;
  for (const q of leftSeq) {
    const segs = segsAt(q.s);
    if (segs.length < 2) continue;
    const sn = snapSeg(segs[0], undefined, 250);
    if (!sn) continue;
    if (q.dir === 1) push(sn[0], q.s), push(sn[1], q.s);
    else push(sn[1], q.s), push(sn[0], q.s);
    leftEnd = q.dir === 1 ? sn[1] : sn[0];
  }
  // Row 31 runs just under the dip bottom (grid row ~33): drop straight
  // down from wherever the left lobe ended, run the west stub, then one
  // full pass east (the retrace over fresh ink is invisible), landing at
  // the right side to climb the right lobe.
  const s31 = segsAt(31);
  const sn31 = snapSeg([s31[0][0], s31[s31.length - 1][1]]);
  let prevEnd: [number, number] | null = null;
  if (sn31) {
    push(leftEnd, 31);
    push(sn31[0], 31);
    push(sn31[1], 31);
    prevEnd = [sn31[1], 31];
  }
  // RIGHT lobe (grid rows ~34-56 thanks to the screen-space tilt) —
  // a leaning sliver east of Lex in grid terms, so GCT never bites.
  // Adaptive every-2-rows; 40/42 end at 2nd Ave (Tudor City owns the
  // 1st Ave corners at 40-43 and spurs pass ends east).
  let rDir: 1 | -1 = -1;
  for (let s = 34; s <= 56; s += 2) {
    const segs = segsAt(s);
    if (!segs.length) continue;
    const raw = segs[segs.length - 1];
    const seg: [number, number] =
      s >= 40 && s <= 43 ? [raw[0], Math.min(raw[1], AVE_2 + 40)] : raw;
    const sn = snapSeg(seg, undefined, 220);
    if (!sn) continue;
    const startX = rDir === 1 ? sn[0] : sn[1];
    if (prevEnd) push(startX, prevEnd[1]); // vertical connector on the start column
    if (rDir === 1) push(sn[0], s), push(sn[1], s);
    else push(sn[1], s), push(sn[0], s);
    prevEnd = [rDir === 1 ? sn[1] : sn[0], s];
    rDir = rDir === 1 ? -1 : 1;
  }
  // descend the east side (rides the inked 1st Ave outline) and hatch the
  // body top-down with an even ~3-row rhythm; dodges stay as clamps/skips.
  const bodySeq: { s: number; dir: 1 | -1; clampWest?: number }[] = [
    { s: 27, dir: -1, clampWest: AVE_8 },
    { s: 23, dir: 1 },
    { s: 20, dir: -1 },
    { s: 17, dir: 1 },
    { s: 14, dir: -1 },
    { s: 10, dir: 1 },
    { s: 7, dir: -1 },
    { s: 4, dir: 1 },
  ];
  for (const q of bodySeq) {
    const segs = segsAt(q.s);
    if (process.env.FILL_DEBUG) console.log("body row", q.s, JSON.stringify(segs.map((g) => g.map(Math.round))));
    if (!segs.length) continue;
    const sn = snapSeg([segs[0][0], segs[segs.length - 1][1]], q.clampWest);
    if (!sn) continue;
    if (q.dir === 1) push(sn[0], q.s), push(sn[1], q.s);
    else push(sn[1], q.s), push(sn[0], q.s);
  }

  // ZONE 2 (below Houston): screen-horizontal passes — FiDi/Chinatown/LES
  // streets are close enough to E-W that the wobble reads as organic
  // shading. Runs all the way into the tip (the reference tip is SOLID),
  // then the route ends at the Battery point.
  for (let n = 2150; n >= 300; n -= 200) {
    const segs = scan(outline, n);
    if (!segs.length) continue;
    const a = segs[0][0] + H_INSET;
    const b = segs[segs.length - 1][1] - H_INSET;
    if (b - a < 280) continue;
    emit([a, n], [b, n]);
  }
  pts.push(latLngToEn([40.7043, -74.0135]));
  return pts;
}

// ---------------------------------------------------------------------------
// Rendering (same as interp-designs.ts)
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

type Design = { name: string; ref?: string; sketch: () => Pt[]; frame?: "grid" | "en" };
const DESIGNS: Design[] = [
  { name: "heart", ref: "HEART.webp", sketch: heartSketch },
  { name: "heart-island", ref: "HEART.webp", sketch: heartIslandSketch, frame: "en" },
];

async function runDesign(d: Design, graph: ReturnType<typeof buildLatticeGraph>) {
  const OUT = path.join(process.cwd(), "tmp-fill-designs", d.name);
  await fs.mkdir(OUT, { recursive: true });
  const sketch = d.sketch();
  const sk = localSvg([{ pts: sketch, color: "#111", width: 7 }]);
  await sharp(Buffer.from(sk.svg)).png().toFile(path.join(OUT, "1-sketch.png"));

  const toLL = d.frame === "en" ? enToLatLng : toLatLng;
  const fromLL = d.frame === "en" ? latLngToEn : toLocal;
  const placed = sketch.map(toLL);
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

  const compiledLocal = result.chain.map(fromLL);
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
    { file: path.join(OUT, "1-sketch.png"), label: `${cols.length + 1}. sketch + fill` },
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
  <trk><name>${d.name} fill</name><trkseg>
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
