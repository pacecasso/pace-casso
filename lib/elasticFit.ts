/**
 * Elastic registration of a drawing onto the street network.
 *
 * The tracer snaps each stroke locally, so a limb drawn between two avenues
 * wobbles and a rectangle whose edge sits mid-block gets shredded. A human
 * GPS artist instead DRAGS the whole drawing: shears it to the grid bearing,
 * stretches a leg to reach an avenue, nudges a curve onto a park drive —
 * while keeping the figure's proportions.
 *
 * This module does that drag automatically:
 *   1. rasterize the walkable edges near the seat into a distance field
 *      (metres to the nearest street, exact Euclidean transform)
 *   2. a free-form deformation lattice (bilinear, spacing h) carries a
 *      displacement u(p); the drawing is warped as p -> p + u(p)
 *   3. minimise  E = Σ w_i · min(D(p_i + u), Dmax)²  +  α Σ |Δu|²  +  β Σ |u|²
 *      with analytic gradients (Adam), coarse-to-fine over h
 * The result is a warped copy of the strokes that lies on streets wherever
 * the network allows, with a smooth, shape-preserving deformation.
 *
 * Pure CPU, no I/O; ~50-300 ms per seat on a 500 k-node graph.
 */
import type { LatLng } from "./streetGraphTrace";

export type Graph = {
  coord: LatLng[];
  adj: { to: number; w: number }[][];
  grid: Map<string, number[]>;
};
export type XY = [number, number];

const M_PER_LAT = 111320;
const mPerLng = (lat: number) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);
const CELL = 0.003;

/** local metric frame around a centre: x east, y north (metres) */
export function toXY(p: LatLng, center: LatLng): XY {
  return [(p[1] - center[1]) * mPerLng(center[0]), (p[0] - center[0]) * M_PER_LAT];
}
export function fromXY(q: XY, center: LatLng): LatLng {
  return [center[0] + q[1] / M_PER_LAT, center[1] + q[0] / mPerLng(center[0])];
}

// ---------------------------------------------------------------------------
// distance field
// ---------------------------------------------------------------------------
export type DistanceField = {
  /** metres per pixel */
  px: number;
  w: number;
  h: number;
  /** origin (x,y in metres) of pixel (0,0) */
  x0: number;
  y0: number;
  /**
   * one field per street-bearing bin (bearing mod 180°, `bins` bins): a
   * drawn line only counts as "on a street" when a street runs the same
   * way. A vertical line mid-block crosses a cross-street every 80 m and
   * would look fine to an orientation-blind field.
   */
  d: Float32Array[];
  bins: number;
  dmax: number;
};

/** bin index for a direction (radians, any sign) */
export function bearingBin(theta: number, bins: number): number {
  let t = theta % Math.PI;
  if (t < 0) t += Math.PI;
  return Math.floor((t / Math.PI) * bins + 0.5) % bins;
}

/** exact 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher) */
function edt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    out[q] = dq * dq + f[v[k]!]!;
  }
}

/**
 * Rasterize every walkable edge within `radiusM` of `center` and build the
 * clamped Euclidean distance field.
 */
