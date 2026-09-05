/**
 * Stroke painter — the drawing primitive behind the instant first draft.
 *
 * The reference GPS-art pieces are not traced outlines: they are paintings
 * made of street runs, with doubling back and hatching as the brush. This
 * module treats the upload as a FILLED silhouette and paints it:
 *
 *   mask ──► mass (morphological opening at ~a block) ──► outline rings + sparse hatch rows
 *        └─► thin residue (limbs, hoses, frames)      ──► skeleton centerlines
 *
 * Multi-part logos (pump —hose— figure) are split into bodies joined by
 * links; when the original layout has no legal seat, bodies are stacked
 * upright along the grid and each link is redrawn as an arc.
 *
 * Placement reads the street grid itself: only seats on a uniform grid are
 * legal, rotation comes from the dominant street bearing, and every straight
 * stroke vertex is snapped onto measured street lines before routing so
 * rectangles come out as clean street runs. Every legal seat is fully routed
 * and ranked by fidelity (deviation from the intended strokes + visible
 * connector share + dropped strokes). Pure CPU on the cached walk graph —
 * no Mapbox, no language model.
 *
 * Offline rig with rendering + blind judges: scripts/stroke-painter.ts.
 */
import { traceContour, place, type LatLng, type NormalizedPoint } from "./streetGraphTrace";
import { centerlinePolylinesFromLineMask } from "./centerlineFromMask";
import { rasterizeNormalizedPathToLineMask } from "./artPathMask";
import * as d3 from "d3-contour";

export type UnitPt = [number, number];
/** thin strokes closer than this to a mass ring are dropped (they would draw on the same streets) */
export let HUG_TOL_M = 165;
export function setHugTolerance(m: number): void {
  HUG_TOL_M = m;
}
export type PainterGraph = {
  coord: LatLng[];
  adj: { to: number; w: number }[][];
  grid: Map<string, number[]>;
};
export type Stroke = {
  kind: "outline" | "hatch" | "thin";
  pts: UnitPt[];
  closed: boolean;
  /** redrawn link (hose): always traced organically as stairs, never quantized into a box */
  link?: boolean;
  /** body group: outline + hatch rows + holes of one mass are drawn as a unit */
  group?: number;
};
export type Plan = {
  strokes: Stroke[];
  massPx: number;
  thinPx: number;
  mPerPx: number;
  span: number;
  cx: number;
  cy: number;
};
export type Routed = {
  chain: LatLng[];
  isInk: boolean[];
  km: number;
  inkKm: number;
  connectorKm: number;
  visibleConnKm: number;
  dropped: number;
  strokes: number;
  maxGap: number;
  devM: number;
  fidelity: number;
};
export type PaintCandidate = Routed & {
  center: LatLng;
  scaleM: number;
  rotDeg: number;
  layout: "keep" | "stack" | "none";
};
export type PaintOptions = {
  /** half-size of the placed shape in meters; default sweeps a hero range */
  scales?: number[];
  /** hatch rows per mass */
  rows?: number;
  /** morphological opening radius in meters — features narrower than 2x become centerlines */
  openM?: number;
  /** minimum hatch pitch in meters */
  pitchM?: number;
  /** "auto" tries the original layout first and stacks bodies only when it has no legal seat */
  layout?: "auto" | "keep" | "stack" | "none";
  /** seat sweep window (centers) */
  latRange?: [number, number];
  lngRange?: [number, number];
  /** how many diverse seats to return */
  picks?: number;
  timeBudgetMs?: number;
  onProgress?: (detail: string) => void;
};

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------
const M_PER_LAT = 111320;
const mPerLng = (lat: number) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);
const CELL = 0.003;
const NODE_STRIDE = 1_000_000;

export function meters(a: LatLng, b: LatLng): number {
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
export function nearestNode(g: PainterGraph, p: LatLng): { id: number; d: number } {
  let best = -1;
  let bd = Infinity;
  const clat = Math.round(p[0] / CELL);
  const clng = Math.round(p[1] / CELL);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
        const m = meters(p, g.coord[id]!);
        if (m < bd) {
          bd = m;
          best = id;
        }
      }
    }
  }
  return { id: best, d: bd };
}
function pathMeters(chain: LatLng[]): number {
  let m = 0;
  for (let i = 1; i < chain.length; i++) m += meters(chain[i - 1]!, chain[i]!);
  return m;
}

