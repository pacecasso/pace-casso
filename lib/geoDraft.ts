/**
 * GEO DRAFT — the zero-model-call first draft (the engine behind the gas
 * route Ralph approved on Sep 12, moved out of scripts/finisher-geo.ts so
 * the site can run it).
 *
 * The upload's mask becomes strokes (lib/strokePainter makePlan), a seat
 * sweep routes those strokes at every grid-aligned, near-upright placement
 * in the window, each routed candidate is scored by lib/strokeLikeness
 * (render-and-compare against the upload, ~5 ms, free), and a greedy climb
 * of small stroke / placement edits polishes the best seats. No Mapbox, no
 * language model. Everything here is pure and time-budgeted so a serverless
 * request can run it.
 */
import { place, type LatLng } from "./streetGraphTrace";
import {
  HUG_TOL_M,
  TRACE,
  localGridInfo,
  makePlan,
  meters,
  nearestNode,
  orderStrokes,
  routePlacement,
  setHugTolerance,
  type PainterGraph,
  type Routed,
  type Stroke,
  type UnitPt,
} from "./strokePainter";
import { buildTarget, latLngToUnit, likenessAgainst, type Likeness, type Placement, type Target } from "./strokeLikeness";
import { blockPlan, type BlockPlanOptions } from "./blockPlan";

// ---------------------------------------------------------------------------
// the drawing state and the edit moves
// ---------------------------------------------------------------------------
export type State = { strokes: Stroke[]; center: LatLng; scale: number; rot: number };
export type Rng = () => number;
export function makeRng(seed: number): Rng {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
export const cloneStrokes = (s: Stroke[]): Stroke[] => s.map((k) => ({ ...k, pts: k.pts.map((p) => [p[0], p[1]] as UnitPt) }));
export const strokeLen = (s: Stroke) => {
  let l = 0;
  for (let i = 1; i < s.pts.length; i++) l += Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]);
  return l;
};
function pickStroke(strokes: Stroke[], rnd: Rng): number {
  const w = strokes.map((s) => Math.max(0.05, strokeLen(s)));
  const total = w.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < w.length; i++) {
    r -= w[i]!;
    if (r <= 0) return i;
  }
  return w.length - 1;
}
function turnAt(pts: UnitPt[], i: number): number {
  if (i <= 0 || i >= pts.length - 1) return 0;
  const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}
export function rdp(pts: UnitPt[], eps: number): UnitPt[] {
  if (pts.length < 3) return pts;
  const d2 = (p: UnitPt, a: UnitPt, b: UnitPt) => {
    const bx = b[0] - a[0], by = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * bx + (p[1] - a[1]) * by) / (bx * bx + by * by || 1)));
    return Math.hypot(p[0] - a[0] - t * bx, p[1] - a[1] - t * by);
  };
  let idx = -1, md = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = d2(pts[i]!, pts[0]!, pts[pts.length - 1]!);
    if (d > md) { md = d; idx = i; }
  }
  if (md > eps) return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  return [pts[0]!, pts[pts.length - 1]!];
}