export function buildDistanceField(g: Graph, center: LatLng, radiusM: number, px = 10, dmax = 160, bins = 8): DistanceField {
  const w = Math.ceil((2 * radiusM) / px) + 1;
  const h = w;
  const x0 = -radiusM;
  const y0 = -radiusM;
  const occ = Array.from({ length: bins }, () => new Uint8Array(w * h));
  const clat = Math.round(center[0] / CELL);
  const clng = Math.round(center[1] / CELL);
  const cells = Math.ceil(radiusM / (CELL * M_PER_LAT)) + 1;
  const plot = (o: Uint8Array, x: number, y: number) => {
    const i = Math.round((x - x0) / px);
    const j = Math.round((y - y0) / px);
    if (i >= 0 && j >= 0 && i < w && j < h) o[j * w + i] = 1;
  };
  for (let dr = -cells; dr <= cells; dr++) {
    for (let dc = -cells; dc <= cells; dc++) {
      for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
        const a = toXY(g.coord[id]!, center);
        for (const { to } of g.adj[id]!) {
          if (to < id) continue;
          const b = toXY(g.coord[to]!, center);
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 1) continue;
          const o = occ[bearingBin(Math.atan2(b[1] - a[1], b[0] - a[0]), bins)]!;
          const n = Math.max(1, Math.ceil(len / (px * 0.7)));
          for (let k = 0; k <= n; k++) plot(o, a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
        }
      }
    }
  }
  // 2-D EDT per bin: rows then columns
  const INF = 1e12;
  const f = new Float64Array(Math.max(w, h));
  const tmp = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const sq = new Float64Array(w * h);
  const d: Float32Array[] = [];
  for (let b = 0; b < bins; b++) {
    const o = occ[b]!;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) f[i] = o[j * w + i] ? 0 : INF;
      edt1d(f, w, tmp, v, z);
      for (let i = 0; i < w; i++) sq[j * w + i] = tmp[i]!;
    }
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) f[j] = sq[j * w + i]!;
      edt1d(f, h, tmp, v, z);
      for (let j = 0; j < h; j++) sq[j * w + i] = tmp[j]!;
    }
    const db = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) db[i] = Math.min(dmax, Math.sqrt(sq[i]!) * px);
    d.push(db);
  }
  return { px, w, h, x0, y0, d, bins, dmax };
}

/** bilinear sample of one bearing bin's field and its gradient (metres, unitless) */
function sampleField(F: DistanceField, bin: number, x: number, y: number): { d: number; gx: number; gy: number } {
  const fx = (x - F.x0) / F.px;
  const fy = (y - F.y0) / F.px;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= F.w - 1 || j >= F.h - 1) return { d: F.dmax, gx: 0, gy: 0 };
  const tx = fx - i;
  const ty = fy - j;
  const D = F.d[bin]!;
  const d00 = D[j * F.w + i]!;
  const d10 = D[j * F.w + i + 1]!;
  const d01 = D[(j + 1) * F.w + i]!;
  const d11 = D[(j + 1) * F.w + i + 1]!;
  const d = (1 - tx) * (1 - ty) * d00 + tx * (1 - ty) * d10 + (1 - tx) * ty * d01 + tx * ty * d11;
  const gx = ((1 - ty) * (d10 - d00) + ty * (d11 - d01)) / F.px;
  const gy = ((1 - tx) * (d01 - d00) + tx * (d11 - d10)) / F.px;
  return { d, gx, gy };
}

// ---------------------------------------------------------------------------
// free-form deformation lattice
// ---------------------------------------------------------------------------
export type Lattice = {
  h: number;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  ux: Float64Array;
  uy: Float64Array;
};

function makeLattice(h: number, minX: number, minY: number, maxX: number, maxY: number): Lattice {
  const x0 = minX - h;
  const y0 = minY - h;
  const nx = Math.ceil((maxX - x0) / h) + 2;
  const ny = Math.ceil((maxY - y0) / h) + 2;
  return { h, nx, ny, x0, y0, ux: new Float64Array(nx * ny), uy: new Float64Array(nx * ny) };
}

/** displacement at p, plus the four (index, weight) pairs used */
function latticeAt(L: Lattice, x: number, y: number, idx: Int32Array, wts: Float64Array): XY {
  const fx = Math.min(L.nx - 1.0001, Math.max(0, (x - L.x0) / L.h));
  const fy = Math.min(L.ny - 1.0001, Math.max(0, (y - L.y0) / L.h));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  idx[0] = j * L.nx + i;
  idx[1] = j * L.nx + i + 1;
  idx[2] = (j + 1) * L.nx + i;
  idx[3] = (j + 1) * L.nx + i + 1;
  wts[0] = (1 - tx) * (1 - ty);
  wts[1] = tx * (1 - ty);
  wts[2] = (1 - tx) * ty;
  wts[3] = tx * ty;
  let ux = 0;
  let uy = 0;
  for (let k = 0; k < 4; k++) {
    ux += wts[k]! * L.ux[idx[k]!]!;
    uy += wts[k]! * L.uy[idx[k]!]!;
  }
  return [ux, uy];
}