/** Central Park (grid-rotated rectangle): body strokes may not enter it; links may ride its paths. */
const PARK: LatLng[] = [
  [40.7638, -73.9722],
  [40.7676, -73.9828],
  [40.801, -73.9585],
  [40.7973, -73.9482],
];
function inPoly(p: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i]![0];
    const xi = poly[i]![1];
    const yj = poly[j]![0];
    const xj = poly[j]![1];
    if (yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

class Heap {
  a: { k: number; v: number }[] = [];
  push(k: number, v: number) {
    const a = this.a;
    a.push({ k, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.k <= a[i]!.k) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): { k: number; v: number } | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]!.k < a[m]!.k) m = l;
        if (r < a.length && a[r]!.k < a[m]!.k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

const edgeKey = (u: number, v: number) => (u < v ? u * NODE_STRIDE + v : v * NODE_STRIDE + u);

/** Shortest walk between two nodes; already-painted streets are nearly free (connectors hide on the ink). */
export function walk(g: PainterGraph, a: number, b: number, maxM: number, painted?: Set<number>): number[] | null {
  if (a < 0 || b < 0) return null;
  if (a === b) return [a];
  const dist = new Map<number, number>([[a, 0]]);
  const came = new Map<number, number>();
  const h = new Heap();
  h.push(meters(g.coord[a]!, g.coord[b]!), a);
  const done = new Set<number>();
  while (h.size) {
    const { v: cur } = h.pop()!;
    if (done.has(cur)) continue;
    done.add(cur);
    if (cur === b) {
      const out = [b];
      let c = b;
      while (came.has(c)) {
        c = came.get(c)!;
        out.push(c);
      }
      return out.reverse();
    }
    const dc = dist.get(cur)!;
    if (dc > maxM) return null;
    for (const { to, w } of g.adj[cur]!) {
      const nd = dc + (painted && painted.has(edgeKey(cur, to)) ? w * 0.12 : w);
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        came.set(to, cur);
        h.push(nd + 0.12 * meters(g.coord[to]!, g.coord[b]!), to);
      }
    }
  }
  return null;
}

/** Straight street run between two nodes hugging segment a-b (hatch rows, quantized edges). */
function straightRun(
  g: PainterGraph,
  a: number,
  b: number,
  segA: LatLng,
  segB: LatLng,
  corridorM: number,
  lambda = 20,
  bendW = 80,
): number[] | null {
  if (a < 0 || b < 0) return null;
  const target = g.coord[b]!;
  const key = (p: number, c: number) => (p + NODE_STRIDE) * NODE_STRIDE + c;
  const startKey = key(-1, a);
  const gs = new Map<number, number>([[startKey, 0]]);
  const came = new Map<number, number>();
  const h = new Heap();
  h.push(meters(g.coord[a]!, target), startKey);
  const done = new Set<number>();
  let guard = 0;
  while (h.size && guard++ < 200000) {
    const { v: ck } = h.pop()!;
    if (done.has(ck)) continue;
    done.add(ck);
    const cur = ck % NODE_STRIDE;
    const prev = Math.floor(ck / NODE_STRIDE) - NODE_STRIDE;
    if (cur === b) {
      const ids = [cur];
      let k = ck;
      while (came.has(k)) {
        k = came.get(k)!;
        ids.push(k % NODE_STRIDE);
      }
      return ids.reverse();
    }
    for (const { to, w } of g.adj[cur]!) {
      const cto = g.coord[to]!;
      const dc = distToSeg(cto, segA, segB);
      if (dc > corridorM) continue;
      let bend = 0;
      if (prev >= 0) {
        const i1 = [
          (g.coord[cur]![1] - g.coord[prev]![1]) * mPerLng(cto[0]),
          (g.coord[cur]![0] - g.coord[prev]![0]) * M_PER_LAT,
        ];
        const o1 = [(cto[1] - g.coord[cur]![1]) * mPerLng(cto[0]), (cto[0] - g.coord[cur]![0]) * M_PER_LAT];
        const n1 = Math.hypot(i1[0]!, i1[1]!) || 1;
        const n2 = Math.hypot(o1[0]!, o1[1]!) || 1;
        const dot = (i1[0]! * o1[0]! + i1[1]! * o1[1]!) / (n1 * n2);
        bend = (1 - dot) * bendW;
      }
      const nk = key(cur, to);
      const t = gs.get(ck)! + w + lambda * dc + bend;
      if (t < (gs.get(nk) ?? Infinity)) {
        gs.set(nk, t);
        came.set(nk, ck);
        h.push(t + meters(cto, target), nk);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// reading the grid
// ---------------------------------------------------------------------------
export type GridInfo = { rot: number; axis: number; uniform: number };

/** Dominant street axis near a point (degrees east of north in [0,90)), its uniformity, and the upright rotation. */
export function localGridInfo(g: PainterGraph, c: LatLng): GridInfo | null {
  const bins = new Float64Array(90);
  const clat = Math.round(c[0] / CELL);
  const clng = Math.round(c[1] / CELL);
  let total = 0;
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
        for (const { to, w } of g.adj[id]!) {
          if (to < id || w < 40) continue;
          const a = g.coord[id]!;
          const b = g.coord[to]!;
          const dx = (b[1] - a[1]) * mPerLng(a[0]);
          const dy = (b[0] - a[0]) * M_PER_LAT;
          let deg = (Math.atan2(dx, dy) * 180) / Math.PI;
          deg = ((deg % 90) + 90) % 90;
          bins[Math.floor(deg)] += w;
          total += w;
        }
      }
    }
  }
  if (total < 3000) return null;
  let best = 0;
  let axis = 0;
  for (let i = 0; i < 90; i++) {
    const v = bins[(i + 89) % 90]! + bins[i]! + bins[(i + 1) % 90]!;
    if (v > best) {
      best = v;
      axis = i;
    }
  }
  let near = 0;
  for (let i = 0; i < 90; i++) {
    const d = Math.min(Math.abs(i - axis), 90 - Math.abs(i - axis));
    if (d <= 6) near += bins[i]!;
  }
  const up = axis <= 45 ? axis : axis - 90;
  return { rot: -up, axis, uniform: near / total };
}

type Lattice = {
  center: LatLng;
  rot: number;
  pA: number;
  pS: number;
  x0: number;
  y0: number;
  xLines: number[];
  yLines: number[];
};

/** local frame: x along the street axis, y along the avenue axis */
function toLocal(p: LatLng, center: LatLng, rot: number): [number, number] {
  const ex = (p[1] - center[1]) * mPerLng(center[0]);
  const ny = (p[0] - center[0]) * M_PER_LAT;
  const r = (-rot * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return [ex * c - ny * sn, ex * sn + ny * c];
}
function fromLocal(q: [number, number], center: LatLng, rot: number): LatLng {
  const r = (rot * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  const ex = q[0] * c - q[1] * sn;
  const ny = q[0] * sn + q[1] * c;
  return [center[0] + ny / M_PER_LAT, center[1] + ex / mPerLng(center[0])];
}
function clusterLines(vals: number[]): { pos: number; n: number }[] {
  const v = vals.slice().sort((a, b) => a - b);
  const clusters: { pos: number; n: number }[] = [];
  for (const x of v) {
    const c = clusters[clusters.length - 1];
    if (c && x - c.pos / c.n < 22) {
      c.pos += x;
      c.n++;
    } else clusters.push({ pos: x, n: 1 });
  }
  return clusters;
}
function medianGap(vals: number[]): number {
  const clusters = clusterLines(vals);
  const counts = clusters.map((c) => c.n).sort((a, b) => a - b);
  const strong = clusters
    .filter((c) => c.n >= Math.max(5, counts[Math.floor(counts.length * 0.5)]! * 0.6))
    .map((c) => c.pos / c.n);
  const gaps: number[] = [];
  for (let i = 1; i < strong.length; i++) {
    const d = strong[i]! - strong[i - 1]!;
    if (d >= 50 && d <= 450) gaps.push(d);
  }
  if (gaps.length < 2) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}
function measureLattice(g: PainterGraph, center: LatLng, rot: number, radiusM: number): Lattice | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const clat = Math.round(center[0] / CELL);
  const clng = Math.round(center[1] / CELL);
  const cells = Math.ceil(radiusM / (CELL * M_PER_LAT)) + 1;
  let nearest = -1;
  let nd = Infinity;
  for (let dr = -cells; dr <= cells; dr++) {
    for (let dc = -cells; dc <= cells; dc++) {
      for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
        if ((g.adj[id]?.length ?? 0) < 3) continue;
        const q = toLocal(g.coord[id]!, center, rot);
        if (Math.abs(q[0]) > radiusM || Math.abs(q[1]) > radiusM) continue;
        xs.push(q[0]);
        ys.push(q[1]);
        const d = Math.hypot(q[0], q[1]);
        if (d < nd) {
          nd = d;
          nearest = id;
        }
      }
    }
  }
  if (nearest < 0 || xs.length < 30) return null;
  const pA = medianGap(xs);
  const pS = medianGap(ys);
  if (!pA || !pS) return null;
  const q0 = toLocal(g.coord[nearest]!, center, rot);
  const minCount = Math.max(4, Math.round(radiusM / 400));
  const lines = (vals: number[], pitch: number) =>
    clusterLines(vals)
      .filter((c) => c.n >= Math.max(minCount, Math.round(radiusM / pitch / 3)))
      .map((c) => c.pos / c.n);
  return { center, rot, pA, pS, x0: q0[0], y0: q0[1], xLines: lines(xs, pS), yLines: lines(ys, pA) };
}
function snapLine(v: number, lines: number[], pitch: number, origin: number): number {
  let best = origin + Math.round((v - origin) / pitch) * pitch;
  let bd = Math.abs(v - best) + pitch * 0.35;
  for (const l of lines) {
    const d = Math.abs(v - l);
    if (d < bd) {
      bd = d;
      best = l;
    }
  }
  return best;
}
function rdp<T extends [number, number]>(pts: T[], eps: number): T[] {
  if (pts.length < 3) return pts;
  const d2 = (p: T, a: T, b: T) => {
    const bx = b[0] - a[0];
    const by = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * bx + (p[1] - a[1]) * by) / (bx * bx + by * by || 1)));
    return Math.hypot(p[0] - a[0] - t * bx, p[1] - a[1] - t * by);
  };
  let idx = -1;
  let md = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = d2(pts[i]!, pts[0]!, pts[pts.length - 1]!);
    if (d > md) {
      md = d;
      idx = i;
    }
  }
  if (md > eps) return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  return [pts[0]!, pts[pts.length - 1]!];
}
/** snap a placed polyline's vertices onto street lines; drop repeats, sub-block jogs and collinear points */
function quantizeTarget(target: LatLng[], L: Lattice, closed: boolean): LatLng[] {
  const q = target.map((p) => {
    const [x, y] = toLocal(p, L.center, L.rot);
    return [snapLine(x, L.xLines, L.pA, L.x0), snapLine(y, L.yLines, L.pS, L.y0)] as [number, number];
  });
  let out: [number, number][] = [];
  for (const v of q) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - v[0]) < 1 && Math.abs(last[1] - v[1]) < 1) continue;
    out.push(v);
  }
  const eps = 0.6 * Math.min(L.pA, L.pS);
  out = rdp(out, eps).map(
    (v) => [snapLine(v[0], L.xLines, L.pA, L.x0), snapLine(v[1], L.yLines, L.pS, L.y0)] as [number, number],
  );
  const keep: [number, number][] = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i]!;
    const c = out[i + 1];
    if (a && c) {
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1) continue;
    }
    keep.push(b);
  }
  if (closed && keep.length > 2) {
    const f = keep[0]!;
    const l = keep[keep.length - 1]!;
    if (Math.abs(f[0] - l[0]) > 1 || Math.abs(f[1] - l[1]) > 1) keep.push(f);
  }
  return keep.map((v) => fromLocal(v, L.center, L.rot));
}