export type Move = { kind: string; detail: string };
/** one small edit; `placementMoves` false keeps the seat fixed (strokes only) */
export function propose(st: State, blockU: number, rnd: Rng, placementMoves = true): { next: State; move: Move } {
  const next: State = { strokes: cloneStrokes(st.strokes), center: [st.center[0], st.center[1]], scale: st.scale, rot: st.rot };
  const r = rnd() * (placementMoves ? 1 : 0.85);
  if (r < 0.6) {
    const si = pickStroke(next.strokes, rnd);
    const s = next.strokes[si]!;
    const pts = s.pts;
    if (pts.length < 3) return propose(st, blockU, rnd, placementMoves);
    const weights = pts.map((_, i) => 0.3 + turnAt(pts, i));
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = rnd() * total, vi = 0;
    for (let i = 0; i < weights.length; i++) { acc -= weights[i]!; if (acc <= 0) { vi = i; break; } }
    const mag = blockU * (0.4 + rnd() * 1.8);
    const ang = rnd() * 2 * Math.PI;
    const dx = Math.cos(ang) * mag, dy = Math.sin(ang) * mag;
    const radius = blockU * 1.5;
    const dist = new Array<number>(pts.length).fill(Infinity);
    dist[vi] = 0;
    for (let i = vi + 1; i < pts.length; i++) dist[i] = dist[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    for (let i = vi - 1; i >= 0; i--) dist[i] = dist[i + 1]! + Math.hypot(pts[i]![0] - pts[i + 1]![0], pts[i]![1] - pts[i + 1]![1]);
    for (let i = 0; i < pts.length; i++) {
      const f = Math.exp(-((dist[i]! / radius) ** 2));
      if (f < 0.02) continue;
      pts[i] = [pts[i]![0] + dx * f, pts[i]![1] + dy * f];
    }
    if (s.closed) pts[pts.length - 1] = [pts[0]![0], pts[0]![1]];
    return { next, move: { kind: "drag", detail: `stroke ${si} v${vi} by ${(mag / blockU).toFixed(1)} blocks` } };
  }
  if (r < 0.72) {
    const si = pickStroke(next.strokes, rnd);
    const s = next.strokes[si]!;
    let cx = 0, cy = 0;
    for (const p of s.pts) { cx += p[0]; cy += p[1]; }
    cx /= s.pts.length; cy /= s.pts.length;
    if (rnd() < 0.5) {
      const dx = (rnd() - 0.5) * 2 * blockU, dy = (rnd() - 0.5) * 2 * blockU;
      s.pts = s.pts.map((p) => [p[0] + dx, p[1] + dy] as UnitPt);
      return { next, move: { kind: "shift-stroke", detail: `stroke ${si}` } };
    }
    const k = 1 + (rnd() - 0.5) * 0.3;
    s.pts = s.pts.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k] as UnitPt);
    return { next, move: { kind: "scale-stroke", detail: `stroke ${si} x${k.toFixed(2)}` } };
  }
  if (r < 0.8) {
    const si = pickStroke(next.strokes, rnd);
    const s = next.strokes[si]!;
    const eps = blockU * (0.3 + rnd() * 0.5);
    const before = s.pts.length;
    const pts = rdp(s.pts, eps);
    if (s.closed && pts.length > 2) pts[pts.length - 1] = [pts[0]![0], pts[0]![1]];
    if (pts.length >= (s.closed ? 4 : 2)) s.pts = pts;
    return { next, move: { kind: "simplify", detail: `stroke ${si} ${before}->${s.pts.length} pts` } };
  }
  if (r < 0.85 && next.strokes.length > 1) {
    const lens = next.strokes.map(strokeLen);
    const biggest = lens.indexOf(Math.max(...lens));
    const cands = next.strokes.map((_, i) => i).filter((i) => i !== biggest);
    const si = cands[Math.floor(rnd() * cands.length)]!;
    next.strokes.splice(si, 1);
    return { next, move: { kind: "drop", detail: `stroke ${si}` } };
  }
  if (r < 0.92) {
    next.center = [st.center[0] + ((rnd() - 0.5) * 2 * blockU * st.scale) / 111320, st.center[1] + ((rnd() - 0.5) * 2 * blockU * st.scale) / (111320 * Math.cos((st.center[0] * Math.PI) / 180))];
    return { next, move: { kind: "shift-all", detail: "" } };
  }
  if (r < 0.96) {
    next.rot = st.rot + (rnd() - 0.5) * 8;
    return { next, move: { kind: "rotate", detail: `${next.rot.toFixed(1)}°` } };
  }
  next.scale = Math.round(st.scale * (1 + (rnd() - 0.5) * 0.12));
  return { next, move: { kind: "rescale", detail: `${next.scale} m` } };
}

