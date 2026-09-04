/**
 * STROKE PAINTER (Sep 3) — offline prototype of the new drawing primitive.
 *
 * The reference pieces (lion, tiger, sneaker) are not traced outlines: they
 * are paintings made of street runs, with doubling back and hatching as the
 * brush. This rig treats the upload as a FILLED silhouette and paints it:
 *
 *   mask ──► mass (opening at ~half a block)  ──► outline rings + hatch rows
 *        └─► thin (mask − mass)               ──► skeleton centerlines
 *
 * Every stroke is routed on the real Manhattan walk graph (outline via the
 * corridor tracer, hatch rows as straight street runs, connectors as
 * shortest walks — doubling allowed). Placement is grid-aligned (up =
 * avenue direction) so hatch rows land on cross streets.
 *
 * Usage: npx tsx scripts/stroke-painter.ts <image> [--mask=ink|blue|dark]
 *        [--name=gas] [--scales=1800,2400] [--pitch=160] [--picks=3] [--nojudge]
 * Output: tmp-painter/<name>/…
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import * as d3 from "d3-contour";
import {
  getStreetGraph,
  traceContour,
  place,
  type LatLng,
} from "../lib/streetGraphTrace";
import { centerlinePolylinesFromLineMask } from "../lib/centerlineFromMask";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");

type UnitPt = [number, number];
type Graph = {
  coord: LatLng[];
  adj: { to: number; w: number }[][];
  grid: Map<string, number[]>;
};
type Stroke = {
  kind: "outline" | "hatch" | "thin";
  pts: UnitPt[];
  closed: boolean;
  /** redrawn link (hose): always traced organically as stairs, never quantized into a box */
  link?: boolean;
  /** body group: outline + hatch rows + holes of one mass are drawn as a unit */
  group?: number;
};

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const IMG = argv.find((a) => !a.startsWith("--"));
const opt = (k: string, d: string) =>
  argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
if (!IMG) {
  console.log("usage: npx tsx scripts/stroke-painter.ts <image> [--mask=ink|blue|dark] [--name=x]");
  process.exit(1);
}
const NAME = opt("name", path.basename(IMG).replace(/\.[^.]+$/, ""));
const MASK_MODE = opt("mask", "ink");
const SCALES = opt("scales", "auto") === "auto" ? [1600, 2200, 2800] : opt("scales", "").split(",").map(Number);
const PITCH_M = Number(opt("pitch", "160"));
const PICKS = Number(opt("picks", "3"));
const ROWS = Number(opt("rows", "5"));
const OPEN_M = Number(opt("open", "60"));
const LAT_FLOOR = Number(opt("floor", "40.737"));
const GRAPH = opt("graph", "");
const LAYOUT = opt("layout", "auto"); // auto | stack | none
const QUANTIZE = opt("quantize", "on") !== "off";
const MINBODY = Number(opt("minbody", "1100"));
const GAP = Number(opt("gap", "0.12"));     // vertical gap between stacked bodies, fraction of the tallest body
const SHIFT = Number(opt("shift", "0"));    // horizontal offset of smaller bodies toward the link side, fraction of the widest body
const [LAT0, LAT1] = opt("lat", "40.735,40.80").split(",").map(Number);
const [LNG0, LNG1] = opt("lng", "-74.005,-73.945").split(",").map(Number);
const JUDGE = !argv.includes("--nojudge");
const AUTO_ROT = opt("rots", "auto") === "auto";
const ROTS = AUTO_ROT ? [0] : opt("rots", "-29").split(",").map(Number);
const OUT = path.join(process.cwd(), "tmp-painter", NAME);
const BOX = 320;

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------
const M_PER_LAT = 111320;
const mPerLng = (lat: number) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);
function meters(a: LatLng, b: LatLng): number {
  return Math.hypot((b[0] - a[0]) * M_PER_LAT, (b[1] - a[1]) * mPerLng(a[0]));
}
function distToSeg(p: LatLng, a: LatLng, b: LatLng): number {
  const px = (p[1] - a[1]) * mPerLng(a[0]);
  const py = (p[0] - a[0]) * M_PER_LAT;
  const bx = (b[1] - a[1]) * mPerLng(a[0]);
  const by = (b[0] - a[0]) * M_PER_LAT;
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by || 1)));
  return Math.hypot(px - t * bx, py - t * by);
}
const CELL = 0.003;
function nearestNode(g: Graph, p: LatLng): { id: number; d: number } {
  let best = -1, bd = Infinity;
  const clat = Math.round(p[0] / CELL), clng = Math.round(p[1] / CELL);
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
        const m = meters(p, g.coord[id]!);
        if (m < bd) { bd = m; best = id; }
      }
  return { id: best, d: bd };
}
function pathKm(chain: LatLng[]): number {
  let m = 0;
  for (let i = 1; i < chain.length; i++) m += meters(chain[i - 1]!, chain[i]!);
  return m / 1000;
}

// Central Park (grid-rotated rectangle): every figure that wandered in died.
const PARK: LatLng[] = [[40.7638, -73.9722], [40.7676, -73.9828], [40.8010, -73.9585], [40.7973, -73.9482]];
function inPoly(p: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i]![0], xi = poly[i]![1], yj = poly[j]![0], xj = poly[j]![1];
    if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Dominant street axis near a point (degrees east of north, in [0,90)), from edge bearings within ~700 m. */
function localGridInfo(g: Graph, c: LatLng): { rot: number; axis: number; uniform: number } | null {
  const bins = new Float64Array(90);
  const clat = Math.round(c[0] / CELL), clng = Math.round(c[1] / CELL);
  let total = 0;
  for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
    for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
      for (const { to, w } of g.adj[id]!) {
        if (to < id || w < 40) continue;
        const a = g.coord[id]!, b = g.coord[to]!;
        const dx = (b[1] - a[1]) * mPerLng(a[0]), dy = (b[0] - a[0]) * M_PER_LAT;
        let deg = (Math.atan2(dx, dy) * 180) / Math.PI; // east of north
        deg = ((deg % 90) + 90) % 90;
        bins[Math.floor(deg)] += w; total += w;
      }
    }
  }
  if (total < 3000) return null;
  let best = 0;
  for (let i = 0; i < 90; i++) { const v = bins[(i + 89) % 90]! + bins[i]! + bins[(i + 1) % 90]!; if (v > best) { best = v; var bi = i; } }
  const axis = bi!; // one axis at `axis` deg east of north, the other at axis+90
  let near = 0;
  for (let i = 0; i < 90; i++) { const d = Math.min(Math.abs(i - axis), 90 - Math.abs(i - axis)); if (d <= 6) near += bins[i]!; }
  // pick the axis closest to north for the shape's "up"
  const up = axis <= 45 ? axis : axis - 90;
  return { rot: -up, axis, uniform: near / total }; // place() rotates counter-clockwise; up-vector (0,1) lands at `up` deg east of north
}
function localGridRot(g: Graph, c: LatLng): number | null {
  return localGridInfo(g, c)?.rot ?? null;
}

// binary heap for Dijkstra / A*
class Heap {
  a: { k: number; v: number }[] = [];
  push(k: number, v: number) {
    const a = this.a; a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p]!.k <= a[i]!.k) break; [a[p], a[i]] = [a[i]!, a[p]!]; i = p; }
  }
  pop(): { k: number; v: number } | undefined {
    const a = this.a; if (!a.length) return undefined;
    const top = a[0]!; const last = a.pop()!;
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < a.length && a[l]!.k < a[m]!.k) m = l; if (r < a.length && a[r]!.k < a[m]!.k) m = r;
      if (m === i) break; [a[m], a[i]] = [a[i]!, a[m]!]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

/** Plain shortest walk between two nodes (connectors). */
function walk(g: Graph, a: number, b: number, maxM = 6000, painted?: Set<number>): number[] | null {
  if (a < 0 || b < 0) return null;
  const ekey = (u: number, v: number) => (u < v ? u * 200000 + v : v * 200000 + u);
  if (a === b) return [a];
  const dist = new Map<number, number>([[a, 0]]);
  const came = new Map<number, number>();
  const h = new Heap(); h.push(meters(g.coord[a]!, g.coord[b]!), a);
  const done = new Set<number>();
  while (h.size) {
    const { v: cur } = h.pop()!;
    if (done.has(cur)) continue;
    done.add(cur);
    if (cur === b) {
      const out = [b]; let c = b;
      while (came.has(c)) { c = came.get(c)!; out.push(c); }
      return out.reverse();
    }
    const dc = dist.get(cur)!;
    if (dc > maxM) return null;
    for (const { to, w } of g.adj[cur]!) {
      const nd = dc + (painted && painted.has(ekey(cur, to)) ? w * 0.12 : w);
      if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); came.set(to, cur); h.push(nd + 0.12 * meters(g.coord[to]!, g.coord[b]!), to); }
    }
  }
  return null;
}

