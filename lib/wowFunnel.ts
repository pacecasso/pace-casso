/**
 * wowFunnel — the verified route-placement engine (WOW.md, 2026-07-26).
 *
 * Places a normalized line-art contour (one or more strokes) onto the real
 * street graph at many candidate positions/scales/rotations/mirrors, traces
 * each through actual streets, cleans snap spurs, gates for runnability,
 * and returns candidates ranked by shape deviation. Vision screening (the
 * primed judge) happens in the API layer on top of these candidates.
 *
 * Measured basis (see WOW.md, LIBRARY.md, DUMB-BASELINE.md):
 *  - dumb trace (densify -> nearest intersection -> shortest path) beats the
 *    old compile/rank stack on blind recognition;
 *  - snapping only to the graph's giant connected component eliminates the
 *    teleport failures that killed 80-95% of placements;
 *  - spur cleanup (off-contour anchors dropped, short node-loops excised)
 *    removes one-block stubs without harming intended retraces >=440 m.
 */
import type { LatLng, NormalizedPoint } from "./streetGraphTrace";
import { splitSketchComponents } from "./sketchReview";

export type Pt = [number, number]; // shape space, y-UP, ~0..1000
export type WowGraph = {
  coord: LatLng[];
  adj: { to: number; w: number }[][];
  grid: Map<string, number[]>;
};

const M_PER_LAT = 111320;
const CELL = 0.003; // must match streetGraphTrace's grid cell

function meters(a: LatLng, b: LatLng): number {
  return Math.hypot(
    (b[0] - a[0]) * M_PER_LAT,
    (b[1] - a[1]) * M_PER_LAT * Math.cos((a[0] * Math.PI) / 180),
  );
}

// ---------------------------------------------------------------------------
// Giant connected component (cached per graph instance)
// ---------------------------------------------------------------------------
const giantMasks = new WeakMap<WowGraph, Uint8Array>();

export function getGiantComponentMask(g: WowGraph): Uint8Array {
  const cached = giantMasks.get(g);
  if (cached) return cached;
  const n = g.coord.length;
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  let nc = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    const stack = [s];
    comp[s] = nc;
    let size = 0;
    while (stack.length) {
      const cur = stack.pop()!;
      size++;
      for (const { to } of g.adj[cur] ?? []) {
        if (comp[to] === -1) {
          comp[to] = nc;
          stack.push(to);
        }
      }
    }
    sizes.push(size);
    nc++;
  }
  let best = 0;
  for (let i = 1; i < nc; i++) if (sizes[i]! > sizes[best]!) best = i;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = comp[i] === best ? 1 : 0;
  giantMasks.set(g, mask);
  return mask;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
export function placeSegments(
  segments: Pt[][],
  center: LatLng,
  extentM: number,
  rotDeg: number,
  mirror: boolean,
): LatLng[][] {
  const all = segments.flat();
  const xs = all.map((p) => (mirror ? -p[0] : p[0]));
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  const span = Math.max(spanX, spanY) || 1;
  const s = extentM / span;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mPerLng = M_PER_LAT * Math.cos((center[0] * Math.PI) / 180);
  return segments.map((seg) =>
    seg.map(([x0, y]) => {
      const x = mirror ? -x0 : x0;
      const mx = (x - minX - spanX / 2) * s;
      const my = (y - minY - spanY / 2) * s;
      const rx = mx * cos - my * sin;
      const ry = mx * sin + my * cos;
      return [center[0] + ry / M_PER_LAT, center[1] + rx / mPerLng] as LatLng;
    }),
  );
}

export function densifyLine(line: LatLng[], stepM: number): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[i]!;
    out.push(a);
    const b = line[i + 1];
    if (!b) continue;
    const d = meters(a, b);
    const steps = Math.max(1, Math.ceil(d / stepM));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function distToDense(p: LatLng, dense: LatLng[]): number {
  let bd = Infinity;
  for (const q of dense) {
    const d = meters(p, q);
    if (d < bd) bd = d;
  }
  return bd;
}

/**
 * Pick trace anchors from a densified line: every point where the heading
 * changes noticeably (a corner of the shape) plus a sparse cadence along
 * straight spans so long lines still follow the shape between corners.
 */