// ---------------------------------------------------------------------------
// the search
// ---------------------------------------------------------------------------
export type GeoDraftOptions = {
  /** sweep window: south lat, west lng, north lat, east lng */
  bbox: [number, number, number, number];
  /** half-sizes of the placed drawing in metres */
  scales: number[];
  /** seat grid spacing in metres */
  stepM: number;
  /** diverse seats carried into the climb */
  top: number;
  /** max climb iterations over all seeds */
  iters: number;
  /** degrees from north-up a seat may lean */
  maxRot: number;
  /** likeness tolerance as a fraction of the drawing's half-span */
  tolU: number;
  maxKm: number;
  openM: number;
  /**
   * Plan the drawing with lib/blockPlan (block-grid outlines + centre lines for
   * thin ink and thin gaps) instead of makePlan's outline + hatch. `true` takes
   * its defaults. Off by default so existing callers are unchanged.
   */
  blockPlan?: boolean | BlockPlanOptions;
  hugM: number;
  sweepBudgetMs: number;
  totalBudgetMs: number;
  seed: number;
  /**
   * A designed drawing (the design step's strokes, unit space) instead of the
   * mask's traced outline, plus sample points of the strokes that carry the
   * subject's identity. Missing a defining feature costs heavily: the outline
   * alone scores well on a blob, which is how the whale lost its eye and spout.
   */
  design?: { strokes: Stroke[]; features: UnitPt[][] };
  /**
   * The design is drawn on the street grid itself (runs along avenues and
   * streets). Routing snaps every run to the measured lattice, the drawing
   * is never reshaped (only the seat moves), and likeness / feature checks
   * use a tight metric tolerance so a feature the streets lost is counted
   * as lost (Sep 16: the loose check reported 100% on missing features).
   */
  grid?: { tolM: number };
  /** areas the drawing must not touch (e.g. Central Park, where paths curve and the grid breaks) */
  avoid?: LatLng[][];
  /**
   * How small a part may be, relative to the biggest part, before it is culled.
   * The painter's default (0.12) deletes a cartoon face's eyebrows for being
   * 6.6 % of its mouth. Lower it to keep small defining features.
   */
  minRelMass?: number;
  /**
   * Hard reject a seat whose worst stroke-to-stroke gap exceeds this, in metres.
   * Historically a flat 400 m, which is 16 % of a 2,500 m drawing but only 7 %
   * of a 5,600 m one - so the bigger the drawing, the tighter the tolerance
   * got, and large sizes were rejected as `no-seat` for gaps that are smaller
   * in proportion than the ones accepted at 2,500 m.
   */
  maxGapM?: number;
  /**
   * Size-relative form of `maxGapM`: the limit becomes
   * `max(maxGapM, maxGapFrac * halfSize)`. 0.16 reproduces the historical 400 m
   * at half-size 2,500 m and grows from there. Defaults to 0, so nothing
   * changes unless a caller asks.
   */
  maxGapFrac?: number;
  /**
   * How many strokes a seat may fail to route and still be kept. Historically
   * 0: ONE unroutable stroke threw away the whole placement, so a multi-part
   * logo whose thinnest part (the gas pump's hose) will not lie on streets
   * could never seat at any size where that part survived the cull.
   */
  maxDropped?: number;
  /**
   * Passed through to `likenessAgainst`. The default 0.1 halves the score at
   * ten self-crossings, so the search systematically prefers routes that never
   * cross - which rules out every design whose identity REQUIRES a crossing:
   * interlocking letters, a looping hose, a tail curling back over a body.
   * Ralph, Sep 20: backtracking is fine if it improves the art.
   */
  crossingWeight?: number;
  /**
   * Called between chunks of work; await it so a stream can flush. `pct` is
   * how far through the whole draft we are (0-100), so the UI can show a real
   * progress bar instead of narrating what the search is doing (Ralph, Sep 18:
   * "just show a clear pronounced progress bar").
   */
  onProgress?: (detail: string, pct?: number) => void | Promise<void>;
};

/** Sep 12 approved recipe: Manhattan core sweep, two sizes, three seeds */
export const MANHATTAN_GEO_DEFAULTS: GeoDraftOptions = {
  bbox: [40.7, -74.02, 40.78, -73.94],
  scales: [1300, 1700],
  stepM: 500,
  top: 3,
  iters: 900,
  maxRot: 40,
  tolU: 0.09,
  maxKm: 45,
  openM: 60,
  hugM: 90,
  sweepBudgetMs: 150_000,
  totalBudgetMs: 240_000,
  seed: 1,
};