/**
 * Pixel art on the block grid: fill every block whose centre lies inside the
 * placed ring, then trace the boundary of the filled blocks. Every edge is a
 * whole street run with corners at intersections — the way the reference
 * lion/elephant pieces are drawn. Returns null when the ring is smaller than
 * a couple of blocks.
 */
export let BLOCKIFY = false;
export function setBlockify(on: boolean): void {
  BLOCKIFY = on;
}
function blockifyRing(target: LatLng[], L: Lattice): LatLng[] | null {
  const xs = L.xLines.slice().sort((a, b) => a - b);
  const ys = L.yLines.slice().sort((a, b) => a - b);
  if (xs.length < 3 || ys.length < 3) return null;
  const poly = target.map((p) => toLocal(p, L.center, L.rot));
  const inside = (x: number, y: number): boolean => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i]![0], yi = poly[i]![1], xj = poly[j]![0], yj = poly[j]![1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const nx = xs.length - 1, ny = ys.length - 1;
  const cell = new Uint8Array(nx * ny);
  let filled = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x0 = xs[i]!, x1 = xs[i + 1]!, y0 = ys[j]!, y1 = ys[j + 1]!;
      if (x1 - x0 > 600 || y1 - y0 > 600) continue; // not a block, a gap in the measured lines
      let n = 0;
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as [number, number][]) {
        if (inside(x0 + fx * (x1 - x0), y0 + fy * (y1 - y0))) n++;
      }
      if (n >= 3) {
        cell[i * ny + j] = 1;
        filled++;
      }
    }
  }
  if (filled < 2) return null;
  // directed boundary edges, interior on the left (counter-clockwise loops)
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < nx && j < ny ? cell[i * ny + j]! : 0);
  const key = (i: number, j: number) => i * 4096 + j;
  const next = new Map<number, [number, number]>(); // from corner -> to corner
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!at(i, j)) continue;
      if (!at(i, j - 1)) next.set(key(i, j), [i + 1, j]); // bottom edge, going east
      if (!at(i + 1, j)) next.set(key(i + 1, j), [i + 1, j + 1]); // right edge, going north
      if (!at(i, j + 1)) next.set(key(i + 1, j + 1), [i, j + 1]); // top edge, going west
      if (!at(i - 1, j)) next.set(key(i, j + 1), [i, j]); // left edge, going south
    }
  }
  // follow the longest loop
  const seen = new Set<number>();
  let best: [number, number][] = [];
  for (const [startKey] of next) {
    if (seen.has(startKey)) continue;
    const loop: [number, number][] = [];
    let k = startKey;
    let guard = 0;
    while (!seen.has(k) && guard++ < 100000) {
      seen.add(k);
      const to = next.get(k);
      if (!to) break;
      loop.push(to);
      k = key(to[0], to[1]);
    }
    if (loop.length > best.length) best = loop;
  }
  if (best.length < 4) return null;
  // drop collinear corners, close, convert
  const pts: [number, number][] = best.map(([i, j]) => [xs[i]!, ys[j]!]);
  const keep: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length]!, b = pts[i]!, c = pts[(i + 1) % pts.length]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1) continue;
    keep.push(b);
  }
  if (keep.length < 4) return null;
  keep.push(keep[0]!);
  return keep.map((v) => fromLocal(v, L.center, L.rot));
}

