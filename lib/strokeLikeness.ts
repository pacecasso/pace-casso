/**
 * Stroke likeness — a free, deterministic "does the routed line look like
 * the uploaded drawing" score. It replaces the vision judge INSIDE the
 * finisher's search loop (the judge cost several model calls per move and
 * scored Ralph's approved routes 0/3, so it was both expensive and off his
 * eye). The model, if used at all, verifies once at the end.
 *
 * Method: project the routed chain back into the drawing's unit space with
 * the placement it was routed under, rasterize both the drawing's ink
 * boundary and the route onto a coarse grid (about one short block per
 * cell), then measure with distance transforms:
 *   recall    — how much of the drawing's boundary has route within `tolM`
 *   precision — how much of the route is near the boundary or inside the
 *               filled ink (route inside a filled mass is neutral: hatch)
 * Score is the harmonic mean, 0..100. Zero model calls, ~10 ms.
 */
import type { LatLng } from "./streetGraphTrace";

export type UnitPt = [number, number];
export type Placement = { center: LatLng; scale: number; rot: number };
export type MaskFrame = { w: number; h: number; cx: number; cy: number; span: number };
export type LikenessOpts = {
  /** grid cells per side (default 128) */
  px?: number;
  /** unit-space half-extent covered by the grid (default 1.3 → 30 % margin) */
  marginU?: number;
  /** distance at which credit reaches zero, as a fraction of the drawing's half-span (default 0.09: ~117 m at scale 1300, ~200 m at 2200 — the eye judges the whole picture, so a bigger drawing earns the same credit for the same relative deviation) */
  tolU?: number;
  /** override: tolerance in metres (converted with the placement scale) */
  tolM?: number;
  /** precision credit for route inside a filled mass but off its boundary (default 0.5; 1 = neutral, for hatch styles) */
  interiorCredit?: number;
  /** score divisor grows by this per self-crossing (default 0.1: 10 crossings halve the score) */
  crossingWeight?: number;
};
export type Likeness = {
  score: number;
  recall: number;
  precision: number;
  crossings: number;
  targetCells: number;
  routeCells: number;
  mPerCell: number;
};

const M_PER_LAT = 111320;
const mPerLng = (lat: number) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);
const INF = 1e12;

/** Same bbox frame makePlan uses: unit x = (px - cx) * 2 / span, unit y = (cy - py) * 2 / span. */
export function maskFrame(mask: Uint8Array, w: number, h: number): MaskFrame {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 255) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return { w, h, cx: w / 2, cy: h / 2, span: 1 };
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  return { w, h, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, span };
}

export function pxToUnit(x: number, y: number, f: MaskFrame): UnitPt {
  return [((x - f.cx) * 2) / f.span, ((f.cy - y) * 2) / f.span];
}

/** Inverse of streetGraphTrace.place(): map → unit space under a placement. */
export function latLngToUnit(p: LatLng, pl: Placement): UnitPt {
  const rx = ((p[1] - pl.center[1]) * mPerLng(pl.center[0])) / pl.scale;
  const ry = ((p[0] - pl.center[0]) * M_PER_LAT) / pl.scale;
  const r = (pl.rot * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [rx * c + ry * s, -rx * s + ry * c];
}

/** Felzenszwalb–Huttenlocher squared Euclidean distance transform, 1-D pass. */
function dt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    out[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
  }
}

/** Euclidean distance (in cells) from every cell to the nearest set cell. */
export function distanceTransform(set: Uint8Array, n: number): Float32Array {
  const g = new Float64Array(n * n);
  const col = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) col[y] = set[y * n + x] ? 0 : INF;
    dt1d(col, n, out, v, z);
    for (let y = 0; y < n; y++) g[y * n + x] = out[y]!;
  }
  const d = new Float32Array(n * n);
  const row = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) row[x] = g[y * n + x]!;
    dt1d(row, n, out, v, z);
    for (let x = 0; x < n; x++) d[y * n + x] = Math.sqrt(out[x]!);
  }
  return d;
}