/**
 * Brooklyn + Queens on the `nyc-core` graph: the recipe that first produced a
 * cat with BOTH EARS AND A TAIL (Sep 19-20). Manhattan cannot hold a drawing
 * this big — 2,052 full-fidelity placements were swept there and the ears
 * never appeared — so the wall the project kept hitting was the island, not
 * the algorithm.
 *
 * `scales` holds ONE size on purpose. Sweeping 2500/3200/4000 together splits
 * one budget three ways, and a big size costs more per iteration (269 s vs
 * 155 s), so the large sizes were being starved rather than beaten: run alone
 * with the whole budget, 4000 wins. The API walks a ladder of these instead.
 *
 * `minRelMass` 0.02 keeps small defining parts (the painter's 0.12 default
 * deletes a face's eyebrows for being 6.6 % of its mouth).
 */
export const BROOKLYN_GEO_DEFAULTS: GeoDraftOptions = {
  bbox: [40.58, -74.03, 40.74, -73.78],
  scales: [4000],
  stepM: 2500,
  top: 3,
  iters: 600,
  maxRot: 40,
  tolU: 0.09,
  // the cat comes out at 33 km; this only rejects seats, and a drawing that
  // needs more than 100 km is not a route anyone runs
  maxKm: 100,
  openM: 60,
  hugM: 90,
  minRelMass: 0.02,
  sweepBudgetMs: 90_000,
  totalBudgetMs: 130_000,
  seed: 1,
};

export type GeoEval = { r: Routed; lk: Likeness; feature: { mean: number; min: number }; score: number };

/**
 * How much of each defining feature the route passes near: the share of a
 * feature's sample points with route within `tolU` (unit space). Returns
 * the mean and the worst feature; 1/1 when there are no features.
 */
export function featureCoverage(features: UnitPt[][], chain: LatLng[], pl: Placement, tolU: number): { mean: number; min: number } {
  if (!features.length) return { mean: 1, min: 1 };
  const cell = tolU;
  const grid = new Map<string, UnitPt[]>();
  const add = (p: UnitPt) => {
    const k = `${Math.floor(p[0] / cell)}:${Math.floor(p[1] / cell)}`;
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(p);
  };
  let prev: UnitPt | null = null;
  for (const ll of chain) {
    const u = latLngToUnit(ll, pl);
    if (prev) {
      const n = Math.max(1, Math.ceil(Math.hypot(u[0] - prev[0], u[1] - prev[1]) / (cell * 0.5)));
      for (let i = 1; i <= n; i++) add([prev[0] + ((u[0] - prev[0]) * i) / n, prev[1] + ((u[1] - prev[1]) * i) / n]);
    } else add(u);
    prev = u;
  }
  const near = (p: UnitPt) => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const q of grid.get(`${gx + dx}:${gy + dy}`) ?? []) if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= tolU) return true;
    return false;
  };
  let sum = 0, min = 1;
  for (const pts of features) {
    if (!pts.length) continue;
    const c = pts.filter(near).length / pts.length;
    sum += c;
    if (c < min) min = c;
  }
  return { mean: sum / features.length, min };
}

/** likeness scaled by feature coverage: the mean matters, and one lost feature still hurts */
export const combinedScore = (lk: number, f: { mean: number; min: number }) => lk * (0.25 + 0.75 * f.mean) * (0.5 + 0.5 * f.min);
export type GeoDraftResult = {
  ok: boolean;
  reason?: "no-strokes" | "no-seat";
  chain?: LatLng[];
  /**
   * The drawing behind the route, in unit space, at the seat below. The route
   * alone cannot be edited as a DRAWING - dropping a stroke or adding one means
   * re-routing, which needs these. The only two routes Ralph has ever approved
   * (gas and unicorn, Sep 8/12) were a draft plus three or four stroke edits,
   * and that step has never existed on the site because the draft threw its
   * strokes away here.
   */
  strokes?: Stroke[];
  km?: number;
  inkKm?: number;
  score?: number;
  likeness?: number;
  featureMean?: number;
  featureMin?: number;
  recall?: number;
  precision?: number;
  crossings?: number;
  center?: LatLng;
  scale?: number;
  rot?: number;
  seatsRouted?: number;
  climbIters?: number;
  accepted?: number;
  ms?: number;
};