// ---------------------------------------------------------------------------
// mask operations
// ---------------------------------------------------------------------------
function erode(src: Uint8Array, w: number, h: number, rounds: number): Uint8Array {
  let cur = new Uint8Array(src);
  for (let r = 0; r < rounds; r++) {
    const next = new Uint8Array(cur);
    for (let i = 0; i < w * h; i++) {
      if (cur[i] !== 255) continue;
      const x = i % w;
      const y = (i / w) | 0;
      if (
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        cur[i - 1] !== 255 ||
        cur[i + 1] !== 255 ||
        cur[i - w] !== 255 ||
        cur[i + w] !== 255
      )
        next[i] = 0;
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
      const x = i % w;
      const y = (i / w) | 0;
      if (
        (x > 0 && cur[i - 1] === 255) ||
        (x < w - 1 && cur[i + 1] === 255) ||
        (y > 0 && cur[i - w] === 255) ||
        (y < h - 1 && cur[i + w] === 255)
      )
        next[i] = 255;
    }
    cur = next;
  }
  return cur;
}
function neighbors4(p: number, w: number, h: number): number[] {
  const x = p % w;
  const y = (p / w) | 0;
  const nb: number[] = [];
  if (x > 0) nb.push(p - 1);
  if (x < w - 1) nb.push(p + 1);
  if (y > 0) nb.push(p - w);
  if (y < h - 1) nb.push(p + w);
  return nb;
}
function components(src: Uint8Array, w: number, h: number): number[][] {
  const seen = new Uint8Array(w * h);
  const comps: number[][] = [];
  for (let s = 0; s < w * h; s++) {
    if (src[s] !== 255 || seen[s]) continue;
    const comp: number[] = [];
    const st = [s];
    seen[s] = 1;
    while (st.length) {
      const p = st.pop()!;
      comp.push(p);
      for (const q of neighbors4(p, w, h)) {
        if (src[q] === 255 && !seen[q]) {
          seen[q] = 1;
          st.push(q);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/**
 * Build a filled silhouette from the approved Step 1 line art: rasterize the
 * one-line path, then everything not reachable from the border is ink.
 */
export function filledMaskFromContour(contour: NormalizedPoint[], size = 320): { mask: Uint8Array; w: number; h: number } {
  const line = rasterizeNormalizedPathToLineMask(contour, size, 2);
  const outside = new Uint8Array(size * size);
  const q: number[] = [];
  const push = (i: number) => {
    if (line[i] !== 0 || outside[i] !== 0) return;
    outside[i] = 1;
    q.push(i);
  };
  for (let x = 0; x < size; x++) {
    push(x);
    push((size - 1) * size + x);
  }
  for (let y = 0; y < size; y++) {
    push(y * size);
    push(y * size + size - 1);
  }
  while (q.length) {
    const i = q.pop()!;
    for (const j of neighbors4(i, size, size)) push(j);
  }
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i++) if (!outside[i]) mask[i] = 255;
  return { mask, w: size, h: size };
}

// ---------------------------------------------------------------------------
// plan: mask -> strokes (unit space, y up, up = avenue direction)
// ---------------------------------------------------------------------------
export function makePlan(
  mask: Uint8Array,
  w: number,
  h: number,
  scaleM: number,
  opts: { pitchM: number; rows: number; openM: number },
  extraThin: [number, number][][] = [],
): Plan {
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 255) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const mPerPx = (2 * scaleM) / span;
  const toUnit = (x: number, y: number): UnitPt => [((x - cx) * 2) / span, ((cy - y) * 2) / span];

  const rPx = Math.max(1, Math.round(opts.openM / mPerPx));
  const mass = dilate(erode(mask, w, h, rPx), w, h, rPx, mask);
  const minMassPx = (250 / mPerPx) ** 2;
  const compsAll = components(mass, w, h);
  const biggestAll = Math.max(1, ...compsAll.map((c) => c.length));
  for (const c of compsAll) {
    if (c.length < minMassPx || c.length < 0.12 * biggestAll) for (const p of c) mass[p] = 0;
  }
  const massGrown = dilate(mass, w, h, 2);
  const thin = new Uint8Array(w * h);
  let massPx = 0;
  let thinPx = 0;
  for (let i = 0; i < w * h; i++) {
    if (mass[i] === 255) massPx++;
    if (mask[i] === 255 && massGrown[i] !== 255) {
      thin[i] = 255;
      thinPx++;
    }
  }

  const strokes: Stroke[] = [];
  type Ring = { ring: UnitPt[]; hole: boolean; area: number };
  const rings: Ring[] = [];
  const cg = d3.contours().size([w, h]);
  const [cont] = cg.thresholds([128])(Array.from(mass));
  if (cont) {
    for (const poly of cont.coordinates) {
      poly.forEach((ring, ri) => {
        const u = rdp(
          ring.map(([x, y]) => toUnit(x!, y!)),
          1.2 * (2 / span),
        );
        let perim = 0;
        for (let i = 1; i < u.length; i++) perim += Math.hypot(u[i]![0] - u[i - 1]![0], u[i]![1] - u[i - 1]![1]);
        if (perim * scaleM < 250 || u.length < 4) return;
        let area = 0;
        for (let i = 1; i < u.length; i++) area += u[i - 1]![0] * u[i]![1] - u[i]![0] * u[i - 1]![1];
        rings.push({ ring: u, hole: ri > 0, area: Math.abs(area) / 2 });
      });
    }
  }

  const pitchPx = opts.pitchM / mPerPx;
  const minRunPx = 300 / mPerPx;
  const massComps = components(mass, w, h).filter((c) => c.length >= minMassPx);
  const biggest = Math.max(1, ...massComps.map((c) => c.length));
  const groups = massComps
    .map((c) => {
      let sx = 0;
      let my0 = h;
      let my1 = 0;
      let mx0 = w;
      let mx1 = 0;
      for (const p of c) {
        const x = p % w;
        const y = (p / w) | 0;
        sx += x;
        if (y < my0) my0 = y;
        if (y > my1) my1 = y;
        if (x < mx0) mx0 = x;
        if (x > mx1) mx1 = x;
      }
      const set = new Uint8Array(w * h);
      for (const p of c) set[p] = 255;
      const rows: UnitPt[][] = [];
      const massPitchPx = Math.max(pitchPx, (my1 - my0) / opts.rows);
      if ((my1 - my0) * mPerPx >= 1.6 * opts.pitchM && c.length >= 0.3 * biggest) {
        for (let y = my0 + massPitchPx / 2; y < my1; y += massPitchPx) {
          const yy = Math.round(y);
          const runs: UnitPt[][] = [];
          let x0 = -1;
          for (let x = 0; x <= w; x++) {
            const on = x < w && set[yy * w + x] === 255;
            if (on && x0 < 0) x0 = x;
            if (!on && x0 >= 0) {
              if (x - x0 >= Math.max(minRunPx, 0.45 * (mx1 - mx0))) runs.push([toUnit(x0 + 1, yy), toUnit(x - 2, yy)]);
              x0 = -1;
            }
          }
          if (runs.length) rows.push(...(rows.length % 2 ? runs.reverse().map((r) => [r[1]!, r[0]!]) : runs));
        }
      }
      return { cx: sx / c.length, rings: [] as Ring[], rows, set: dilate(set, w, h, 3) };
    })
    .sort((a, b) => a.cx - b.cx);

  for (const r of rings) {
    let bi = 0;
    let bc = -1;
    groups.forEach((grp, gi) => {
      let n = 0;
      for (const p of r.ring) {
        const px = Math.round(cx + (p[0] * span) / 2);
        const py = Math.round(cy - (p[1] * span) / 2);
        if (px >= 0 && py >= 0 && px < w && py < h && grp.set[py * w + px] === 255) n++;
      }
      if (n > bc) {
        bc = n;
        bi = gi;
      }
    });
    groups[bi]?.rings.push(r);
  }
  groups.forEach((grp, gi) => {
    for (const r of grp.rings.filter((r) => !r.hole)) strokes.push({ kind: "outline", pts: r.ring, closed: true, group: gi });
    for (const row of grp.rows) strokes.push({ kind: "hatch", pts: row, closed: false, group: gi });
    // holes smaller than ~300 m square are clutter at block resolution
    for (const r of grp.rings.filter((r) => r.hole && r.area * scaleM * scaleM > 300 * 300))
      strokes.push({ kind: "outline", pts: r.ring, closed: true, group: gi });
  });

  const ringPts: UnitPt[] = strokes.filter((s) => s.kind === "outline").flatMap((s) => s.pts);
  const hugsRing = (pts: UnitPt[]) => {
    if (!ringPts.length) return false;
    const tol = HUG_TOL_M / scaleM;
    let near = 0;
    for (const p of pts) {
      let m = Infinity;
      for (const q of ringPts) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < m) m = d;
      }
      if (m < tol) near++;
    }
    return near / pts.length > 0.8;
  };
  for (const pl of extraThin) {
    const u = rdp(
      pl.map(([x, y]) => toUnit(x, y)),
      1.5 * (2 / span),
    );
    if (u.length >= 2) strokes.push({ kind: "thin", pts: u, closed: false, link: true });
  }
  if (thinPx > 0) {
    for (const pl of centerlinePolylinesFromLineMask(thin, w, h)) {
      const u = rdp(
        pl.map(([x, y]) => toUnit(x, y)),
        1.5 * (2 / span),
      );
      let len = 0;
      for (let i = 1; i < u.length; i++) len += Math.hypot(u[i]![0] - u[i - 1]![0], u[i]![1] - u[i - 1]![1]);
      if (len * scaleM < 260) continue;
      const dense: UnitPt[] = [];
      for (let i = 1; i < u.length; i++) {
        const n = Math.max(1, Math.round((Math.hypot(u[i]![0] - u[i - 1]![0], u[i]![1] - u[i - 1]![1]) * scaleM) / 60));
        for (let k = 0; k < n; k++)
          dense.push([u[i - 1]![0] + ((u[i]![0] - u[i - 1]![0]) * k) / n, u[i - 1]![1] + ((u[i]![1] - u[i - 1]![1]) * k) / n]);
      }
      if (hugsRing(dense)) continue;
      strokes.push({ kind: "thin", pts: u, closed: false });
    }
  }
  return { strokes, massPx, thinPx, mPerPx, span, cx, cy };
}

// ---------------------------------------------------------------------------
// re-layout: bodies joined by thin links; "keep" separates links from bodies,
// "stack" packs the bodies upright along the grid and redraws each link.
// ---------------------------------------------------------------------------
export type Layout = {
  mask: Uint8Array;
  w: number;
  h: number;
  links: [number, number][][];
  bodies: number;
  smallestBodyWidthPx: number;
};

export function relayout(
  mask: Uint8Array,
  w: number,
  h: number,
  mode: "stack" | "keep",
  opts: { gap: number; shift: number } = { gap: 0.3, shift: 0.45 },
): Layout | null {
  let ink = 0;
  for (let i = 0; i < w * h; i++) if (mask[i] === 255) ink++;
  const r = Math.max(3, Math.round(Math.sqrt(ink) / 20));
  const core = dilate(erode(mask, w, h, r), w, h, r, mask);
  const bodiesRaw = components(core, w, h).filter((c) => c.length >= ink * 0.04);
  if (bodiesRaw.length < 2) return null;
  const label = new Int32Array(w * h).fill(-1);
  const queue: number[] = [];
  bodiesRaw.forEach((c, bi) => {
    for (const p of c) {
      label[p] = bi;
      queue.push(p);
    }
  });
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const q of neighbors4(p, w, h)) {
      if (mask[q] === 255 && label[q]! < 0) {
        label[q] = label[p]!;
        queue.push(q);
      }
    }
  }
  const residue = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i] === 255 && core[i] !== 255) residue[i] = 255;
  const linkPx = new Uint8Array(w * h);
  const linkComps: number[][] = [];
  for (const c of components(residue, w, h)) {
    const touched = new Set<number>();
    for (const p of c) for (const q of neighbors4(p, w, h)) if (core[q] === 255) touched.add(label[q]!);
    if (touched.size >= 2 && c.length > 30) {
      linkComps.push(c);
      for (const p of c) linkPx[p] = 255;
    }
  }
  const bodies = bodiesRaw.map(() => ({ px: [] as number[], x0: w, x1: 0, y0: h, y1: 0 }));
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 255 || linkPx[i] === 255 || label[i]! < 0) continue;
    const b = bodies[label[i]!]!;
    b.px.push(i);
    const x = i % w;
    const y = (i / w) | 0;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  }
  const smallestBodyWidthPx = Math.min(...bodies.map((b) => b.x1 - b.x0 + 1));

  if (mode === "keep") {
    const mask2 = new Uint8Array(w * h);
    for (const b of bodies) for (const p of b.px) mask2[p] = 255;
    const links: [number, number][][] = [];
    for (const c of linkComps) {
      const lm = new Uint8Array(w * h);
      for (const p of c) lm[p] = 255;
      const polys = centerlinePolylinesFromLineMask(lm, w, h).sort((a, b) => b.length - a.length);
      const pl = polys[0];
      if (!pl || pl.length < 4) continue;
      // the Eulerian walk doubles back over the loop; keep one pass
      links.push(pl.slice(0, Math.ceil(pl.length / 2) + 1));
    }
    return { mask: mask2, w, h, links, bodies: bodies.length, smallestBodyWidthPx };
  }

  type Contact = { ba: number; A: [number, number]; bb: number; B: [number, number] };
  const contacts: Contact[] = [];
  for (const c of linkComps) {
    const contact = new Map<number, { x: number; y: number; n: number }>();
    for (const p of c) {
      const x = p % w;
      const yy = (p / w) | 0;
      for (const q of neighbors4(p, w, h)) {
        if (core[q] !== 255) continue;
        const bi = label[q]!;
        const e = contact.get(bi) ?? { x: 0, y: 0, n: 0 };
        e.x += x;
        e.y += yy;
        e.n++;
        contact.set(bi, e);
      }
    }
    const tb = [...contact.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 2);
    if (tb.length < 2) continue;
    contacts.push({
      ba: tb[0]![0],
      A: [tb[0]![1].x / tb[0]![1].n, tb[0]![1].y / tb[0]![1].n],
      bb: tb[1]![0],
      B: [tb[1]![1].x / tb[1]![1].n, tb[1]![1].y / tb[1]![1].n],
    });
  }
  const mirror = bodies.map(() => false);
  for (const k of contacts) {
    const cA = (bodies[k.ba]!.x0 + bodies[k.ba]!.x1) / 2;
    const cB = (bodies[k.bb]!.x0 + bodies[k.bb]!.x1) / 2;
    const sA = Math.sign(k.A[0] - cA);
    const sB = Math.sign(k.B[0] - cB);
    if (sA && sB && sA !== sB) {
      const small = bodies[k.ba]!.px.length < bodies[k.bb]!.px.length ? k.ba : k.bb;
      mirror[small] = true;
    }
  }
  const mx = (bi: number, x: number) => (mirror[bi] ? bodies[bi]!.x0 + bodies[bi]!.x1 - x : x);
  const order = bodies
    .map((_, i) => i)
    .sort((a, b) => bodies[a]!.x0 + bodies[a]!.x1 - (bodies[b]!.x0 + bodies[b]!.x1));
  const maxW = Math.max(...bodies.map((b) => b.x1 - b.x0 + 1));
  const maxH = Math.max(...bodies.map((b) => b.y1 - b.y0 + 1));
  const gap = Math.round(maxH * opts.gap);
  const margin = 12;
  const margin2 = Math.round(maxW * (0.25 + opts.shift)) + 12;
  const w2 = maxW + 2 * margin2;
  const h2 = bodies.reduce((sum, b) => sum + (b.y1 - b.y0 + 1), 0) + gap * (bodies.length - 1) + 2 * margin;
  const mask2 = new Uint8Array(w2 * h2);
  const offset: [number, number][] = bodies.map(() => [0, 0]);
  let y = margin;
  for (const bi of order) {
    const b = bodies[bi]!;
    let shiftPx = 0;
    if (opts.shift && b.x1 - b.x0 < maxW * 0.9) {
      const k = contacts.find((c) => c.ba === bi || c.bb === bi);
      if (k) {
        const other = k.ba === bi ? k.bb : k.ba;
        const pt = k.ba === bi ? k.B : k.A;
        const cxo = (bodies[other]!.x0 + bodies[other]!.x1) / 2;
        shiftPx = Math.round(Math.sign(mx(other, pt[0]) - cxo) * opts.shift * maxW);
      }
    }
    const dx = margin2 + Math.round((maxW - (b.x1 - b.x0 + 1)) / 2) - b.x0 + shiftPx;
    const dy = y - b.y0;
    offset[bi] = [dx, dy];
    for (const p of b.px) {
      const x = mx(bi, p % w);
      const yy = (p / w) | 0;
      mask2[(yy + dy) * w2 + (x + dx)] = 255;
    }
    y += b.y1 - b.y0 + 1 + gap;
  }
  const links: [number, number][][] = [];
  const widest = bodies
    .map((_, i) => i)
    .sort((a, b) => bodies[b]!.x1 - bodies[b]!.x0 - (bodies[a]!.x1 - bodies[a]!.x0))[0]!;
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
      arc.push([
        u * u * u * A2[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * B2[0],
        u * u * u * A2[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * B2[1],
      ]);
    }
    links.push(arc);
  }
  return { mask: mask2, w: w2, h: h2, links, bodies: bodies.length, smallestBodyWidthPx };
}