export function warpPoint(L: Lattice, p: XY): XY {
  const idx = new Int32Array(4);
  const wts = new Float64Array(4);
  const [ux, uy] = latticeAt(L, p[0], p[1], idx, wts);
  return [p[0] + ux, p[1] + uy];
}

export type ElasticOptions = {
  /** lattice spacings, coarse to fine (metres) */
  levels?: number[];
  /** bending weight (higher = stiffer). Dimensionless; ~1-4 is a good range. */
  alpha?: number;
  /** pull-to-identity weight, keeps the drawing from drifting */
  beta?: number;
  iterations?: number;
  /** distance-field clamp (metres) */
  dmax?: number;
  /** per-sample weights (features > filler) */
  weights?: number[];
  /** per-sample tangent direction (radians); required for the bearing bins */
  thetas?: number[];
};

export type ElasticResult = {
  lattice: Lattice;
  /** mean street distance of the samples before / after */
  before: number;
  after: number;
  /** mean |u| (metres) — how much the drawing moved */
  meanShift: number;
  maxShift: number;
};

/**
 * Fit the drawing (sample points in the local metric frame) onto the
 * streets. Returns the final lattice; use `warpPoint` to move any point of
 * the original drawing.
 */
export function elasticFit(F: DistanceField, samples: XY[], opts: ElasticOptions = {}): ElasticResult {
  const levels = opts.levels ?? [900, 450, 220];
  const alpha = opts.alpha ?? 2;
  const beta = opts.beta ?? 0.02;
  const iters = opts.iterations ?? 250;
  const wgt = opts.weights ?? samples.map(() => 1);
  const bin = (opts.thetas ?? samples.map(() => 0)).map((t) => bearingBin(t, F.bins));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of samples) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const meanDist = (L: Lattice | null) => {
    let s = 0;
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i]!;
      const q = L ? warpPoint(L, p) : p;
      s += sampleField(F, bin[i]!, q[0], q[1]).d;
    }
    return s / samples.length;
  };
  const before = meanDist(null);
  let prev: Lattice | null = null;
  const idx = new Int32Array(4);
  const wts = new Float64Array(4);
  for (const h of levels) {
    const L = makeLattice(h, minX, minY, maxX, maxY);
    if (prev) {
      // initialise from the coarser level
      for (let j = 0; j < L.ny; j++) {
        for (let i = 0; i < L.nx; i++) {
          const u = warpPoint(prev, [L.x0 + i * h, L.y0 + j * h]);
          L.ux[j * L.nx + i] = u[0] - (L.x0 + i * h);
          L.uy[j * L.nx + i] = u[1] - (L.y0 + j * h);
        }
      }
    }
    const n = L.nx * L.ny;
    const gx = new Float64Array(n);
    const gy = new Float64Array(n);
    const mx = new Float64Array(n);
    const my = new Float64Array(n);
    const vx = new Float64Array(n);
    const vy = new Float64Array(n);
    const lr = h * 0.05; // metres per step (Adam-normalised)
    const b1 = 0.9;
    const b2 = 0.999;
    // scale the data term so that the field gradient (unitless) and the
    // regularisers (metres) are comparable regardless of sample count
    const dataScale = 1 / samples.length;
    const regScale = 1 / n;
    for (let it = 1; it <= iters; it++) {
      gx.fill(0);
      gy.fill(0);
      // data term
      for (let s = 0; s < samples.length; s++) {
        const p = samples[s]!;
        const [ux, uy] = latticeAt(L, p[0], p[1], idx, wts);
        const f = sampleField(F, bin[s]!, p[0] + ux, p[1] + uy);
        if (f.d >= F.dmax) continue; // flat region: no pull
        const c = 2 * f.d * wgt[s]! * dataScale;
        for (let k = 0; k < 4; k++) {
          gx[idx[k]!] += c * f.gx * wts[k]!;
          gy[idx[k]!] += c * f.gy * wts[k]!;
        }
      }
      // bending: discrete Laplacian, gradient of Σ|Δu|²
      for (let j = 0; j < L.ny; j++) {
        for (let i = 0; i < L.nx; i++) {
          const k = j * L.nx + i;
          let lx = 0;
          let ly = 0;
          let cnt = 0;
          const nb = [i > 0 ? k - 1 : -1, i < L.nx - 1 ? k + 1 : -1, j > 0 ? k - L.nx : -1, j < L.ny - 1 ? k + L.nx : -1];
          for (const m of nb) {
            if (m < 0) continue;
            lx += L.ux[m]! - L.ux[k]!;
            ly += L.uy[m]! - L.uy[k]!;
            cnt++;
          }
          if (!cnt) continue;
          lx /= cnt;
          ly /= cnt;
          // ∂/∂u_k of (Δu_k)² and of the neighbours' Laplacians
          const c = (2 * alpha * regScale) / h;
          gx[k] += -c * lx;
          gy[k] += -c * ly;
          for (const m of nb) {
            if (m < 0) continue;
            gx[m] += (c * lx) / cnt;
            gy[m] += (c * ly) / cnt;
          }
          gx[k] += 2 * beta * regScale * (L.ux[k]! / h);
          gy[k] += 2 * beta * regScale * (L.uy[k]! / h);
        }
      }
      // Adam step
      const c1 = 1 - b1 ** it;
      const c2 = 1 - b2 ** it;
      for (let k = 0; k < n; k++) {
        mx[k] = b1 * mx[k]! + (1 - b1) * gx[k]!;
        my[k] = b1 * my[k]! + (1 - b1) * gy[k]!;
        vx[k] = b2 * vx[k]! + (1 - b2) * gx[k]! * gx[k]!;
        vy[k] = b2 * vy[k]! + (1 - b2) * gy[k]! * gy[k]!;
        L.ux[k] -= (lr * (mx[k]! / c1)) / (Math.sqrt(vx[k]! / c2) + 1e-9);
        L.uy[k] -= (lr * (my[k]! / c1)) / (Math.sqrt(vy[k]! / c2) + 1e-9);
      }
    }
    prev = L;
  }
  const L = prev!;
  let shift = 0;
  let maxShift = 0;
  for (const p of samples) {
    const q = warpPoint(L, p);
    const s = Math.hypot(q[0] - p[0], q[1] - p[1]);
    shift += s;
    if (s > maxShift) maxShift = s;
  }
  return { lattice: L, before, after: meanDist(L), meanShift: shift / samples.length, maxShift };
}

/** curvature-based sample weights (sharp turns = features) and local tangents */
export function featureWeights(polys: XY[][]): { samples: XY[]; weights: number[]; thetas: number[] } {
  const samples: XY[] = [];
  const weights: number[] = [];
  const thetas: number[] = [];
  for (const pts of polys) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[i]!;
      const c = pts[Math.min(pts.length - 1, i + 1)]!;
      let turn = 0;
      if (i > 0 && i < pts.length - 1) {
        const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
        let dd = Math.abs(a2 - a1);
        if (dd > Math.PI) dd = 2 * Math.PI - dd;
        turn = dd;
      }
      samples.push(b);
      weights.push(1 + 2 * Math.min(1, turn / (Math.PI / 2)));
      thetas.push(Math.atan2(c[1] - a[1], c[0] - a[0]));
    }
  }
  return { samples, weights, thetas };
}

/** densify a polyline so the data term sees every block, not just vertices */
export function densify(pts: XY[], stepM: number): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    out.push(a);
    const b = pts[i + 1];
    if (!b) break;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(len / stepM);
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / (n + 1), a[1] + ((b[1] - a[1]) * k) / (n + 1)]);
  }
  return out;
}