export const normRot = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** grid-aligned orientations that keep the drawing near upright */
export function uprightRots(gridRot: number, maxRot: number): number[] {
  const out: number[] = [];
  for (const k of [0, 90, -90, 180]) {
    const a = normRot(gridRot + k);
    if (Math.abs(a) <= maxRot && !out.some((b) => Math.abs(b - a) < 1)) out.push(a);
  }
  return out;
}

/** the painter's knobs are module globals; set them only for the duration of one synchronous call */
function withPainterKnobs<T>(hugM: number, fn: () => T): T {
  const prevHug = HUG_TOL_M;
  const prevTrim = TRACE.trimNubs;
  setHugTolerance(hugM);
  TRACE.trimNubs = true;
  try {
    return fn();
  } finally {
    setHugTolerance(prevHug);
    TRACE.trimNubs = prevTrim;
  }
}

/**
 * Drop the builder's walk back to the start when the drawing ends far from
 * where it began: that walk rides adjacent streets and reads as a stray line
 * (learned on the approved gas route). When the ink already ends near the
 * start, the walk is what closes the outline, so it stays (Sep 16 whale
 * test: trimming it left a 280 m gap in a single-loop shape).
 */
export const CLOSE_LOOP_M = 400;
export function trimClosingWalk(r: Routed): Routed {
  let last = r.chain.length - 1;
  while (last > 0 && !r.isInk[last]) last--;
  if (last <= 0 || last >= r.chain.length - 1) return r;
  if (meters(r.chain[last]!, r.chain[0]!) <= CLOSE_LOOP_M) return r;
  const chain = r.chain.slice(0, last + 1);
  let m = 0;
  for (let i = 1; i < chain.length; i++) m += meters(chain[i - 1]!, chain[i]!);
  return { ...r, chain, isInk: r.isInk.slice(0, last + 1), km: m / 1000 };
}

export function insidePolygon(p: LatLng, poly: LatLng[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[0] > p[0] !== b[0] > p[0] && p[1] < ((b[1] - a[1]) * (p[0] - a[0])) / (b[0] - a[0]) + a[1]) c = !c;
  }
  return c;
}

/** Central Park (59th-110th, Fifth Ave to Central Park West), slightly inset so its edge avenues stay usable */
export const CENTRAL_PARK: LatLng[] = [
  [40.7652, -73.9745],
  [40.7678, -73.9808],
  [40.7995, -73.9578],
  [40.7968, -73.9510],
];

/** grid designs keep their shape: move the whole seat by up to about one avenue */
function shiftSeat(st: State, rnd: Rng): State {
  const dx = (rnd() - 0.5) * 2 * 280, dy = (rnd() - 0.5) * 2 * 280;
  return { ...st, center: [st.center[0] + dy / 111320, st.center[1] + dx / (111320 * Math.cos((st.center[0] * Math.PI) / 180))] };
}

const yieldTick = () => new Promise<void>((res) => setTimeout(res, 0));