/**
 * Split a logo into its bodies and the thin links joining them, keeping
 * everything in the original pixel frame. A composition search can then
 * seat each body on its own street grid (the reference lion sits half on
 * Manhattan's grid and half on Long Island City's) and route each link
 * between the seated attachment points.
 */
export type BodySplit = {
  bodies: { mask: Uint8Array; w: number; h: number; x0: number; y0: number; x1: number; y1: number; px: number }[];
  links: { a: number; b: number; A: [number, number]; B: [number, number]; polyline: [number, number][] }[];
};
export function splitBodies(mask: Uint8Array, w: number, h: number): BodySplit | null {
  let ink = 0;
  for (let i = 0; i < w * h; i++) if (mask[i] === 255) ink++;
  const r = Math.max(3, Math.round(Math.sqrt(ink) / 20));
  const core = dilate(erode(mask, w, h, r), w, h, r, mask);
  const bodiesRaw = components(core, w, h).filter((c) => c.length >= ink * 0.04);
  if (bodiesRaw.length < 2) return null;
  const label = new Int32Array(w * h).fill(-1);
  const queue: number[] = [];
  bodiesRaw.forEach((c, bi) => {
    for (const p of c) {
      label[p] = bi;
      queue.push(p);
    }
  });
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const q of neighbors4(p, w, h)) {
      if (mask[q] === 255 && label[q]! < 0) {
        label[q] = label[p]!;
        queue.push(q);
      }
    }
  }
  const residue = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (mask[i] === 255 && core[i] !== 255) residue[i] = 255;
  const linkPx = new Uint8Array(w * h);
  const links: BodySplit["links"] = [];
  for (const c of components(residue, w, h)) {
    const contact = new Map<number, { x: number; y: number; n: number }>();
    for (const p of c) {
      const x = p % w;
      const yy = (p / w) | 0;
      for (const q of neighbors4(p, w, h)) {
        if (core[q] !== 255) continue;
        const bi = label[q]!;
        const e = contact.get(bi) ?? { x: 0, y: 0, n: 0 };
        e.x += x;
        e.y += yy;
        e.n++;
        contact.set(bi, e);
      }
    }
    const tb = [...contact.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 2);
    if (tb.length < 2 || c.length <= 30) continue;
    for (const p of c) linkPx[p] = 255;
    const lm = new Uint8Array(w * h);
    for (const p of c) lm[p] = 255;
    const polys = centerlinePolylinesFromLineMask(lm, w, h).sort((a, b) => b.length - a.length);
    const pl = polys[0] ?? [];
    links.push({
      a: tb[0]![0],
      b: tb[1]![0],
      A: [tb[0]![1].x / tb[0]![1].n, tb[0]![1].y / tb[0]![1].n],
      B: [tb[1]![1].x / tb[1]![1].n, tb[1]![1].y / tb[1]![1].n],
      polyline: pl,
    });
  }
  const bodies: BodySplit["bodies"] = bodiesRaw.map(() => ({ mask: new Uint8Array(w * h), w, h, x0: w, y0: h, x1: 0, y1: 0, px: 0 }));
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 255 || linkPx[i] === 255 || label[i]! < 0) continue;
    const b = bodies[label[i]!]!;
    b.mask[i] = 255;
    b.px++;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  }
  return { bodies, links };
}