/** Straight street run between two nodes hugging segment a-b (hatch rows). */
function straightRun(g: Graph, a: number, b: number, segA: LatLng, segB: LatLng, corridorM: number, lambda = 20, bendW = 80): number[] | null {
  if (a < 0 || b < 0) return null;
  const target = g.coord[b]!;
  const key = (p: number, c: number) => p * 200000 + c;
  const gs = new Map<number, number>([[key(-1 + 200000, a), 0]]);
  const came = new Map<number, number>();
  const h = new Heap(); h.push(meters(g.coord[a]!, target), key(-1 + 200000, a));
  const done = new Set<number>();
  let guard = 0;
  while (h.size && guard++ < 200000) {
    const { v: ck } = h.pop()!;
    if (done.has(ck)) continue;
    done.add(ck);
    const cur = ck % 200000, prev = Math.floor(ck / 200000) - 200000;
    if (cur === b) {
      const ids = [cur]; let k = ck;
      while (came.has(k)) { k = came.get(k)!; ids.push(k % 200000); }
      return ids.reverse();
    }
    for (const { to, w } of g.adj[cur]!) {
      const cto = g.coord[to]!;
      const dc = distToSeg(cto, segA, segB);
      if (dc > corridorM) continue;
      let bend = 0;
      if (prev >= 0) {
        const i1 = [(g.coord[cur]![1] - g.coord[prev]![1]) * mPerLng(cto[0]), (g.coord[cur]![0] - g.coord[prev]![0]) * M_PER_LAT];
        const o1 = [(cto[1] - g.coord[cur]![1]) * mPerLng(cto[0]), (cto[0] - g.coord[cur]![0]) * M_PER_LAT];
        const n1 = Math.hypot(i1[0]!, i1[1]!) || 1, n2 = Math.hypot(o1[0]!, o1[1]!) || 1;
        const dot = (i1[0]! * o1[0]! + i1[1]! * o1[1]!) / (n1 * n2);
        bend = (1 - dot) * bendW;
      }
      const nk = key(cur + 200000, to);
      const t = gs.get(ck)! + w + lambda * dc + bend;
      if (t < (gs.get(nk) ?? Infinity)) { gs.set(nk, t); came.set(nk, ck); h.push(t + meters(cto, target), nk); }
    }
  }
  return null;
}

async function loadPackedGraph(file: string): Promise<Graph> {
  const data = JSON.parse(await fs.readFile(file, "utf8")) as { scale: number; lat: number[]; lng: number[]; edges: number[] };
  const n = data.lat.length;
  const coord: LatLng[] = new Array(n);
  for (let i = 0; i < n; i++) coord[i] = [data.lat[i]! / data.scale, data.lng[i]! / data.scale];
  const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < data.edges.length; e += 2) {
    const a = data.edges[e]!, b = data.edges[e + 1]!;
    const w = meters(coord[a]!, coord[b]!);
    adj[a]!.push({ to: b, w }); adj[b]!.push({ to: a, w });
  }
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(coord[i]![0] / CELL)}:${Math.round(coord[i]![1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  }
  return { coord, adj, grid };
}

// ---------------------------------------------------------------------------
// mask
// ---------------------------------------------------------------------------
async function loadMask(file: string, mode: string): Promise<{ mask: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(file)
    .resize(BOX, BOX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, a = data[i * 4 + 3]!;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let ink = false;
    if (mode === "blue") ink = a > 128 && b > 60 && b > r * 1.25 && b > g * 1.25;
    else if (mode === "dark") ink = a > 128 && lum < 110;
    else ink = a > 128 && lum < 200;
    if (ink) mask[i] = 255;
  }
  return { mask, w, h };
}
function erode(src: Uint8Array, w: number, h: number, rounds: number): Uint8Array {
  let cur = new Uint8Array(src);
  for (let r = 0; r < rounds; r++) {
    const next = new Uint8Array(cur);
    for (let i = 0; i < w * h; i++) {
      if (cur[i] !== 255) continue;
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || cur[i - 1] !== 255 || cur[i + 1] !== 255 || cur[i - w] !== 255 || cur[i + w] !== 255) next[i] = 0;
    }
    cur = next;
  }
  return cur;
}
function dilate(src: Uint8Array, w: number, h: number, rounds: number, limit?: Uint8Array): Uint8Array {
  let cur = new Uint8Array(src);
  for (let r = 0; r < rounds; r++) {
    const next = new Uint8Array(cur);
    for (let i = 0; i < w * h; i++) {
      if (cur[i] === 255) continue;
      if (limit && limit[i] !== 255) continue;
      const x = i % w, y = (i / w) | 0;
      if ((x > 0 && cur[i - 1] === 255) || (x < w - 1 && cur[i + 1] === 255) || (y > 0 && cur[i - w] === 255) || (y < h - 1 && cur[i + w] === 255)) next[i] = 255;
    }
    cur = next;
  }
  return cur;
}
function components(src: Uint8Array, w: number, h: number): number[][] {
  const seen = new Uint8Array(w * h);
  const comps: number[][] = [];
  for (let s = 0; s < w * h; s++) {
    if (src[s] !== 255 || seen[s]) continue;
    const comp: number[] = []; const st = [s]; seen[s] = 1;
    while (st.length) {
      const p = st.pop()!; comp.push(p);
      const x = p % w, y = (p / w) | 0;
      const nb = [];
      if (x > 0) nb.push(p - 1); if (x < w - 1) nb.push(p + 1); if (y > 0) nb.push(p - w); if (y < h - 1) nb.push(p + w);
      for (const q of nb) if (src[q] === 255 && !seen[q]) { seen[q] = 1; st.push(q); }
    }
    comps.push(comp);
  }
  return comps;
}
function rdp(pts: UnitPt[], eps: number): UnitPt[] {
  if (pts.length < 3) return pts;
  const d2 = (p: UnitPt, a: UnitPt, b: UnitPt) => {
    const bx = b[0] - a[0], by = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * bx + (p[1] - a[1]) * by) / (bx * bx + by * by || 1)));
    return Math.hypot(p[0] - a[0] - t * bx, p[1] - a[1] - t * by);
  };
  let idx = -1, md = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = d2(pts[i]!, pts[0]!, pts[pts.length - 1]!); if (d > md) { md = d; idx = i; } }
  if (md > eps) return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  return [pts[0]!, pts[pts.length - 1]!];
}

// ---------------------------------------------------------------------------
// plan: mask -> strokes (unit space, y up, up = avenue direction)
// ---------------------------------------------------------------------------
type Plan = { strokes: Stroke[]; massPx: number; thinPx: number; mPerPx: number; span: number; cx: number; cy: number };