export function anchorPoints(dense: LatLng[], cornerDeg = 18, straightEveryM = 260): LatLng[] {
  if (dense.length <= 2) return dense.slice();
  const out: LatLng[] = [dense[0]!];
  let heading: number | null = null;
  let sinceM = 0;
  for (let i = 1; i < dense.length; i++) {
    const stepM = meters(dense[i - 1]!, dense[i]!);
    const h = Math.atan2(
      (dense[i]![1] - dense[i - 1]![1]) * Math.cos((dense[i]![0] * Math.PI) / 180),
      dense[i]![0] - dense[i - 1]![0],
    ) * (180 / Math.PI);
    sinceM += stepM;
    let corner = false;
    if (heading != null) {
      let dh = Math.abs(h - heading);
      if (dh > 180) dh = 360 - dh;
      corner = dh >= cornerDeg;
    }
    if (corner || sinceM >= straightEveryM || i === dense.length - 1) {
      out.push(dense[i]!);
      sinceM = 0;
      heading = h;
    } else if (heading == null) {
      heading = h;
    }
  }
  return out;
}

/** Symmetric chamfer distance (m) between a traced route and the intended contour. */
export function chamferDistance(chains: LatLng[][], denseSegs: LatLng[][]): number {
  const routePts = chains.flat();
  const contourPts = denseSegs.flat();
  if (!routePts.length || !contourPts.length) return Infinity;
  let a = 0;
  for (const p of routePts) a += distToDense(p, contourPts);
  a /= routePts.length;
  let b = 0;
  for (const q of contourPts) b += distToDense(q, routePts);
  b /= contourPts.length;
  return (a + b) / 2;
}

// ---------------------------------------------------------------------------
// Graph search
// ---------------------------------------------------------------------------
export function nearestGiantNode(
  g: WowGraph,
  mask: Uint8Array,
  p: LatLng,
): { id: number; d: number } {
  let bestId = -1;
  let bd = Infinity;
  const clat = Math.round(p[0] / CELL);
  const clng = Math.round(p[1] / CELL);
  for (let ring = 1; ring <= 2; ring++) {
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
          if (!mask[id]) continue;
          const m = meters(p, g.coord[id]!);
          if (m < bd) {
            bd = m;
            bestId = id;
          }
        }
      }
    }
    if (bestId >= 0 && ring === 1) break;
  }
  return { id: bestId, d: bd };
}