// ---------------------------------------------------------------------------
// stroke order: bodies are units drawn in a fixed internal order; thin
// strokes may be reversed; the unit tour minimizes connector length
// ---------------------------------------------------------------------------
type Unit = { strokes: Stroke[]; body: boolean };

function rotateRing(pts: UnitPt[], pen: UnitPt): UnitPt[] {
  let k = 0;
  let kd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const dd = Math.hypot(pen[0] - pts[i]![0], pen[1] - pts[i]![1]);
    if (dd < kd) {
      kd = dd;
      k = i;
    }
  }
  const ring = pts.slice(0, -1);
  const rot = [...ring.slice(k), ...ring.slice(0, k)];
  rot.push(rot[0]!);
  return rot;
}
function layUnit(u: Unit, pen: UnitPt | null, reverse: boolean): { out: Stroke[]; end: UnitPt; start: UnitPt } {
  const out: Stroke[] = [];
  let p = pen;
  let start: UnitPt | null = null;
  for (const s of u.strokes) {
    let pts = s.pts;
    if (s.closed) {
      if (p) pts = rotateRing(pts, p);
    } else if (!u.body && reverse) pts = pts.slice().reverse();
    else if (!u.body && p) {
      const d0 = Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]);
      const d1 = Math.hypot(p[0] - pts[pts.length - 1]![0], p[1] - pts[pts.length - 1]![1]);
      if (d1 < d0) pts = pts.slice().reverse();
    }
    if (!start) start = pts[0]!;
    out.push({ ...s, pts });
    p = pts[pts.length - 1]!;
  }
  return { out, end: p!, start: start! };
}
export function orderStrokes(strokes: Stroke[]): Stroke[] {
  const units: Unit[] = [];
  const byGroup = new Map<number, Stroke[]>();
  for (const s of strokes) {
    if (s.group !== undefined) {
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group)!.push(s);
    } else units.push({ strokes: [s], body: false });
  }
  for (const [, list] of byGroup) units.unshift({ strokes: list, body: true });
  if (!units.length) return [];
  const d = (a: UnitPt, b: UnitPt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const tour = (order: number[]): { cost: number; out: Stroke[] } => {
    let pen: UnitPt | null = null;
    let cost = 0;
    const out: Stroke[] = [];
    for (const ui of order) {
      const u = units[ui]!;
      let best = layUnit(u, pen, false);
      if (!u.body && pen) {
        const alt = layUnit(u, pen, true);
        if (d(pen, alt.start) < d(pen, best.start)) best = alt;
      }
      if (pen) cost += d(pen, best.start);
      out.push(...best.out);
      pen = best.end;
    }
    return { cost, out };
  };
  const n = units.length;
  let bestOrder: number[] = units.map((_, i) => i);
  let bestCost = Infinity;
  if (n <= 8) {
    const perm = (arr: number[], rest: number[]) => {
      if (!rest.length) {
        const c = tour(arr).cost;
        if (c < bestCost) {
          bestCost = c;
          bestOrder = arr.slice();
        }
        return;
      }
      for (let i = 0; i < rest.length; i++) perm([...arr, rest[i]!], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    };
    perm([], units.map((_, i) => i));
  } else {
    const order: number[] = [0];
    const left = new Set(units.map((_, i) => i).slice(1));
    while (left.size) {
      let bi = -1;
      let bc = Infinity;
      for (const j of left) {
        const c = tour([...order, j]).cost;
        if (c < bc) {
          bc = c;
          bi = j;
        }
      }
      order.push(bi);
      left.delete(bi);
    }
    bestOrder = order;
  }
  return tour(bestOrder).out;
}

// ---------------------------------------------------------------------------
// route one placement
// ---------------------------------------------------------------------------
function isCurvy(s: Stroke): boolean {
  if (s.kind !== "thin") return false;
  if (s.link) return true;
  let turn = 0;
  let len = 0;
  for (let i = 1; i < s.pts.length; i++) {
    len += Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]);
    if (i > 1) {
      const a1 = Math.atan2(s.pts[i - 1]![1] - s.pts[i - 2]![1], s.pts[i - 1]![0] - s.pts[i - 2]![0]);
      const a2 = Math.atan2(s.pts[i]![1] - s.pts[i - 1]![1], s.pts[i]![0] - s.pts[i - 1]![0]);
      let dd = Math.abs(a2 - a1);
      if (dd > Math.PI) dd = 2 * Math.PI - dd;
      turn += dd;
    }
  }
  return turn / Math.max(0.05, len) > 1.5;
}