function makePlan(mask: Uint8Array, w: number, h: number, scaleM: number, pitchM: number, extraThin: [number, number][][] = []): Plan {
  // bbox -> unit frame
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let i = 0; i < w * h; i++) if (mask[i] === 255) { const x = i % w, y = (i / w) | 0; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const mPerPx = (2 * scaleM) / span;
  const toUnit = (x: number, y: number): UnitPt => [((x - cx) * 2) / span, ((cy - y) * 2) / span];

  // mass = opening at ~70 m radius; thin = the rest
  const rPx = Math.max(1, Math.round(OPEN_M / mPerPx));
  let mass = dilate(erode(mask, w, h, rPx), w, h, rPx, mask);
  // small mass blobs (< 30% of the biggest, or under ~250 m square) are not
  // slabs: hand them to the centerline pass instead of drawing ring fragments
  const minMassPx = (250 / mPerPx) ** 2;
  const compsAll = components(mass, w, h);
  const biggestAll = Math.max(1, ...compsAll.map((c) => c.length));
  for (const c of compsAll) if (c.length < minMassPx || c.length < 0.12 * biggestAll) for (const p of c) mass[p] = 0;
  const massGrown = dilate(mass, w, h, 2);
  const thin = new Uint8Array(w * h);
  let massPx = 0, thinPx = 0;
  for (let i = 0; i < w * h; i++) { if (mass[i] === 255) massPx++; if (mask[i] === 255 && massGrown[i] !== 255) { thin[i] = 255; thinPx++; } }

  const strokes: Stroke[] = [];
  // outline rings of mass (d3 marching squares, pixel coords y down)
  const cg = d3.contours().size([w, h]);
  const [cont] = cg.thresholds([128])(Array.from(mass));
  const rings: { ring: UnitPt[]; hole: boolean; area: number; top: number }[] = [];
  if (cont) for (const poly of cont.coordinates) poly.forEach((ring, ri) => {
    const u = rdp(ring.map(([x, y]) => toUnit(x, y)), 1.2 * (2 / span));
    let perim = 0; for (let i = 1; i < u.length; i++) perim += Math.hypot(u[i]![0] - u[i - 1]![0], u[i]![1] - u[i - 1]![1]);
    if (perim * scaleM < 250 || u.length < 4) return;
    let area = 0; for (let i = 1; i < u.length; i++) area += u[i - 1]![0] * u[i]![1] - u[i]![0] * u[i - 1]![1];
    rings.push({ ring: u, hole: ri > 0, area: Math.abs(area), top: Math.max(...u.map((p) => p[1])) });
  });

  // hatch rows per mass component (rows are horizontal in unit space = cross streets on the map)
  const pitchPx = pitchM / mPerPx;
  const minRunPx = 300 / mPerPx;
  const massComps = components(mass, w, h).filter((c) => c.length >= minMassPx);
  const biggest = Math.max(1, ...massComps.map((c) => c.length));
  // group: for each component, outline ring(s) + hatch rows, in reading order (left→right by centroid)
  const groups = massComps.map((c) => {
    let sx = 0, sy = 0, my0 = h, my1 = 0, mx0 = w, mx1 = 0;
    for (const p of c) { const x = p % w, y = (p / w) | 0; sx += x; sy += y; if (y < my0) my0 = y; if (y > my1) my1 = y; if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; }
    const set = new Uint8Array(w * h); for (const p of c) set[p] = 255;
    const rows: UnitPt[][] = [];
    // sparse brush: ~ROWS rows per mass, never denser than PITCH_M
    const massPitchPx = Math.max(pitchPx, (my1 - my0) / ROWS);
    if ((my1 - my0) * mPerPx < 1.6 * pitchM || c.length < 0.3 * biggest) return { cx: 0, cy: 0, rings: [] as typeof rings, rows, comp: c };
    for (let y = my0 + massPitchPx / 2; y < my1; y += massPitchPx) {
      const yy = Math.round(y);
      const runs: UnitPt[][] = [];
      let x0 = -1;
      for (let x = 0; x <= w; x++) {
        const on = x < w && set[yy * w + x] === 255;
        if (on && x0 < 0) x0 = x;
        if (!on && x0 >= 0) { if (x - x0 >= Math.max(minRunPx, 0.45 * (mx1 - mx0))) runs.push([toUnit(x0 + 1, yy), toUnit(x - 2, yy)]); x0 = -1; }
      }
      if (runs.length) rows.push(...(rows.length % 2 ? runs.reverse().map((r) => [r[1]!, r[0]!]) : runs));
    }
    const cxu = sx / c.length, cyu = sy / c.length;
    return { cx: cxu, cy: cyu, rings: [] as typeof rings, rows, comp: c, set: dilate(set, w, h, 3) };
  }).map((grp) => {
    if (grp.rings.length || grp.cx) return grp;
    // small mass that skipped hatching: still needs its ring(s)
    let sx = 0, sy = 0; for (const p of grp.comp) { sx += p % w; sy += (p / w) | 0; }
    const set = new Uint8Array(w * h); for (const p of grp.comp) set[p] = 255;
    return { ...grp, cx: sx / grp.comp.length, cy: sy / grp.comp.length, set: dilate(set, w, h, 3) };
  }).sort((a, b) => a.cx - b.cx);

  // assign every ring to the component that contains most of its points
  for (const r of rings) {
    let bi = 0, bc = -1;
    groups.forEach((grp, gi) => {
      let n = 0;
      for (const p of r.ring) { const px = Math.round(cx + (p[0] * span) / 2), py = Math.round(cy - (p[1] * span) / 2); if (px >= 0 && py >= 0 && px < w && py < h && grp.set![py * w + px] === 255) n++; }
      if (n > bc) { bc = n; bi = gi; }
    });
    if (groups[bi]) groups[bi]!.rings.push(r);
  }

  groups.forEach((grp, gi) => {
    for (const r of grp.rings.filter((r) => !r.hole)) strokes.push({ kind: "outline", pts: r.ring, closed: true, group: gi });
    for (const row of grp.rows) strokes.push({ kind: "hatch", pts: row, closed: false, group: gi });
    // holes smaller than ~300 m square are clutter at block resolution (gap between arm and head)
    for (const r of grp.rings.filter((r) => r.hole && r.area * scaleM * scaleM > 300 * 300)) strokes.push({ kind: "outline", pts: r.ring, closed: true, group: gi });
  });

  const ringPts: UnitPt[] = strokes.filter((s) => s.kind === "outline").flatMap((s) => s.pts);
  const hugsRing = (pts: UnitPt[]) => {
    if (!ringPts.length) return false;
    const tol = 165 / scaleM; // ~1.5 short blocks in unit space
    let near = 0;
    for (const p of pts) { let m = Infinity; for (const q of ringPts) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < m) m = d; } if (m < tol) near++; }
    return near / pts.length > 0.8;
  };
  for (const pl of extraThin) {
    const u = rdp(pl.map(([x, y]) => toUnit(x, y)), 1.5 * (2 / span));
    if (u.length >= 2) strokes.push({ kind: "thin", pts: u, closed: false, link: true });
  }
  // thin strokes: skeleton centerlines of the residue
  if (thinPx > 0) {
    const polys = centerlinePolylinesFromLineMask(thin, w, h);
    for (const pl of polys) {
      const u = rdp(pl.map(([x, y]) => toUnit(x, y)), 1.5 * (2 / span));
      let len = 0; for (let i = 1; i < u.length; i++) len += Math.hypot(u[i]![0] - u[i - 1]![0], u[i]![1] - u[i - 1]![1]);
      if (len * scaleM < 260) continue;
      const dense: UnitPt[] = [];
      for (let i = 1; i < u.length; i++) { const n = Math.max(1, Math.round((Math.hypot(u[i]![0] - u[i - 1]![0], u[i]![1] - u[i - 1]![1]) * scaleM) / 60)); for (let k = 0; k < n; k++) dense.push([u[i - 1]![0] + ((u[i]![0] - u[i - 1]![0]) * k) / n, u[i - 1]![1] + ((u[i]![1] - u[i - 1]![1]) * k) / n]); }
      if (hugsRing(dense)) continue;
      strokes.push({ kind: "thin", pts: u, closed: false });
    }
  }
  return { strokes, massPx, thinPx, mPerPx, span, cx, cy };
}

// ---------------------------------------------------------------------------
// re-layout: split a logo into bodies joined by thin links (pump —hose— figure),
// stack the bodies upright along the grid's long axis, redraw each link as a
// similarity copy of itself between the moved attachment points.
// ---------------------------------------------------------------------------
type Layout = { mask: Uint8Array; w: number; h: number; links: [number, number][][]; bodies: number; smallestBodyWidthPx: number };