export type Target = {
  n: number;
  marginU: number;
  boundary: Uint8Array;
  fill: Uint8Array;
  boundaryDt: Float32Array;
  fillDt: Float32Array;
  targetCells: number;
};

/** Rasterize the drawing once per mask; reuse across thousands of route evaluations. */
export function buildTarget(mask: Uint8Array, w: number, h: number, opts: LikenessOpts = {}): Target {
  const n = opts.px ?? 128;
  const marginU = opts.marginU ?? 1.3;
  const f = maskFrame(mask, w, h);
  const boundary = new Uint8Array(n * n);
  const fill = new Uint8Array(n * n);
  const cell = (u: UnitPt): number => {
    const gx = Math.round(((u[0] + marginU) / (2 * marginU)) * (n - 1));
    const gy = Math.round(((marginU - u[1]) / (2 * marginU)) * (n - 1));
    if (gx < 0 || gy < 0 || gx >= n || gy >= n) return -1;
    return gy * n + gx;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] !== 255) continue;
      const c = cell(pxToUnit(x, y, f));
      if (c < 0) continue;
      fill[c] = 1;
      const edge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 || mask[i - 1] !== 255 || mask[i + 1] !== 255 || mask[i - w] !== 255 || mask[i + w] !== 255;
      if (edge) boundary[c] = 1;
    }
  let targetCells = 0;
  for (let i = 0; i < n * n; i++) if (boundary[i]) targetCells++;
  return { n, marginU, boundary, fill, boundaryDt: distanceTransform(boundary, n), fillDt: distanceTransform(fill, n), targetCells };
}

/** Rasterize a routed chain (map coords) onto the target grid under its placement. */
export function rasterizeChain(chain: LatLng[], pl: Placement, t: Target): Uint8Array {
  const { n, marginU } = t;
  const set = new Uint8Array(n * n);
  const toGrid = (u: UnitPt): [number, number] => [((u[0] + marginU) / (2 * marginU)) * (n - 1), ((marginU - u[1]) / (2 * marginU)) * (n - 1)];
  const mark = (gx: number, gy: number) => {
    const x = Math.round(gx);
    const y = Math.round(gy);
    if (x >= 0 && y >= 0 && x < n && y < n) set[y * n + x] = 1;
  };
  let prev: [number, number] | null = null;
  for (const p of chain) {
    const g = toGrid(latLngToUnit(p, pl));
    if (prev) {
      const steps = Math.max(1, Math.ceil(Math.hypot(g[0] - prev[0], g[1] - prev[1]) / 0.5));
      for (let k = 1; k <= steps; k++) mark(prev[0] + ((g[0] - prev[0]) * k) / steps, prev[1] + ((g[1] - prev[1]) * k) / steps);
    } else mark(g[0], g[1]);
    prev = g;
  }
  return set;
}

/** Score a routed chain against a prebuilt target. */
export function tolCellsFor(t: Target, pl: Placement, opts: LikenessOpts): number {
  const tolU = opts.tolM !== undefined ? opts.tolM / pl.scale : (opts.tolU ?? 0.09);
  return (tolU * (t.n - 1)) / (2 * t.marginU);
}