export async function geoDraft(g: PainterGraph, mask: Uint8Array, w: number, h: number, opts: GeoDraftOptions): Promise<GeoDraftResult> {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const rnd = makeRng(opts.seed);
  const t: Target = buildTarget(mask, w, h);
  const progress = async (s: string, pct?: number) => {
    await opts.onProgress?.(s, pct);
    await yieldTick();
  };

  const evaluate = (st: State): GeoEval | null => {
    if (Math.abs(normRot(st.rot)) > opts.maxRot) return null;
    // a grid design only holds its shape where the grid is regular: keep the seat inside the window
    if (opts.grid && (st.center[0] < opts.bbox[0] || st.center[0] > opts.bbox[2] || st.center[1] < opts.bbox[1] || st.center[1] > opts.bbox[3])) return null;
    const r = withPainterKnobs(opts.hugM, () => routePlacement(g, orderStrokes(st.strokes), st.center, st.scale, st.rot, Boolean(opts.grid)));
    const gapLimit = Math.max(opts.maxGapM ?? 400, (opts.maxGapFrac ?? 0) * st.scale);
    if (process.env.SEATDEBUG) {
      const d = (globalThis as Record<string, unknown>).__seat as Record<string, number> | undefined
        ?? ((globalThis as Record<string, unknown>).__seat = { noRoute: 0, dropped: 0, gap: 0, km: 0, rot: 0, ok: 0, maxGapSeen: 0, maxKmSeen: 0 }) as Record<string, number>;
      if (!r) d.noRoute++;
      else {
        d.maxGapSeen = Math.max(d.maxGapSeen, r.maxGap);
        d.maxKmSeen = Math.max(d.maxKmSeen, r.km);
        if (r.dropped > (opts.maxDropped ?? 0)) d.dropped++;
        else if (r.maxGap > gapLimit) d.gap++;
        else if (r.km > opts.maxKm) d.km++;
        else d.ok++;
      }
    }
    if (!r || r.dropped > (opts.maxDropped ?? 0) || r.maxGap > gapLimit || r.km > opts.maxKm) return null;
    if (opts.avoid?.length && r.chain.some((p) => opts.avoid!.some((poly) => insidePolygon(p, poly)))) return null;
    const pl = { center: st.center, scale: st.scale, rot: st.rot };
    const tolU = opts.grid ? opts.grid.tolM / st.scale : opts.tolU;
    const lk = likenessAgainst(t, r.chain, pl, { tolU, crossingWeight: opts.crossingWeight });
    const feature = opts.design ? featureCoverage(opts.design.features, r.chain, pl, tolU) : { mean: 1, min: 1 };
    return { r, lk, feature, score: opts.design ? combinedScore(lk.score, feature) : lk.score };
  };
  const onLand = (center: LatLng, scale: number, rot: number) =>
    place([[0, 0], [-0.7, -0.7], [0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]], center, scale, rot).every((p) => nearestNode(g, p).d < 250);

  // ---- seat list (cheap), nearest-to-centre first so a short budget still covers the core
  const [lat1, lng1, lat2, lng2] = opts.bbox;
  const midLat = (lat1 + lat2) / 2, midLng = (lng1 + lng2) / 2;
  const dLat = opts.stepM / 111320;
  const dLng = opts.stepM / (111320 * Math.cos((midLat * Math.PI) / 180));
  const plans = new Map<number, Stroke[]>();
  for (const scale of opts.scales) {
    if (opts.design) {
      if (opts.design.strokes.length) plans.set(scale, opts.design.strokes);
      continue;
    }
    if (opts.blockPlan) {
      /**
       * The Sep 23 plan step: quantise mass onto the city's block grid, split
       * parts along thin gaps, draw thin ink and outline drawings as centre
       * lines. Produced the heart / Strava / cat routes with zero connectors.
       */
      const bp = blockPlan(mask, w, h, opts.blockPlan === true ? {} : opts.blockPlan);
      if (bp.strokes.length) plans.set(scale, bp.strokes);
      continue;
    }
    const plan = withPainterKnobs(opts.hugM, () => makePlan(mask, w, h, scale, { pitchM: 160, rows: 0, openM: opts.openM, minRelMass: opts.minRelMass }, []));
    if (plan.strokes.length) plans.set(scale, plan.strokes);
  }
  if (!plans.size) return { ok: false, reason: "no-strokes", ms: elapsed() };
  const seats: State[] = [];
  for (let lat = lat1; lat <= lat2; lat += dLat)
    for (let lng = lng1; lng <= lng2; lng += dLng) {
      const c: LatLng = [lat, lng];
      const gi = localGridInfo(g, c);
      for (const [scale, strokes] of plans)
        for (const rot of uprightRots(gi ? gi.rot : 0, opts.maxRot)) if (onLand(c, scale, rot)) seats.push({ strokes, center: c, scale, rot });
    }
  // interleave by distance from the window centre so any prefix is spread over the whole core
  seats.sort((a, b) => Math.hypot(a.center[0] - midLat, a.center[1] - midLng) - Math.hypot(b.center[0] - midLat, b.center[1] - midLng));
  await progress("Finding the best spot on the map", 4);

  // ---- sweep
  const found: { st: State; ev: GeoEval }[] = [];
  let routed = 0;
  let lastNote = Date.now();
  for (const st of seats) {
    if (elapsed() > opts.sweepBudgetMs) break;
    routed++;
    const ev = evaluate(st);
    if (ev) found.push({ st, ev });
    if (Date.now() - lastNote > 1500) {
      lastNote = Date.now();
      // the sweep owns 4-60% of the bar, by seats tried. The bar carries the
      // signal now, so the label stays a plain, stable phrase (Ralph, Sep 18:
      // the running commentary about polishing and matching was noise).
      await progress(
        "Finding the best spot on the map",
        4 + 56 * Math.min(1, routed / Math.max(1, seats.length)),
      );
    }
  }
  if (!found.length) return { ok: false, reason: "no-seat", seatsRouted: routed, ms: elapsed() };
  found.sort((a, b) => b.ev.score - a.ev.score);
  const seeds: { st: State; ev: GeoEval }[] = [];
  for (const f of found) {
    if (seeds.length >= opts.top) break;
    const far = seeds.every((p) => Math.hypot((p.st.center[0] - f.st.center[0]) * 111320, (p.st.center[1] - f.st.center[1]) * 84000) > 1500 || p.st.scale !== f.st.scale);
    if (far) seeds.push(f);
  }

  // ---- climb: split the remaining time evenly over the seeds
  await progress("Fitting your drawing to the streets", 60);
  let best: { st: State; ev: GeoEval; accepted: number } | null = null;
  let climbIters = 0;
  const per = Math.max(50, Math.floor(opts.iters / seeds.length));
  for (let i = 0; i < seeds.length; i++) {
    const seedStart = elapsed();
    const seedBudget = (opts.totalBudgetMs - seedStart) / (seeds.length - i);
    let cur = seeds[i]!.st;
    let curEv = seeds[i]!.ev;
    let accepted = 0, stale = 0;
    const blockU = 110 / cur.scale;
    for (let it = 1; it <= per; it++) {
      if (elapsed() - seedStart > seedBudget) break;
      climbIters++;
      const next = opts.grid ? shiftSeat(cur, rnd) : propose(cur, blockU, rnd, true).next;
      const ev = evaluate(next);
      if (ev && ev.score > curEv.score + 0.05) {
        cur = next;
        curEv = ev;
        accepted++;
        stale = 0;
      } else if (++stale >= 250) break;
      // the climb owns 60-98% of the bar, by time spent against the budget
      if (it % 20 === 0)
        await progress(
          "Fitting your drawing to the streets",
          60 + 38 * Math.min(1, elapsed() / Math.max(1, opts.totalBudgetMs)),
        );
    }
    if (!best || curEv.score > best.ev.score) best = { st: cur, ev: curEv, accepted };
  }
  const b = best!;
  const r = trimClosingWalk(b.ev.r);
  return {
    ok: true,
    chain: r.chain,
    strokes: b.st.strokes,
    km: r.km,
    inkKm: r.inkKm,
    score: b.ev.score,
    likeness: b.ev.lk.score,
    featureMean: b.ev.feature.mean,
    featureMin: b.ev.feature.min,
    recall: b.ev.lk.recall,
    precision: b.ev.lk.precision,
    crossings: b.ev.lk.crossings,
    center: b.st.center,
    scale: b.st.scale,
    rot: b.st.rot,
    seatsRouted: routed,
    climbIters,
    accepted: b.accepted,
    ms: elapsed(),
  };
}