function relayout(mask: Uint8Array, w: number, h: number, mode: "stack" | "keep" = "stack"): Layout | null {
  let ink = 0; for (let i = 0; i < w * h; i++) if (mask[i] === 255) ink++;
  const r = Math.max(3, Math.round(Math.sqrt(ink) / 20));
  const core = dilate(erode(mask, w, h, r), w, h, r, mask);
  const bodiesRaw = components(core, w, h).filter((c) => c.length >= ink * 0.04);
  if (bodiesRaw.length < 2) return null;
  // label every ink pixel with its nearest body (multi-source BFS over ink)
  const label = new Int32Array(w * h).fill(-1);
  const queue: number[] = [];
  bodiesRaw.forEach((c, bi) => { for (const p of c) { label[p] = bi; queue.push(p); } });
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!, x = p % w, y = (p / w) | 0;
    const nb: number[] = [];
    if (x > 0) nb.push(p - 1); if (x < w - 1) nb.push(p + 1); if (y > 0) nb.push(p - w); if (y < h - 1) nb.push(p + w);
    for (const q of nb) if (mask[q] === 255 && label[q] < 0) { label[q] = label[p]!; queue.push(q); }
  }
  // residue components touching >=2 bodies are links
  const residue = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i] === 255 && core[i] !== 255) residue[i] = 255;
  const linkPx = new Uint8Array(w * h);
  const linkComps: number[][] = [];
  for (const c of components(residue, w, h)) {
    const touched = new Set<number>();
    for (const p of c) {
      const x = p % w, y = (p / w) | 0;
      const nb: number[] = [];
      if (x > 0) nb.push(p - 1); if (x < w - 1) nb.push(p + 1); if (y > 0) nb.push(p - w); if (y < h - 1) nb.push(p + w);
      for (const q of nb) if (core[q] === 255) touched.add(label[q]!);
    }
    if (touched.size >= 2 && c.length > 30) { linkComps.push(c); for (const p of c) linkPx[p] = 255; }
  }
  // body pixel sets (core + own residue, minus links) and boxes
  const bodies = bodiesRaw.map(() => ({ px: [] as number[], x0: w, x1: 0, y0: h, y1: 0 }));
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 255 || linkPx[i] === 255 || label[i] < 0) continue;
    const b = bodies[label[i]!]!; b.px.push(i);
    const x = i % w, y = (i / w) | 0;
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  }
  // link contacts (in the original frame) — needed before layout to decide mirroring
  type Contact = { ba: number; A: [number, number]; bb: number; B: [number, number] };
  const contacts: Contact[] = [];
  for (const c of linkComps) {
    const contact = new Map<number, { x: number; y: number; n: number }>();
    for (const p of c) {
      const x = p % w, yy = (p / w) | 0;
      const nb: number[] = [];
      if (x > 0) nb.push(p - 1); if (x < w - 1) nb.push(p + 1); if (yy > 0) nb.push(p - w); if (yy < h - 1) nb.push(p + w);
      for (const q of nb) if (core[q] === 255) { const bi = label[q]!; const e = contact.get(bi) ?? { x: 0, y: 0, n: 0 }; e.x += x; e.y += yy; e.n++; contact.set(bi, e); }
    }
    const tb = [...contact.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 2);
    if (tb.length < 2) continue;
    contacts.push({ ba: tb[0]![0], A: [tb[0]![1].x / tb[0]![1].n, tb[0]![1].y / tb[0]![1].n], bb: tb[1]![0], B: [tb[1]![1].x / tb[1]![1].n, tb[1]![1].y / tb[1]![1].n] });
  }
  // mirror the smaller body when a link attaches on opposite sides of its two bodies
  const mirror = bodies.map(() => false);
  for (const k of contacts) {
    const cA = (bodies[k.ba]!.x0 + bodies[k.ba]!.x1) / 2, cB = (bodies[k.bb]!.x0 + bodies[k.bb]!.x1) / 2;
    const sA = Math.sign(k.A[0] - cA), sB = Math.sign(k.B[0] - cB);
    if (sA && sB && sA !== sB) { const small = bodies[k.ba]!.px.length < bodies[k.bb]!.px.length ? k.ba : k.bb; mirror[small] = true; }
  }
  if (mode === "keep") {
    // bodies stay put; links become their own skeleton polylines (organic strokes that may cross parks)
    const mask2 = new Uint8Array(w * h);
    for (const b of bodies) for (const p of b.px) mask2[p] = 255;
    const links: [number, number][][] = [];
    for (const c of linkComps) {
      const lm = new Uint8Array(w * h); for (const p of c) lm[p] = 255;
      const polys = centerlinePolylinesFromLineMask(lm, w, h).sort((a, b) => b.length - a.length);
      const pl = polys[0]; if (!pl || pl.length < 4) continue;
      // the Eulerian walk doubles back over the loop; keep the first half (one pass)
      links.push(pl.slice(0, Math.ceil(pl.length / 2) + 1) as [number, number][]);
    }
    const smallestBodyWidthPx = Math.min(...bodies.map((b) => b.x1 - b.x0 + 1));
    return { mask: mask2, w, h, links, bodies: bodies.length, smallestBodyWidthPx };
  }
  const mx = (bi: number, x: number) => (mirror[bi] ? bodies[bi]!.x0 + bodies[bi]!.x1 - x : x);
  const order = bodies.map((b, i) => i).sort((a, b) => (bodies[a]!.x0 + bodies[a]!.x1) - (bodies[b]!.x0 + bodies[b]!.x1));
  const maxW = Math.max(...bodies.map((b) => b.x1 - b.x0 + 1));
  const maxH = Math.max(...bodies.map((b) => b.y1 - b.y0 + 1));
  const gap = Math.round(maxH * GAP);
  const margin = 12;
  const margin2 = Math.round(maxW * (0.25 + SHIFT)) + 12;
  const w2 = maxW + 2 * margin2;
  const h2 = bodies.reduce((sum, b) => sum + (b.y1 - b.y0 + 1), 0) + gap * (bodies.length - 1) + 2 * margin;
  const mask2 = new Uint8Array(w2 * h2);
  const offset: [number, number][] = bodies.map(() => [0, 0]);
  let y = margin;
  for (const bi of order) {
    const b = bodies[bi]!;
    // smaller bodies slide toward the side their link leaves the widest body from
    let shiftPx = 0;
    if (SHIFT && (b.x1 - b.x0) < maxW * 0.9) {
      const k = contacts.find((c) => c.ba === bi || c.bb === bi);
      if (k) { const other = k.ba === bi ? k.bb : k.ba; const pt = k.ba === bi ? k.B : k.A; const cxo = (bodies[other]!.x0 + bodies[other]!.x1) / 2; shiftPx = Math.round(Math.sign(mx(other, pt[0]) - cxo) * SHIFT * maxW); }
    }
    const dx = margin2 + Math.round((maxW - (b.x1 - b.x0 + 1)) / 2) - b.x0 + shiftPx;
    const dy = y - b.y0;
    offset[bi] = [dx, dy];
    for (const p of b.px) { const x = mx(bi, p % w), yy = (p / w) | 0; mask2[(yy + dy) * w2 + (x + dx)] = 255; }
    y += (b.y1 - b.y0 + 1) + gap;
  }
  // links: fresh arcs between the moved attachment points, bulging away from the widest body
  const links: [number, number][][] = [];
  const widest = bodies.map((b, i) => i).sort((a, b) => (bodies[b]!.x1 - bodies[b]!.x0) - (bodies[a]!.x1 - bodies[a]!.x0))[0]!;
  for (const k of contacts) {
    const A2: [number, number] = [mx(k.ba, k.A[0]) + offset[k.ba]![0], k.A[1] + offset[k.ba]![1]];
    const B2: [number, number] = [mx(k.bb, k.B[0]) + offset[k.bb]![0], k.B[1] + offset[k.bb]![1]];
    const ref = k.ba === widest ? A2 : k.bb === widest ? B2 : A2;
    const cxW = (bodies[widest]!.x0 + bodies[widest]!.x1) / 2 + offset[widest]![0];
    const side = ref[0] >= cxW ? 1 : -1;
    const dist = Math.hypot(B2[0] - A2[0], B2[1] - A2[1]);
    const bulge = Math.max(0.2 * dist, maxW * 0.2);
    const c1: [number, number] = [A2[0] + side * bulge, A2[1] + 0.2 * (B2[1] - A2[1])];
    const c2: [number, number] = [B2[0] + side * bulge, B2[1] - 0.2 * (B2[1] - A2[1])];
    const arc: [number, number][] = [];
    for (let t = 0; t <= 1.0001; t += 1 / 24) {
      const u = 1 - t;
      arc.push([u * u * u * A2[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * B2[0], u * u * u * A2[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * B2[1]]);
    }
    links.push(arc);
  }
  const smallestBodyWidthPx = Math.min(...bodies.map((b) => b.x1 - b.x0 + 1));
  return { mask: mask2, w: w2, h: h2, links, bodies: bodies.length, smallestBodyWidthPx };
}

// ---------------------------------------------------------------------------
// stroke order: each body (outline + hatch + holes) is one unit drawn in a fixed
// internal order; thin strokes/links are units that may be reversed. Units are
// toured in the order that minimizes straight-line connector length
// (exhaustive for <= 8 units, greedy beyond).
// ---------------------------------------------------------------------------
type Unit = { strokes: Stroke[]; body: boolean };

function rotateRing(pts: UnitPt[], pen: UnitPt): UnitPt[] {
  let k = 0, kd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) { const dd = Math.hypot(pen[0] - pts[i]![0], pen[1] - pts[i]![1]); if (dd < kd) { kd = dd; k = i; } }
  const ring = pts.slice(0, -1);
  const rot = [...ring.slice(k), ...ring.slice(0, k)]; rot.push(rot[0]!);
  return rot;
}
/** lay a unit down from the pen; returns the concrete strokes and the pen after */
function layUnit(u: Unit, pen: UnitPt | null, reverse: boolean): { out: Stroke[]; end: UnitPt; start: UnitPt } {
  const out: Stroke[] = [];
  let p = pen;
  let start: UnitPt | null = null;
  const list = u.body ? u.strokes : u.strokes.slice();
  for (const s of list) {
    let pts = s.pts;
    if (s.closed) { if (p) pts = rotateRing(pts, p); }
    else if (!u.body && reverse) pts = pts.slice().reverse();
    else if (!u.body && p) { const d0 = Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]), d1 = Math.hypot(p[0] - pts[pts.length - 1]![0], p[1] - pts[pts.length - 1]![1]); if (d1 < d0) pts = pts.slice().reverse(); }
    if (!start) start = pts[0]!;
    out.push({ ...s, pts });
    p = pts[pts.length - 1]!;
  }
  return { out, end: p!, start: start! };
}
function orderStrokes(strokes: Stroke[]): Stroke[] {
  const units: Unit[] = [];
  const byGroup = new Map<number, Stroke[]>();
  for (const s of strokes) {
    if (s.group !== undefined) { if (!byGroup.has(s.group)) byGroup.set(s.group, []); byGroup.get(s.group)!.push(s); }
    else units.push({ strokes: [s], body: false });
  }
  for (const [, list] of byGroup) units.unshift({ strokes: list, body: true });
  const d = (a: UnitPt, b: UnitPt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const tourCost = (order: number[]): { cost: number; out: Stroke[] } => {
    let pen: UnitPt | null = null, cost = 0;
    const out: Stroke[] = [];
    for (const ui of order) {
      const u = units[ui]!;
      let best = layUnit(u, pen, false);
      if (!u.body) { const alt = layUnit(u, pen, true); if (pen && d(pen, alt.start) < d(pen, best.start)) best = alt; }
      if (pen) cost += d(pen, best.start);
      out.push(...best.out);
      pen = best.end;
    }
    return { cost, out };
  };
  const n = units.length;
  let bestOrder: number[] | null = null, bestCost = Infinity;
  if (n <= 8) {
    const perm = (arr: number[], rest: number[]) => {
      if (!rest.length) { const c = tourCost(arr).cost; if (c < bestCost) { bestCost = c; bestOrder = arr.slice(); } return; }
      for (let i = 0; i < rest.length; i++) perm([...arr, rest[i]!], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    };
    perm([], units.map((_, i) => i));
  } else {
    const order: number[] = [0]; const left = new Set(units.map((_, i) => i).slice(1));
    while (left.size) { let bi = -1, bc = Infinity; for (const j of left) { const c = tourCost([...order, j]).cost; if (c < bc) { bc = c; bi = j; } } order.push(bi); left.delete(bi); }
    bestOrder = order;
  }
  return tourCost(bestOrder!).out;
}

// ---------------------------------------------------------------------------
// block lattice: measure the local street pitches and snap stroke vertices
// onto street lines so straight edges become exact street runs
// ---------------------------------------------------------------------------
type Lattice = { center: LatLng; rot: number; pA: number; pS: number; x0: number; y0: number; xLines: number[]; yLines: number[] };

/** local frame: x along the street axis (east when rot=0), y along the avenue axis (north when rot=0) */
function toLocal(p: LatLng, center: LatLng, rot: number): [number, number] {
  const ex = (p[1] - center[1]) * mPerLng(center[0]), ny = (p[0] - center[0]) * M_PER_LAT;
  const r = (-rot * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
  return [ex * c - ny * sn, ex * sn + ny * c];
}
function fromLocal(q: [number, number], center: LatLng, rot: number): LatLng {
  const r = (rot * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
  const ex = q[0] * c - q[1] * sn, ny = q[0] * sn + q[1] * c;
  return [center[0] + ny / M_PER_LAT, center[1] + ex / mPerLng(center[0])];
}
function medianGap(vals: number[]): number {
  // cluster intersection positions into street lines, keep the strong lines, median gap between them
  const v = vals.slice().sort((a, b) => a - b);
  const clusters: { pos: number; n: number }[] = [];
  for (const x of v) {
    const c = clusters[clusters.length - 1];
    if (c && x - c.pos / c.n < 25) { c.pos += x; c.n++; } else clusters.push({ pos: x, n: 1 });
  }
  const counts = clusters.map((c) => c.n).sort((a, b) => a - b);
  const strong = clusters.filter((c) => c.n >= Math.max(5, counts[Math.floor(counts.length * 0.5)]! * 0.6)).map((c) => c.pos / c.n);
  const gaps: number[] = [];
  for (let i = 1; i < strong.length; i++) { const d = strong[i]! - strong[i - 1]!; if (d >= 50 && d <= 450) gaps.push(d); }
  if (gaps.length < 2) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}
function streetLines(vals: number[], minCount: number): number[] {
  const v = vals.slice().sort((a, b) => a - b);
  const clusters: { pos: number; n: number }[] = [];
  for (const x of v) {
    const c = clusters[clusters.length - 1];
    if (c && x - c.pos / c.n < 22) { c.pos += x; c.n++; } else clusters.push({ pos: x, n: 1 });
  }
  return clusters.filter((c) => c.n >= minCount).map((c) => c.pos / c.n);
}
function measureLattice(g: Graph, center: LatLng, rot: number, radiusM = 800): Lattice | null {
  // intersections (degree >= 3) within the footprint radius
  const xs: number[] = [], ys: number[] = [];
  const clat = Math.round(center[0] / CELL), clng = Math.round(center[1] / CELL);
  const cells = Math.ceil(radiusM / (CELL * M_PER_LAT)) + 1;
  let nearest = -1, nd = Infinity;
  for (let dr = -cells; dr <= cells; dr++) for (let dc = -cells; dc <= cells; dc++) {
    for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
      if ((g.adj[id]?.length ?? 0) < 3) continue;
      const q = toLocal(g.coord[id]!, center, rot);
      if (Math.abs(q[0]) > radiusM || Math.abs(q[1]) > radiusM) continue;
      xs.push(q[0]); ys.push(q[1]);
      const d = Math.hypot(q[0], q[1]); if (d < nd) { nd = d; nearest = id; }
    }
  }
  if (nearest < 0 || xs.length < 30) return null;
  // lines: avenues are at constant x (crossed while moving along the street axis) -> pitch from xs; streets at constant y
  const pA = medianGap(xs), pS = medianGap(ys);
  if (!pA || !pS) return null;
  const q0 = toLocal(g.coord[nearest]!, center, rot);
  // actual line positions: a line needs intersections along most of its length
  const minCount = Math.max(4, Math.round((radiusM / 400)));
  const xLines = streetLines(xs, Math.max(minCount, Math.round(radiusM / pS / 3)));
  const yLines = streetLines(ys, Math.max(minCount, Math.round(radiusM / pA / 3)));
  return { center, rot, pA, pS, x0: q0[0], y0: q0[1], xLines, yLines };
}
function snapLine(v: number, lines: number[], pitch: number, origin: number): number {
  let best = origin + Math.round((v - origin) / pitch) * pitch, bd = Math.abs(v - best) + pitch * 0.35; // ideal lattice as a fallback, slightly penalized
  for (const l of lines) { const d = Math.abs(v - l); if (d < bd) { bd = d; best = l; } }
  return best;
}
/** snap a placed polyline's vertices to lattice lines; drop repeats and collinear points */
function quantizeTarget(target: LatLng[], L: Lattice, closed: boolean): LatLng[] {
  const q = target.map((p) => {
    const [x, y] = toLocal(p, L.center, L.rot);
    return [snapLine(x, L.xLines, L.pA, L.x0), snapLine(y, L.yLines, L.pS, L.y0)] as [number, number];
  });
  const out: [number, number][] = [];
  for (const v of q) { const last = out[out.length - 1]; if (last && Math.abs(last[0] - v[0]) < 1 && Math.abs(last[1] - v[1]) < 1) continue; out.push(v); }
  // simplify jogs smaller than the block (rounded corners quantize into stair nubs)
  const eps = 0.6 * Math.min(L.pA, L.pS);
  const simp = rdp(out as unknown as UnitPt[], eps) as unknown as [number, number][];
  out.length = 0; out.push(...simp.map((v) => [snapLine(v[0], L.xLines, L.pA, L.x0), snapLine(v[1], L.yLines, L.pS, L.y0)] as [number, number]));
  // remove collinear middles
  const keep: [number, number][] = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[i - 1], b = out[i]!, c = out[i + 1];
    if (a && c) { const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]); if (Math.abs(cross) < 1) continue; }
    keep.push(b);
  }
  if (closed && keep.length > 2) { const f = keep[0]!, l = keep[keep.length - 1]!; if (Math.abs(f[0] - l[0]) > 1 || Math.abs(f[1] - l[1]) > 1) keep.push(f); }
  return keep.map((v) => fromLocal(v, L.center, L.rot));
}