export function likenessAgainst(t: Target, chain: LatLng[], pl: Placement, opts: LikenessOpts = {}): Likeness {
  const mPerCell = (2 * t.marginU * pl.scale) / (t.n - 1);
  const tolCells = tolCellsFor(t, pl, opts);
  const credit = (d: number) => {
    const r = d / tolCells;
    return r >= 1 ? 0 : 1 - r * r;
  };
  const route = rasterizeChain(chain, pl, t);
  let routeCells = 0;
  for (let i = 0; i < route.length; i++) if (route[i]) routeCells++;
  if (!routeCells || !t.targetCells) return { score: 0, recall: 0, precision: 0, crossings: 0, targetCells: t.targetCells, routeCells, mPerCell };
  const routeDt = distanceTransform(route, t.n);
  let rec = 0;
  for (let i = 0; i < t.boundary.length; i++) if (t.boundary[i]) rec += credit(routeDt[i]!);
  const recall = rec / t.targetCells;
  const interior = opts.interiorCredit ?? 0.5;
  let prec = 0;
  for (let i = 0; i < route.length; i++) {
    if (!route[i]) continue;
    // route inside the filled ink but off its boundary: clutter to an outline drawing, fill to a hatch style
    const inside = t.fillDt[i]! <= tolCells * 0.5;
    prec += inside ? Math.max(credit(t.boundaryDt[i]!), interior) : credit(t.boundaryDt[i]!);
  }
  const precision = prec / routeCells;
  const crossings = countCrossings(chain, pl);
  const clean = 1 / (1 + crossings * (opts.crossingWeight ?? 0.1));
  const score = recall + precision > 0 ? (clean * 100 * 2 * recall * precision) / (recall + precision) : 0;
  return { score, recall, precision, crossings, targetCells: t.targetCells, routeCells, mPerCell };
}

/** One-shot convenience: build the target and score. Use buildTarget + likenessAgainst in loops. */
export function strokeLikeness(mask: Uint8Array, w: number, h: number, chain: LatLng[], pl: Placement, opts: LikenessOpts = {}): Likeness {
  return likenessAgainst(buildTarget(mask, w, h, opts), chain, pl, opts);
}

/** Per-boundary-cell credit (0..1) for a routed chain — for a coverage picture of what the streets missed. */
export function coverageMap(t: Target, chain: LatLng[], pl: Placement, opts: LikenessOpts = {}): Float32Array {
  const tolCells = tolCellsFor(t, pl, opts);
  const route = rasterizeChain(chain, pl, t);
  const out = new Float32Array(t.n * t.n);
  let any = false;
  for (let i = 0; i < route.length; i++) if (route[i]) { any = true; break; }
  if (!any) return out;
  const routeDt = distanceTransform(route, t.n);
  for (let i = 0; i < t.boundary.length; i++) {
    if (!t.boundary[i]) continue;
    const r = routeDt[i]! / tolCells;
    out[i] = r >= 1 ? 0 : 1 - r * r;
  }
  return out;
}

/**
 * Proper crossings of the route with itself in unit space (segments that
 * cut each other, not ones that share an endpoint or run along the same
 * street). A clean line drawing has a handful; a tangle has dozens. Points
 * closer than `minU` are merged first so staircase jitter does not count.
 */
export function countCrossings(chain: LatLng[], pl: Placement, minU = 0.02): number {
  const pts: UnitPt[] = [];
  for (const p of chain) {
    const u = latLngToUnit(p, pl);
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(u[0] - last[0], u[1] - last[1]) >= minU) pts.push(u);
  }
  const n = pts.length - 1;
  if (n < 3) return 0;
  const minX = new Float64Array(n), maxX = new Float64Array(n), minY = new Float64Array(n), maxY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    minX[i] = Math.min(a[0], b[0]); maxX[i] = Math.max(a[0], b[0]);
    minY[i] = Math.min(a[1], b[1]); maxY[i] = Math.max(a[1], b[1]);
  }
  const cross = (o: UnitPt, a: UnitPt, b: UnitPt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (maxX[i]! < minX[j]! || maxX[j]! < minX[i]! || maxY[i]! < minY[j]! || maxY[j]! < minY[i]!) continue;
      const a = pts[i]!, b = pts[i + 1]!, c = pts[j]!, d = pts[j + 1]!;
      const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
      const eps = 1e-9;
      // strict crossing only: both pairs on opposite sides, no touching / collinear overlap
      if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) count++;
    }
  }
  return count;
}