export function routePlacement(
  g: PainterGraph,
  strokes: Stroke[],
  center: LatLng,
  scaleM: number,
  rot: number,
  quantize = true,
): Routed | null {
  const chain: LatLng[] = [];
  const isInk: boolean[] = [];
  let inkM = 0;
  let connM = 0;
  let visM = 0;
  let dropped = 0;
  let maxGap = 0;
  const painted = new Set<number>();
  const append = (pts: LatLng[], ink = false) => {
    let prevId = -1;
    for (const p of pts) {
      const last = chain[chain.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      if (last) {
        const gm = meters(last, p);
        if (gm > maxGap) maxGap = gm;
      }
      chain.push(p);
      isInk.push(ink);
      const id = nearestNode(g, p).id;
      if (ink) {
        if (prevId >= 0 && id >= 0) painted.add(edgeKey(prevId, id));
      } else if (last && prevId >= 0 && id >= 0 && !painted.has(edgeKey(prevId, id))) visM += meters(last, p);
      prevId = id;
    }
  };
  const targets: [LatLng, LatLng][] = [];
  let footprint = 800;
  for (const s of strokes) for (const p of s.pts) footprint = Math.max(footprint, Math.hypot(p[0], p[1]) * scaleM + 300);
  const L = quantize ? measureLattice(g, center, rot, footprint) : null;

  for (const s of strokes) {
    let target = place(s.pts, center, scaleM, rot);
    const curvy = isCurvy(s);
    let blockified = false;
    if (L && BLOCKIFY && s.kind === "outline" && s.closed) {
      const blocky = blockifyRing(target, L);
      if (blocky) {
        target = blocky;
        blockified = true;
      }
    }
    if (L && s.kind !== "hatch" && !curvy && !blockified) {
      const dense: LatLng[] = [target[0]!];
      for (let i = 1; i < target.length; i++) {
        const a = target[i - 1]!;
        const b = target[i]!;
        const n = Math.max(1, Math.round(meters(a, b) / 120));
        for (let k = 1; k <= n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
      }
      const qt = quantizeTarget(dense, L, s.closed);
      if (qt.length >= (s.closed ? 4 : 2)) target = qt;
    }
    for (let i = 1; i < target.length; i++) targets.push([target[i - 1]!, target[i]!]);
    let piece: LatLng[] | null = null;
    if (s.kind === "hatch") {
      const a = nearestNode(g, target[0]!);
      const b = nearestNode(g, target[1]!);
      if (a.d < 120 && b.d < 120) {
        let ids = straightRun(g, a.id, b.id, target[0]!, target[1]!, 60);
        if (!ids) ids = straightRun(g, a.id, b.id, target[0]!, target[1]!, 140, 12, 40);
        if (ids) piece = ids.map((i) => g.coord[i]!);
        else {
          const res = traceContour(g, target, { anchorM: 220, lambda: 30, corridorM: 120, bendWeight: 60, closeLoop: false, preserveRetraces: false });
          if (res.chain.length >= 2 && res.coverage > 0.8 && res.maxGapM < 150) piece = res.chain;
        }
      }
    } else if (L && !curvy) {
      const ids: number[] = [];
      let ok = true;
      for (let i = 1; i < target.length; i++) {
        const a = nearestNode(g, target[i - 1]!);
        const b = nearestNode(g, target[i]!);
        if (a.d > 90 || b.d > 90) {
          ok = false;
          break;
        }
        let run = straightRun(g, a.id, b.id, target[i - 1]!, target[i]!, 50, 24, 90);
        if (!run) run = straightRun(g, a.id, b.id, target[i - 1]!, target[i]!, 120, 12, 40);
        if (!run) run = walk(g, a.id, b.id, meters(target[i - 1]!, target[i]!) * 2.5 + 300);
        if (!run) {
          ok = false;
          break;
        }
        if (ids.length && ids[ids.length - 1] === run[0]) run = run.slice(1);
        ids.push(...run);
      }
      if (ok && ids.length >= 2) piece = ids.map((i) => g.coord[i]!);
    }
    if (!piece && s.kind !== "hatch") {
      const res = traceContour(
        g,
        target,
        s.kind === "outline"
          ? { anchorM: 200, lambda: 30, corridorM: 65, bendWeight: 60, closeLoop: true, preserveRetraces: false }
          : curvy
            ? { anchorM: 150, lambda: 12, corridorM: 110, bendWeight: 16, closeLoop: false, preserveRetraces: false }
            : { anchorM: 170, lambda: 26, corridorM: 65, bendWeight: 50, closeLoop: false, preserveRetraces: false },
      );
      if (res.chain.length >= 2 && res.coverage > 0.6) {
        const fixed: LatLng[] = [res.chain[0]!];
        for (let i = 1; i < res.chain.length; i++) {
          const prev = fixed[fixed.length - 1]!;
          const cur = res.chain[i]!;
          if (meters(prev, cur) > 120) {
            const w = walk(g, nearestNode(g, prev).id, nearestNode(g, cur).id, 3000);
            if (w) fixed.push(...w.map((k) => g.coord[k]!));
          }
          fixed.push(cur);
        }
        piece = fixed;
      }
    }
    if (!piece || piece.length < 2) {
      dropped++;
      continue;
    }
    if (chain.length) {
      const from = nearestNode(g, chain[chain.length - 1]!).id;
      const to = nearestNode(g, piece[0]!).id;
      const w = walk(g, from, to, 5000, painted);
      if (!w) {
        dropped++;
        continue;
      }
      const cpts = w.map((k) => g.coord[k]!);
      connM += pathMeters(cpts);
      append(cpts);
    }
    inkM += pathMeters(piece);
    append(piece, true);
  }
  if (chain.length < 10) return null;
  // close the loop only when the way back is short or rides painted streets
  const back = walk(g, nearestNode(g, chain[chain.length - 1]!).id, nearestNode(g, chain[0]!).id, 6000, painted);
  if (back) {
    const cpts = back.map((k) => g.coord[k]!);
    let vis = 0;
    let prevId = -1;
    for (const p of cpts) {
      const id = nearestNode(g, p).id;
      if (prevId >= 0 && !painted.has(edgeKey(prevId, id))) vis += meters(g.coord[prevId]!, g.coord[id]!);
      prevId = id;
    }
    if (vis < 600) {
      connM += pathMeters(cpts);
      append(cpts);
    }
  }
  let dev = 0;
  let n = 0;
  for (let i = 0; i < chain.length; i += 2) {
    let m = Infinity;
    for (const [a, b] of targets) {
      const dd = distToSeg(chain[i]!, a, b);
      if (dd < m) m = dd;
    }
    dev += Math.min(m, 400);
    n++;
  }
  const devM = dev / Math.max(1, n);
  const fidelity = devM + 60 * (visM / Math.max(1, inkM)) + 25 * dropped;
  return {
    chain,
    isInk,
    km: pathMeters(chain) / 1000,
    inkKm: inkM / 1000,
    connectorKm: connM / 1000,
    visibleConnKm: visM / 1000,
    dropped,
    strokes: strokes.length,
    maxGap,
    devM,
    fidelity,
  };
}

// ---------------------------------------------------------------------------
// the whole thing: mask -> best routed seats
// ---------------------------------------------------------------------------
export type PaintResult = {
  candidates: PaintCandidate[];
  layout: "keep" | "stack" | "none";
  legalSeats: number;
  routedSeats: number;
};

export function paintOnStreets(g: PainterGraph, maskIn: Uint8Array, wIn: number, hIn: number, options: PaintOptions = {}): PaintResult {
  const started = Date.now();
  const budget = options.timeBudgetMs ?? 50_000;
  const timeLeft = () => budget - (Date.now() - started);
  const progress = options.onProgress ?? (() => {});
  const rows = options.rows ?? 3;
  const openM = options.openM ?? 60;
  const pitchM = options.pitchM ?? 160;
  const picks = options.picks ?? 3;
  const [LAT0, LAT1] = options.latRange ?? [40.735, 40.8];
  const [LNG0, LNG1] = options.lngRange ?? [-74.005, -73.945];
  const latFloor = 40.737;

  type Cand = { center: LatLng; scale: number; rot: number; score: number; plan: Plan };
  const sweep = (layoutMode: "keep" | "stack" | "none"): Cand[] => {
    let mask = maskIn;
    let w = wIn;
    let h = hIn;
    let extraThin: [number, number][][] = [];
    let scales = options.scales ?? [1400, 1800, 2400];
    if (layoutMode !== "none") {
      const lay = relayout(mask, w, h, layoutMode);
      if (lay) {
        mask = lay.mask;
        w = lay.w;
        h = lay.h;
        extraThin = lay.links;
        if (layoutMode === "stack" && !options.scales) {
          // the smallest body must be at least ~1100 m wide to resolve
          let minX = w;
          let maxX = 0;
          let minY = h;
          let maxY = 0;
          for (let i = 0; i < w * h; i++) {
            if (mask[i] !== 255) continue;
            const x = i % w;
            const y = (i / w) | 0;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          const span = Math.max(maxX - minX, maxY - minY) || 1;
          const s0 = Math.round(1100 / ((lay.smallestBodyWidthPx * 2) / span) / 50) * 50;
          scales = [s0, Math.round((s0 * 1.2) / 50) * 50];
        }
      } else if (layoutMode === "stack") return [];
    }
    const cands: Cand[] = [];
    for (const scale of scales) {
      const plan = makePlan(mask, w, h, scale, { pitchM, rows, openM }, extraThin);
      if (!plan.strokes.length) continue;
      const samples: UnitPt[] = [];
      const linkSamples: UnitPt[] = [];
      for (const s of plan.strokes) {
        for (let i = 1; i < s.pts.length; i++) {
          const a = s.pts[i - 1]!;
          const b = s.pts[i]!;
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * scale;
          const n = Math.max(1, Math.round(len / 60));
          for (let k = 0; k <= n; k++) (s.link ? linkSamples : samples).push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
        }
      }
      if (!samples.length) continue;
      const ext: [number, number] = [
        Math.max(...samples.map((p) => Math.abs(p[0]))) * 0.85,
        Math.max(...samples.map((p) => Math.abs(p[1]))) * 0.85,
      ];
      for (let lat = LAT0; lat <= LAT1; lat += 0.004) {
        for (let lng = LNG0; lng <= LNG1; lng += 0.005) {
          const info = localGridInfo(g, [lat, lng]);
          if (!info || info.uniform < 0.55) continue;
          const rot = info.rot;
          let mixed = false;
          for (const fx of [-1, 0, 1]) {
            for (const fy of [-1, 0, 1]) {
              if (!fx && !fy) continue;
              const pr = place([[fx * ext[0], fy * ext[1]]], [lat, lng], scale, rot)[0]!;
              const q = localGridInfo(g, pr);
              if (!q || q.uniform < 0.45) {
                mixed = true;
                break;
              }
              const da = Math.min(Math.abs(q.axis - info.axis), 90 - Math.abs(q.axis - info.axis));
              if (da > 10) {
                mixed = true;
                break;
              }
            }
            if (mixed) break;
          }
          if (mixed) continue;
          const placed = place(samples, [lat, lng], scale, rot);
          let below = false;
          for (const p of placed) {
            const floor = p[1] > -73.96 ? 0 : p[1] > -73.992 ? 40.7225 : latFloor;
            if (p[0] < floor) {
              below = true;
              break;
            }
          }
          if (below) continue;
          let sum = 0;
          let miss = 0;
          let park = false;
          const missCap = Math.max(3, Math.floor(placed.length * 0.03));
          for (const p of placed) {
            if (inPoly(p, PARK)) {
              park = true;
              break;
            }
            const { d } = nearestNode(g, p);
            if (d > 130) {
              miss++;
              if (miss > missCap) break;
            }
            sum += Math.min(d, 130);
          }
          if (park || miss > missCap) continue;
          if (linkSamples.length) {
            let lmiss = 0;
            for (const p of place(linkSamples, [lat, lng], scale, rot)) if (nearestNode(g, p).d > 130) lmiss++;
            if (lmiss > Math.max(2, linkSamples.length * 0.05)) continue;
          }
          cands.push({ center: [lat, lng], scale, rot, score: sum / placed.length, plan });
        }
      }
    }
    return cands;
  };

  const modes: ("keep" | "stack" | "none")[] =
    options.layout === "auto" || options.layout === undefined ? ["keep", "stack"] : [options.layout];
  let cands: Cand[] = [];
  let layout: "keep" | "stack" | "none" = "none";
  for (const m of modes) {
    progress(m === "stack" ? "Re-arranging the parts to fit the grid…" : "Reading the street grid for a seat…");
    cands = sweep(m);
    layout = m;
    if (cands.length) break;
  }
  cands.sort((a, b) => a.score - b.score);
  const shortlist: Cand[] = [];
  for (const c of cands) {
    if (shortlist.length >= 24) break;
    if (shortlist.some((p) => meters(p.center, c.center) < 500 && p.scale === c.scale)) continue;
    shortlist.push(c);
  }
  progress(`Drawing ${shortlist.length} candidate seats on real streets…`);
  const routed: { c: Cand; r: Routed }[] = [];
  for (const c of shortlist) {
    if (timeLeft() < 4000 && routed.length) break;
    const r = routePlacement(g, orderStrokes(c.plan.strokes), c.center, c.scale, c.rot);
    if (r) routed.push({ c, r });
  }
  routed.sort((a, b) => a.r.fidelity - b.r.fidelity);
  const out: PaintCandidate[] = [];
  for (const x of routed) {
    if (out.length >= picks) break;
    if (out.some((p) => meters(p.center, x.c.center) < 900 && p.scaleM === x.c.scale)) continue;
    let best = x.r;
    let center = x.c.center;
    if (timeLeft() > 12_000) {
      // micro-refinement: nudge the seat +-60 m so edges settle onto streets
      const ordered = orderStrokes(x.c.plan.strokes);
      for (const dl of [-0.0006, 0, 0.0006]) {
        for (const dg of [-0.0008, 0, 0.0008]) {
          if ((!dl && !dg) || timeLeft() < 4000) continue;
          const c2: LatLng = [x.c.center[0] + dl, x.c.center[1] + dg];
          const r2 = routePlacement(g, ordered, c2, x.c.scale, x.c.rot);
          if (r2 && r2.fidelity < best.fidelity) {
            best = r2;
            center = c2;
          }
        }
      }
    }
    out.push({ ...best, center, scaleM: x.c.scale, rotDeg: x.c.rot, layout });
  }
  return { candidates: out, layout, legalSeats: cands.length, routedSeats: routed.length };
}