// ---------------------------------------------------------------------------
// route one placement
// ---------------------------------------------------------------------------
const DROPS: string[] = [];
const STROKELOG: string[] = [];
const CONNLOG: string[] = [];
type Routed = { chain: LatLng[]; isInk: boolean[]; km: number; inkKm: number; connectorKm: number; visibleConnKm: number; dropped: number; strokes: number; maxGap: number; devM: number; fidelity: number };

function routePlacement(g: Graph, strokes: Stroke[], center: LatLng, scaleM: number, rot: number): Routed | null {
  const chain: LatLng[] = [];
  const isInk: boolean[] = [];
  let inkM = 0, connM = 0, visM = 0, dropped = 0, maxGap = 0;
  const painted = new Set<number>();
  const ekey = (u: number, v: number) => (u < v ? u * 200000 + v : v * 200000 + u);
  const append = (pts: LatLng[], ink = false) => {
    let prevId = -1;
    for (const p of pts) {
      const last = chain[chain.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      if (last) { const gm = meters(last, p); if (gm > maxGap) maxGap = gm; }
      chain.push(p); isInk.push(ink);
      const id = nearestNode(g, p).id;
      if (ink) { if (prevId >= 0 && id >= 0) painted.add(ekey(prevId, id)); }
      else if (last && prevId >= 0 && id >= 0 && !painted.has(ekey(prevId, id))) visM += meters(last, p);
      prevId = id;
    }
  };
  const targets: [LatLng, LatLng][] = [];
  let footprint = 800;
  for (const s of strokes) for (const p of s.pts) footprint = Math.max(footprint, Math.hypot(p[0], p[1]) * scaleM + 300);
  const L = QUANTIZE ? measureLattice(g, center, rot, footprint) : null;
  const isCurvy = (s: Stroke) => {
    let turn = 0, len = 0;
    for (let i = 1; i < s.pts.length; i++) {
      len += Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]);
      if (i > 1) { const a1 = Math.atan2(s.pts[i - 1]![1] - s.pts[i - 2]![1], s.pts[i - 1]![0] - s.pts[i - 2]![0]), a2 = Math.atan2(s.pts[i]![1] - s.pts[i - 1]![1], s.pts[i]![0] - s.pts[i - 1]![0]); let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d; turn += d; }
    }
    return s.kind === "thin" && (s.link === true || turn / Math.max(0.05, len) > 1.5);
  };
  for (const s of strokes) {
    let target = place(s.pts, center, scaleM, rot);
    const curvyStroke = isCurvy(s);
    if (L && s.kind !== "hatch" && !curvyStroke) {
      // densify so curves get enough vertices, then snap to the lattice
      const dense: LatLng[] = [target[0]!];
      for (let i = 1; i < target.length; i++) {
        const a = target[i - 1]!, b = target[i]!, n = Math.max(1, Math.round(meters(a, b) / 120));
        for (let k = 1; k <= n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
      }
      const qt = quantizeTarget(dense, L, s.closed);
      if (qt.length >= (s.closed ? 4 : 2)) target = qt;
    }
    for (let i = 1; i < target.length; i++) targets.push([target[i - 1]!, target[i]!]);
    let piece: LatLng[] | null = null;
    if (s.kind === "hatch") {
      const a = nearestNode(g, target[0]!), b = nearestNode(g, target[1]!);
      if (a.d < 120 && b.d < 120) {
        let ids = straightRun(g, a.id, b.id, target[0]!, target[1]!, 60);
        if (!ids) ids = straightRun(g, a.id, b.id, target[0]!, target[1]!, 140, 12, 40);
        if (ids) piece = ids.map((i) => g.coord[i]!);
        else { const res = traceContour(g, target, { anchorM: 220, lambda: 30, corridorM: 120, bendWeight: 60, closeLoop: false, preserveRetraces: false }); if (res.chain.length >= 2 && res.coverage > 0.8 && res.maxGapM < 150) piece = res.chain; }
      }
    } else if (L && !curvyStroke) {
      // lattice-quantized: every edge is a straight street run between snapped intersections
      const ids: number[] = [];
      let ok = true;
      for (let i = 1; i < target.length; i++) {
        const a = nearestNode(g, target[i - 1]!), b = nearestNode(g, target[i]!);
        if (a.d > 90 || b.d > 90) { ok = false; break; }
        let run = straightRun(g, a.id, b.id, target[i - 1]!, target[i]!, 50, 24, 90);
        if (!run) run = straightRun(g, a.id, b.id, target[i - 1]!, target[i]!, 120, 12, 40);
        if (!run) run = walk(g, a.id, b.id, meters(target[i - 1]!, target[i]!) * 2.5 + 300);
        if (!run) { ok = false; break; }
        if (ids.length && ids[ids.length - 1] === run[0]) run = run.slice(1);
        ids.push(...run);
      }
      if (ok && ids.length >= 2) piece = ids.map((i) => g.coord[i]!);
    }
    if (!piece && s.kind !== "hatch") {
      // curvy thin strokes (hose, headphones) take the organic dialect; straight ones the grid dialect
      let turn = 0, len = 0;
      for (let i = 1; i < s.pts.length; i++) {
        len += Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]);
        if (i > 1) { const a1 = Math.atan2(s.pts[i - 1]![1] - s.pts[i - 2]![1], s.pts[i - 1]![0] - s.pts[i - 2]![0]), a2 = Math.atan2(s.pts[i]![1] - s.pts[i - 1]![1], s.pts[i]![0] - s.pts[i - 1]![0]); let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d; turn += d; }
      }
      const curvy = s.kind === "thin" && (s.link === true || turn / Math.max(0.05, len) > 1.5); // radians per unit length
      const res = traceContour(g, target, s.kind === "outline"
        ? { anchorM: 200, lambda: 30, corridorM: 65, bendWeight: 60, closeLoop: true, preserveRetraces: false }
        : curvy
          ? { anchorM: 150, lambda: 12, corridorM: 110, bendWeight: 16, closeLoop: false, preserveRetraces: false }
          : { anchorM: 170, lambda: 26, corridorM: 65, bendWeight: 50, closeLoop: false, preserveRetraces: false });
      if (res.chain.length >= 2 && res.coverage > 0.6) {
        // bridge any teleports with real walks
        const fixed: LatLng[] = [res.chain[0]!];
        for (let i = 1; i < res.chain.length; i++) {
          const prev = fixed[fixed.length - 1]!, cur = res.chain[i]!;
          if (meters(prev, cur) > 120) {
            const w = walk(g, nearestNode(g, prev).id, nearestNode(g, cur).id, 3000);
            if (w) fixed.push(...w.map((k) => g.coord[k]!));
          }
          fixed.push(cur);
        }
        piece = fixed;
      }
    }
    STROKELOG.push(`${s.kind}${curvyStroke ? "~" : ""}:${target.length}v->${piece ? piece.length : 0}n`);
    if (!piece || piece.length < 2) { dropped++; DROPS.push(`${s.kind}:${s.pts.length}pts:${(place(s.pts, center, scaleM, rot).reduce((m, p, i, arr) => i ? m + meters(arr[i - 1]!, p) : 0, 0)).toFixed(0)}m`); continue; }
    // connector from pen to piece start
    if (chain.length) {
      const from = nearestNode(g, chain[chain.length - 1]!).id, to = nearestNode(g, piece[0]!).id;
      const w = walk(g, from, to, 5000, painted);
      if (!w) { dropped++; continue; }
      const cpts = w.map((k) => g.coord[k]!);
      connM += pathKm(cpts) * 1000;
      const visBefore = visM;
      append(cpts);
      CONNLOG.push(`${(pathKm(cpts) * 1000).toFixed(0)}m(vis ${(visM - visBefore).toFixed(0)})`);
    }
    inkM += pathKm(piece) * 1000;
    append(piece, true);
  }
  if (chain.length < 10) return null;
  // close the loop only when the way back is short or rides painted streets
  const w = walk(g, nearestNode(g, chain[chain.length - 1]!).id, nearestNode(g, chain[0]!).id, 6000, painted);
  if (w) {
    const cpts = w.map((k) => g.coord[k]!);
    let vis = 0, prevId = -1;
    for (const p of cpts) { const id = nearestNode(g, p).id; if (prevId >= 0 && !painted.has(ekey(prevId, id))) vis += meters(g.coord[prevId]!, g.coord[id]!); prevId = id; }
    if (vis < 600) { connM += pathKm(cpts) * 1000; append(cpts); CONNLOG.push(`close ${(pathKm(cpts) * 1000).toFixed(0)}m(vis ${vis.toFixed(0)})`); }
    else CONNLOG.push(`close skipped (vis ${vis.toFixed(0)})`);
  }
  // fidelity: how far the drawn line strays from the intended strokes
  let dev = 0, n = 0;
  for (let i = 0; i < chain.length; i += 2) {
    let m = Infinity;
    for (const [a, b] of targets) { const d = distToSeg(chain[i]!, a, b); if (d < m) m = d; }
    dev += Math.min(m, 400); n++;
  }
  const devM = dev / Math.max(1, n);
  const fidelity = devM + 60 * (visM / Math.max(1, inkM)) + 25 * dropped;
  return { chain, isInk, km: pathKm(chain), inkKm: inkM / 1000, connectorKm: connM / 1000, visibleConnKm: visM / 1000, dropped, strokes: strokes.length, maxGap, devM, fidelity };
}