/** Binary min-heap keyed on f-score, for A*. */
class MinHeap {
  private ids: number[] = [];
  private fs: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, f: number) {
    let i = this.ids.length;
    this.ids.push(id);
    this.fs.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.fs[p]! <= this.fs[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.ids[0]!;
    const lastId = this.ids.pop()!;
    const lastF = this.fs.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId;
      this.fs[0] = lastF;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.fs.length && this.fs[l]! < this.fs[m]!) m = l;
        if (r < this.fs.length && this.fs[r]! < this.fs[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(i: number, j: number) {
    [this.ids[i], this.ids[j]] = [this.ids[j]!, this.ids[i]!];
    [this.fs[i], this.fs[j]] = [this.fs[j]!, this.fs[i]!];
  }
}

export function shortestGraphPath(g: WowGraph, a: number, b: number): number[] | null {
  if (a === b) return [a];
  const target = g.coord[b]!;
  const heap = new MinHeap();
  heap.push(a, meters(g.coord[a]!, target));
  const gScore = new Map<number, number>([[a, 0]]);
  const came = new Map<number, number>();
  const done = new Set<number>();
  let guard = 0;
  while (heap.size && guard++ < 400000) {
    const cur = heap.pop();
    if (cur === b) {
      const out = [cur];
      let c = cur;
      while (came.has(c)) {
        c = came.get(c)!;
        out.push(c);
      }
      return out.reverse();
    }
    if (done.has(cur)) continue;
    done.add(cur);
    for (const { to, w } of g.adj[cur] ?? []) {
      if (done.has(to)) continue;
      const tentative = gScore.get(cur)! + w;
      if (tentative < (gScore.get(to) ?? Infinity)) {
        came.set(to, cur);
        gScore.set(to, tentative);
        heap.push(to, tentative + meters(g.coord[to]!, target));
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spur cleanup
// ---------------------------------------------------------------------------
/**
 * Stage 1 — anchor level: drop interior anchors whose intersection sits
 * >110 m off the intended contour (a sample snapped across a block).
 */
export function cleanAnchors(coord: LatLng[], nodes: number[], dense: LatLng[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const isEndpoint = i === 0 || i === nodes.length - 1;
    if (!isEndpoint && distToDense(coord[nodes[i]!]!, dense) > 110) continue;
    if (out.length === 0 || out[out.length - 1] !== nodes[i]) out.push(nodes[i]!);
  }
  return out;
}

/**
 * Stage 2 — path level: a snap spur revisits the SAME intersection after a
 * short out-and-back. But the tip of an INTENDED retrace (a drawn leg/arm)
 * is itself a short palindrome, so length alone nibbles limbs from the tip
 * inward (this is what amputated the runner's arm in the offline v2 run).
 * A loop is noise only if it is short (< thresholdM) AND its interior nodes
 * stray off the intended contour (> offContourM) — intended tips sit ON the
 * shape being drawn.
 */
export function exciseLoops(
  coord: LatLng[],
  pathNodes: number[],
  dense: LatLng[],
  // Off-contour is what makes a loop noise; the on-contour check protects
  // intended retraces at ANY length, so the length threshold can be
  // generous. 380 m left "comb teeth" (rows of ~500 m block-width
  // out-and-backs along avenue-parallel strokes) in every render.
  thresholdM = 900,
  offContourM = 70,
): number[] {
  let nodes = pathNodes;
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    const out: number[] = [];
    let i = 0;
    while (i < nodes.length) {
      let spliced = false;
      for (let j = i + 2; j < Math.min(nodes.length, i + 30); j++) {
        if (nodes[j] !== nodes[i]) continue;
        let loopM = 0;
        for (let k = i; k < j; k++) loopM += meters(coord[nodes[k]!]!, coord[nodes[k + 1]!]!);
        if (loopM < thresholdM) {
          let maxOff = 0;
          for (let k = i + 1; k < j; k++) {
            const off = distToDense(coord[nodes[k]!]!, dense);
            if (off > maxOff) maxOff = off;
          }
          if (maxOff > offContourM) {
            out.push(nodes[i]!);
            i = j + 1;
            spliced = true;
            changed = true;
          }
        }
        break; // only the nearest revisit
      }
      if (!spliced) {
        out.push(nodes[i]!);
        i++;
      }
    }
    nodes = out;
    if (!changed) break;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Contour -> strokes (upload hygiene)
// ---------------------------------------------------------------------------
// Product rule (Ralph, July 27): NO pen lifts — the drawing is one
// continuous run. Everything merges into a single stroke; the connector
// segments become drawn ink, included in distance and in what judges see.
export const MAX_STROKES = 1;

export function strokeInkLen(seg: Pt[]): number {
  let len = 0;
  for (let i = 1; i < seg.length; i++) {
    len += Math.hypot(seg[i]![0] - seg[i - 1]![0], seg[i]![1] - seg[i - 1]![1]);
  }
  return len;
}

/** Total ink length divided by the larger bbox span, in shape units. */
export function strokesInkRatio(strokes: Pt[][]): number {
  const all = strokes.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const span = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  ) || 1;
  let len = 0;
  for (const seg of strokes) len += strokeInkLen(seg);
  return len / span;
}

/**
 * Split a traced contour (normalized, y-down) into runnable strokes.
 * Real Step-1 traces over-fragment (a photo trace can split into a dozen+
 * components, most of them specks) and every placement then dies on the
 * too-few-intersections gate. All thresholds are PROPORTIONAL to the
 * drawing's span — nothing here is tuned to any particular image:
 *  - drop ink-specks (< 2% of span — tracer noise, invisible at street
 *    scale; intended detail like an eye or olive is a loop far above it),
 *  - merge strokes across short gaps (< 8% of span — the connector simply
 *    gets drawn, standard GPS-art practice),
 *  - cap at MAX_STROKES pen lifts by merging the smallest remaining gaps.
 */
export function contourToStrokes(contour: NormalizedPoint[]): Pt[][] {
  const components = splitSketchComponents(contour);
  let strokes: Pt[][] = components
    .map((comp) => comp.map((p): Pt => [p.x * 1000, (1 - p.y) * 1000]))
    .filter((s) => s.length >= 1);
  if (!strokes.length) return [];

  const all = strokes.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const span = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  ) || 1;

  const substantial = strokes.filter((s) => strokeInkLen(s) >= span * 0.02);
  if (substantial.length) strokes = substantial;

  const gap = (a: Pt[], b: Pt[]) => {
    const e = a[a.length - 1]!;
    const s = b[0]!;
    return Math.hypot(s[0] - e[0], s[1] - e[1]);
  };
  const merged: Pt[][] = [strokes[0]!.slice()];
  for (let i = 1; i < strokes.length; i++) {
    const prev = merged[merged.length - 1]!;
    if (gap(prev, strokes[i]!) < span * 0.08) prev.push(...strokes[i]!);
    else merged.push(strokes[i]!.slice());
  }
  strokes = merged;

  while (strokes.length > MAX_STROKES) {
    let best = 1;
    let bestGap = Infinity;
    for (let i = 1; i < strokes.length; i++) {
      const d = gap(strokes[i - 1]!, strokes[i]!);
      if (d < bestGap) {
        bestGap = d;
        best = i;
      }
    }
    strokes[best - 1]!.push(...strokes[best]!);
    strokes.splice(best, 1);
  }
  return strokes;
}

// ---------------------------------------------------------------------------
// Tracing + sweep
// ---------------------------------------------------------------------------
export type WowCandidate = {
  id: string;
  center: LatLng;
  extentM: number;
  rotDeg: number;
  mirror: boolean;
  km: number;
  /** symmetric chamfer distance (m) route<->contour; lower = tighter fit */
  dev: number;
  /** traced street chains, one per stroke (pen lift between strokes) */
  segments: LatLng[][];
};

export function traceSegmentsOnGraph(
  g: WowGraph,
  mask: Uint8Array,
  segments: Pt[][],
  center: LatLng,
  extentM: number,
  rotDeg: number,
  mirror: boolean,
): { chains: LatLng[][]; jumps: number; maxSnapD: number; nodeSig: string; dev: number } {
  const placed = placeSegments(segments, center, extentM, rotDeg, mirror);
  const chains: LatLng[][] = [];
  const denseSegs: LatLng[][] = [];
  let jumps = 0;
  let maxSnapD = 0;
  const sig: string[] = [];
  for (const seg of placed) {
    const dense = densifyLine(seg, 40);
    denseSegs.push(dense);
    // Anchor at the shape's corners and only sparsely along straights: a
    // 40 m anchor lattice forces the route to weave around every anchor
    // ("wobbly" verdicts from the comparative judge), while corner+sparse
    // anchors let A* follow one street cleanly between direction changes.
    const anchors = anchorPoints(dense);
    let nodes: number[] = [];
    for (const p of anchors) {
      const { id, d } = nearestGiantNode(g, mask, p);
      if (id < 0) {
        maxSnapD = Infinity;
        continue;
      }
      if (d > maxSnapD) maxSnapD = d;
      if (nodes.length === 0 || nodes[nodes.length - 1] !== id) nodes.push(id);
    }
    nodes = cleanAnchors(g.coord, nodes, dense);
    let pathNodes: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      if (i === 0) {
        pathNodes.push(nodes[0]!);
        continue;
      }
      const p = shortestGraphPath(g, nodes[i - 1]!, nodes[i]!);
      if (!p) {
        jumps++;
        pathNodes.push(nodes[i]!);
        continue;
      }
      for (let k = 1; k < p.length; k++) pathNodes.push(p[k]!);
    }
    pathNodes = exciseLoops(g.coord, pathNodes, dense);
    chains.push(pathNodes.map((n) => g.coord[n]!));
    sig.push(`${nodes[0]}:${nodes[nodes.length - 1]}:${pathNodes.length}`);
  }
  return { chains, jumps, maxSnapD, nodeSig: sig.join("|"), dev: chamferDistance(chains, denseSegs) };
}

export function chainsKm(chains: LatLng[][]): number {
  let m = 0;
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) m += meters(chain[i - 1]!, chain[i]!);
  }
  return m / 1000;
}

export type SweepStats = {
  tried: number;
  jumps: number;
  snap: number;
  short: number;
  avoid: number;
  kmLow: number;
  kmHigh: number;
  dup: number;
};

export type SweepOptions = {
  centers: LatLng[];
  extentsM?: number[];
  rotationsDeg?: number[];
  mirrors?: boolean[];
  minKm?: number;
  maxKm?: number;
  maxSnapM?: number;
  /** bbox the route should mostly avoid (e.g. Central Park), overlap fraction gate */
  avoidBox?: { s: number; n: number; w: number; e: number; maxOverlap: number };
  /** stop early once this many gated candidates exist (0 = no cap) */
  maxCandidates?: number;
  /** when provided, per-gate rejection counts are accumulated into it */
  stats?: SweepStats;
};

// Manhattan defaults — mirror the offline rig that produced WOW.md
export const MANHATTAN_CENTERS: LatLng[] = (() => {
  const centers: LatLng[] = [];
  for (const lat of [40.722, 40.733, 40.7445, 40.751, 40.758]) {
    for (const lng of [-73.997, -73.984]) centers.push([lat, lng]);
  }
  centers.push([40.715, -73.99], [40.744, -73.977], [40.77, -73.955], [40.787, -73.972]);
  return centers;
})();

// Park paths are in the walk graph and runnable — human artists use the
// drives as Manhattan's only smooth curves (the best heart ever produced
// here wraps Central Park). The gate only rejects routes that are MOSTLY
// park (deep-interior placements the snap gate doesn't already catch).
export const CENTRAL_PARK_BOX = { s: 40.7644, n: 40.8005, w: -73.9818, e: -73.949, maxOverlap: 0.5 };

function boxOverlapFrac(
  chains: LatLng[][],
  box: { s: number; n: number; w: number; e: number },
): number {
  const all = chains.flat();
  const lats = all.map((c) => c[0]);
  const lngs = all.map((c) => c[1]);
  const s = Math.min(...lats);
  const n = Math.max(...lats);
  const w = Math.min(...lngs);
  const e = Math.max(...lngs);
  const is = Math.max(s, box.s);
  const inn = Math.min(n, box.n);
  const iw = Math.max(w, box.w);
  const ie = Math.min(e, box.e);
  if (is >= inn || iw >= ie) return 0;
  return ((inn - is) * (ie - iw)) / ((n - s) * (e - w) || 1e-12);
}

/**
 * Sweep placements, gate, dedupe; returns candidates sorted by dev (tightest
 * shape fit first). Pure CPU — no network, no vision.
 */
export function sweepPlacements(g: WowGraph, segments: Pt[][], opts: SweepOptions): WowCandidate[] {
  const mask = getGiantComponentMask(g);
  const extents = opts.extentsM ?? [2200, 2800, 3400, 4000];
  const rotations = opts.rotationsDeg ?? [0, 15, -15, 29, -29];
  const mirrors = opts.mirrors ?? [false, true];
  const minKm = opts.minKm ?? 7;
  const maxKm = opts.maxKm ?? 26;
  const maxSnapM = opts.maxSnapM ?? 150;
  const out: WowCandidate[] = [];
  const seen = new Set<string>();
  const stats = opts.stats;
  for (let pi = 0; pi < opts.centers.length; pi++) {
    for (let si = 0; si < extents.length; si++) {
      for (let ri = 0; ri < rotations.length; ri++) {
        for (let mi = 0; mi < mirrors.length; mi++) {
          if (stats) stats.tried++;
          const { chains, jumps, maxSnapD, nodeSig, dev } = traceSegmentsOnGraph(
            g, mask, segments, opts.centers[pi]!, extents[si]!, rotations[ri]!, mirrors[mi]!,
          );
          if (jumps > 0) {
            if (stats) stats.jumps++;
            continue;
          }
          if (maxSnapD > maxSnapM) {
            if (stats) stats.snap++;
            continue;
          }
          if (chains.some((c) => c.length < 4)) {
            if (stats) stats.short++;
            continue;
          }
          if (opts.avoidBox && boxOverlapFrac(chains, opts.avoidBox) > opts.avoidBox.maxOverlap) {
            if (stats) stats.avoid++;
            continue;
          }
          const km = chainsKm(chains);
          if (km < minKm) {
            if (stats) stats.kmLow++;
            continue;
          }
          if (km > maxKm) {
            if (stats) stats.kmHigh++;
            continue;
          }
          const hash = `${nodeSig}:${km.toFixed(1)}`;
          if (seen.has(hash)) {
            if (stats) stats.dup++;
            continue;
          }
          seen.add(hash);
          out.push({
            id: `wow-p${pi}-s${si}-r${ri}-m${mi}`,
            center: opts.centers[pi]!,
            extentM: extents[si]!,
            rotDeg: rotations[ri]!,
            mirror: mirrors[mi]!,
            km: Number(km.toFixed(2)),
            dev: Number(dev.toFixed(1)),
            segments: chains,
          });
          if (opts.maxCandidates && out.length >= opts.maxCandidates) {
            return out.sort((a, b) => a.dev - b.dev);
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.dev - b.dev);
}