// ---------------------------------------------------------------------------
// render + judge
// ---------------------------------------------------------------------------
const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z; };
async function paleRender(chain: LatLng[], file: string): Promise<Buffer> {
  const w = 1300, h = 1100;
  let zoom = 14;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z)), ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.9 && Math.max(...ys) - Math.min(...ys) <= h * 0.9) { zoom = z; break; }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom)), ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: object[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++)
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      try {
        const res = await fetch(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${zoom}/${ty}/${tx}`, { headers: { "User-Agent": "pace-casso route preview (dev)" } });
        if (!res.ok) continue;
        tiles.push({ input: await sharp(Buffer.from(await res.arrayBuffer())).resize(TILE, TILE).toBuffer(), left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
      } catch { /* tile missing */ }
    }
  const d = chain.map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
  const overlay = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="white" stroke-width="11" stroke-linejoin="round" opacity="0.9"/><path d="${d}" fill="none" stroke="#fc5200" stroke-width="5.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`);
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eaeaea" } }).composite([...tiles, { input: overlay, left: 0, top: 0 }]).png().toFile(file);
  return sharp(file).resize({ width: 1400 }).jpeg({ quality: 88 }).toBuffer();
}

async function debugRender(r: Routed, file: string) {
  const w = 1300, h = 1100;
  const chain = r.chain;
  let zoom = 14;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z)), ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.9 && Math.max(...ys) - Math.min(...ys) <= h * 0.9) { zoom = z; break; }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom)), ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const segs: string[] = [];
  for (let i = 1; i < chain.length; i++) {
    const c = r.isInk[i] ? "#fc5200" : "#2266dd";
    segs.push(`<line x1="${(xs[i - 1]! - vx).toFixed(1)}" y1="${(ys[i - 1]! - vy).toFixed(1)}" x2="${(xs[i]! - vx).toFixed(1)}" y2="${(ys[i]! - vy).toFixed(1)}" stroke="${c}" stroke-width="${r.isInk[i] ? 4 : 2.5}" stroke-linecap="round"/>`);
  }
  const svg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="#fff"/>${segs.join("")}</svg>`);
  await sharp(svg).png().toFile(file);
}

async function planSheet(mask: Uint8Array, w: number, h: number, plan: Plan, file: string) {
  const S = 3;
  const px: string[] = [];
  const col = { outline: "#e11", hatch: "#06c", thin: "#0a0" } as const;
  const toPx = (p: UnitPt) => [(plan.cx + (p[0] * plan.span) / 2) * S, (plan.cy - (p[1] * plan.span) / 2) * S];
  for (const s of plan.strokes) {
    const d = s.pts.map((p, i) => { const [x, y] = toPx(p); return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ");
    px.push(`<path d="${d}" fill="none" stroke="${col[s.kind]}" stroke-width="2.5" stroke-linejoin="round"/>`);
  }
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { const v = mask[i] === 255 ? 200 : 255; raw[i * 3] = v; raw[i * 3 + 1] = v; raw[i * 3 + 2] = v; }
  const base = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).resize(w * S, h * S, { kernel: "nearest" }).png().toBuffer();
  const svg = Buffer.from(`<svg width="${w * S}" height="${h * S}" xmlns="http://www.w3.org/2000/svg">${px.join("")}</svg>`);
  await sharp(base).composite([{ input: svg, left: 0, top: 0 }]).png().toFile(file);
}

let KEY = "";
async function claude(content: unknown[], maxTokens = 2500): Promise<string> {
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-fable-5", max_tokens: maxTokens, messages: [{ role: "user", content }] }),
      });
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 4000 * (a + 1))); continue; }
      const j = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
    } catch { await new Promise((r) => setTimeout(r, 4000 * (a + 1))); }
  }
  return "";
}
async function judge(renderJpg: Buffer, upload: string) {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: renderJpg.toString("base64") } };
  const cold: { guess: string; conf: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await claude([img, { type: "text", text: "The orange line is a GPS route someone recorded while running; they were trying to draw a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words, or \"nothing recognizable\">\nCONFIDENCE: <0-10>" }]);
    const guess = (t.match(/GUESS\**:?\**\s*(.+?)\s*(?:\n|\*|CONFIDENCE|$)/i)?.[1] ?? "").trim();
    if (!guess) console.log("   [judge raw] " + t.replace(/\s+/g, " ").slice(0, 160));
    cold.push({ guess: guess || "?", conf: Number(t.match(/CONFIDENCE\**:?\**\s*(\d+)/i)?.[1] ?? 0) });
  }
  const up = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(upload).flatten({ background: "#fff" }).resize({ width: 700 }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
  const like: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await claude([up, img, { type: "text", text: "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as an orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1 to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color or background. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>" }]);
    like.push(Number(t.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
  }
  return { cold, like };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  await fs.mkdir(OUT, { recursive: true });
  try { KEY = (await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8")).match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? ""; } catch { /* no key */ }
  const base = await loadMask(IMG!, MASK_MODE);
  console.log("loading graph…");
  const g = GRAPH ? await loadPackedGraph(GRAPH) : ((await getStreetGraph()) as unknown as Graph);
  console.log(`graph: ${g.coord.length} nodes`);
  const probe = opt("probe", "");
  if (probe) {
    for (const pt of probe.split(";")) { const [la, ln] = pt.split(",").map(Number); const info = localGridInfo(g, [la!, ln!]); console.log(pt, info ? `axis ${info.axis} rot ${info.rot} uniform ${info.uniform.toFixed(2)}` : "no info"); }
    return;
  }

  type Cand = { center: LatLng; scale: number; rot: number; score: number; plan: Plan };
  const sweepFor = async (layoutMode: string): Promise<Cand[]> => {
    let { mask, w, h } = base;
  let extraThin: [number, number][][] = [];
  let scales = SCALES;
  if (layoutMode !== "none") {
    const lay = relayout(mask, w, h, layoutMode === "keep" ? "keep" : "stack");
    if (lay) {
      console.log(`re-layout(${layoutMode}): ${lay.bodies} bodies, ${lay.links.length} links (${lay.w}x${lay.h})`);
      mask = lay.mask; w = lay.w; h = lay.h; extraThin = lay.links;
      if (opt("scales", "") === "auto") {
        // unit width of the smallest body must reach MINBODY meters
        let minX = w, maxX = 0, minY = h, maxY = 0;
        for (let i = 0; i < w * h; i++) if (mask[i] === 255) { const x = i % w, y = (i / w) | 0; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        const span = Math.max(maxX - minX, maxY - minY) || 1;
        const s0 = Math.round((MINBODY / ((lay.smallestBodyWidthPx * 2) / span)) / 50) * 50;
        scales = [s0, Math.round(s0 * 1.2 / 50) * 50];
        console.log(`auto scales for min body width ${MINBODY} m: ${scales.join(",")}`);
      }
    }
  }
  let ink = 0; for (let i = 0; i < w * h; i++) if (mask[i] === 255) ink++;
  console.log(`${NAME}: mask ${((ink / (w * h)) * 100).toFixed(1)}% ink (${MASK_MODE})`);
  // ---- placement sweep (grid-aligned, coarse support score) ----
  const cands: Cand[] = [];
  for (const scale of scales) {
    const plan = makePlan(mask, w, h, scale, PITCH_M, extraThin);
    await planSheet(mask, w, h, plan, path.join(OUT, `plan-${scale}.png`));
    const nHatch = plan.strokes.filter((s) => s.kind === "hatch").length, nThin = plan.strokes.filter((s) => s.kind === "thin").length, nOut = plan.strokes.filter((s) => s.kind === "outline").length;
    console.log(`scale ${scale}: ${nOut} outline, ${nHatch} hatch rows, ${nThin} thin strokes; mass ${((plan.massPx / ink) * 100).toFixed(0)}% of ink, ${plan.mPerPx.toFixed(1)} m/px`);
    // sample points for support scoring
    const samples: UnitPt[] = [];
    const linkSamples: UnitPt[] = [];
    for (const s of plan.strokes) {
      for (let i = 1; i < s.pts.length; i++) {
        const a = s.pts[i - 1]!, b = s.pts[i]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * scale;
        const n = Math.max(1, Math.round(len / 60));
        for (let k = 0; k <= n; k++) (s.link ? linkSamples : samples).push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
      }
    }
    const gate: Record<string, number> = { noinfo: 0, lowuniform: 0, mixed: 0, floor: 0, park: 0, miss: 0, ok: 0 };
    // footprint extents in unit space (for uniformity probes)
    const ext: [number, number] = [Math.max(...samples.map((p) => Math.abs(p[0]))) * 0.85, Math.max(...samples.map((p) => Math.abs(p[1]))) * 0.85];
    for (const rotOpt of ROTS) {
      for (let lat = LAT0; lat <= LAT1; lat += 0.004) {
        for (let lng = LNG0; lng <= LNG1; lng += 0.005) {
          // "auto" reads the local grid; numeric rots are used as given
          let rot = rotOpt;
          if (AUTO_ROT) {
            const info = localGridInfo(g, [lat, lng]);
            if (!info) { gate.noinfo!++; continue; }
            if (info.uniform < 0.55) { gate.lowuniform!++; continue; }
            rot = info.rot;
            // the whole footprint must sit on the SAME grid (mixed grids shred hatch rows)
            let mixed = false;
            // probe a 3x3 grid over the whole footprint (in the placed frame)
            const probes: LatLng[] = [];
            for (const fx of [-1, 0, 1]) for (const fy of [-1, 0, 1]) { if (!fx && !fy) continue; probes.push(place([[fx * ext[0], fy * ext[1]]], [lat, lng], scale, rot)[0]!); }
            for (const pr of probes) {
              const q = localGridInfo(g, pr);
              if (!q || q.uniform < 0.45) { mixed = true; break; }
              const da = Math.min(Math.abs(q.axis - info.axis), 90 - Math.abs(q.axis - info.axis));
              if (da > 10) { mixed = true; break; }
            }
            if (mixed) { gate.mixed!++; continue; }
          }
          const placed = place(samples, [lat, lng], scale, rot);
          // grid floor: 14th St west of the Bowery line, Houston St east of it
          let below = false;
          for (const p of placed) { const floor = p[1] > -73.96 ? 0 : p[1] > -73.992 ? 40.7225 : LAT_FLOOR; if (p[0] < floor) { below = true; break; } }
          if (below) { gate.floor!++; continue; }
          let sum = 0, miss = 0, park = 0;
          const missCap = Math.max(3, Math.floor(placed.length * 0.03));
          for (const p of placed) {
            if (inPoly(p, PARK)) { park = missCap + 1; break; }
            const { d } = nearestNode(g, p);
            if (d > 130) { miss++; if (miss > missCap) break; }
            sum += Math.min(d, 130);
          }
          if (park > missCap) { gate.park!++; continue; }
          if (miss > missCap) { gate.miss!++; continue; }
          // links: only need street/path support (parks allowed)
          if (linkSamples.length) {
            let lmiss = 0;
            for (const p of place(linkSamples, [lat, lng], scale, rot)) { const { d } = nearestNode(g, p); if (d > 130) lmiss++; }
            if (lmiss > Math.max(2, linkSamples.length * 0.05)) { gate.miss!++; continue; }
          }
          gate.ok!++;
          cands.push({ center: [lat, lng], scale, rot, score: sum / placed.length, plan });
        }
      }
    }
    console.log(`  gates @${scale}: ${Object.entries(gate).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  return cands;
  };
  const modes = LAYOUT === "auto" ? ["keep", "stack"] : [LAYOUT];
  let cands: Cand[] = [];
  for (const m of modes) { cands = await sweepFor(m); if (cands.length) break; console.log(`no legal seat with layout=${m}`); }
  cands.sort((a, b) => a.score - b.score);
  const shortlist: Cand[] = [];
  for (const c of cands) {
    if (shortlist.length >= 40) break;
    if (shortlist.some((p) => meters(p.center, c.center) < 500 && p.scale === c.scale && p.rot === c.rot)) continue;
    shortlist.push(c);
  }
  console.log(`${cands.length} legal placements; routing ${shortlist.length} to rank by fidelity`);
  if (!shortlist.length) return;
  const t0 = Date.now();
  const routed: { c: Cand; r: Routed }[] = [];
  for (const c of shortlist) {
    const r = routePlacement(g, orderStrokes(c.plan.strokes), c.center, c.scale, c.rot);
    if (r) routed.push({ c, r });
  }
  routed.sort((a, b) => a.r.fidelity - b.r.fidelity);
  console.log(`routed ${routed.length} in ${((Date.now() - t0) / 1000).toFixed(0)} s; best fidelity ${routed[0]?.r.fidelity.toFixed(1)} (dev ${routed[0]?.r.devM.toFixed(0)} m)`);
  const picks: { c: Cand; r: Routed }[] = [];
  for (const x of routed) {
    if (picks.length >= PICKS) break;
    if (picks.some((p) => meters(p.c.center, x.c.center) < 900 && p.c.scale === x.c.scale)) continue;
    picks.push(x);
  }

  const summary: object[] = [];
  for (let k = 0; k < picks.length; k++) {
    let { c: pk, r } = picks[k]!;
    // micro-refinement: nudge the seat +-60 m to settle edges onto streets
    const ordered = orderStrokes(pk.plan.strokes);
    for (const dl of [-0.0006, 0, 0.0006]) for (const dg of [-0.0008, 0, 0.0008]) {
      if (!dl && !dg) continue;
      const c2: LatLng = [pk.center[0] + dl, pk.center[1] + dg];
      const r2 = routePlacement(g, ordered, c2, pk.scale, pk.rot);
      if (r2 && r2.fidelity < r.fidelity) { r = r2; pk = { ...pk, center: c2 }; }
    }
    const tag = `${NAME}-${k}`;
    const gpx = r.chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
    await fs.writeFile(path.join(OUT, `${tag}.gpx`), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso stroke-painter" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${tag}</name><trkseg>\n${gpx}\n</trkseg></trk></gpx>\n`);
    const jpg = await paleRender(r.chain, path.join(OUT, `${tag}.png`));
    DROPS.length = 0; STROKELOG.length = 0; CONNLOG.length = 0;
    r = routePlacement(g, ordered, pk.center, pk.scale, pk.rot) ?? r;
    if (DROPS.length) console.log(`   dropped: ${DROPS.join(" | ")}`);
    console.log(`   strokes: ${STROKELOG.join(" ")}`);
    console.log(`   connectors: ${CONNLOG.join(" ")}`);
    { const L = measureLattice(g, pk.center, pk.rot); if (L) console.log(`   lattice: avenue pitch ${L.pA.toFixed(0)} m, street pitch ${L.pS.toFixed(0)} m`); }
    const line = `pick ${k}: center ${pk.center.map((v) => v.toFixed(4)).join(",")} scale ${pk.scale} rot ${pk.rot} | ${r.km.toFixed(1)} km (ink ${r.inkKm.toFixed(1)}, connectors ${r.connectorKm.toFixed(1)}, visible ${r.visibleConnKm.toFixed(1)}), ${r.dropped}/${r.strokes} dropped, dev ${r.devM.toFixed(0)} m, fidelity ${r.fidelity.toFixed(1)}`;
    await debugRender(r, path.join(OUT, `${tag}-dbg.png`));
    console.log(line);
    let j: { cold: { guess: string; conf: number }[]; like: number[] } | null = null;
    if (JUDGE && KEY) {
      j = await judge(jpg, IMG!);
      console.log(`   cold: ${j.cold.map((c) => `${c.guess} (${c.conf})`).join(" / ")}   likeness: ${j.like.join("/")}`);
    }
    summary.push({ pick: k, center: pk.center, scale: pk.scale, rot: pk.rot, km: r.km, inkKm: r.inkKm, connectorKm: r.connectorKm, dropped: r.dropped, strokes: r.strokes, maxGap: r.maxGap, judge: j });
  }
  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
