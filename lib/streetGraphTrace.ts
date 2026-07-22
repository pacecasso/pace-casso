/**
 * Street-graph tracer — the etch-a-sketch spike (scripts/trace-contour.ts)
 * productionized. GPS art as Ralph framed it: trace the shape WITH the
 * map's real streets. Routes on the full ~103k-node road graph (not the
 * 3.7k-junction lattice), so at hero scale the streets themselves draw the
 * curves — the proof runs: a circle spanning Midtown traces round, a fish
 * on downtown's crooked streets stays a fish.
 *
 * Pipeline: normalized upload contour → unit shape → coarse placement sweep
 * over the island (feature-weighted: sharp turns of the design must land on
 * city geometry that can actually turn) → corridor A* between anchors along
 * the winning placements (cost = street length + λ·distance from the target
 * outline) → top candidates with deviation metrics.
 *
 * Server-only: loads a 3.3 MB graph and runs seconds of CPU. Client code
 * reaches it through POST /api/street-trace.
 */

export type LatLng = [number, number];
export type NormalizedPoint = { x: number; y: number };

const M_PER_LAT = 111320;
const mPerLng = (lat: number) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);

function meters(a: LatLng, b: LatLng): number {
  return Math.hypot((b[0] - a[0]) * M_PER_LAT, (b[1] - a[1]) * mPerLng(a[0]));
}

function distToSeg(p: LatLng, a: LatLng, b: LatLng): number {
  const lat0 = a[0];
  const px = (p[1] - a[1]) * mPerLng(lat0);
  const py = (p[0] - a[0]) * M_PER_LAT;
  const bx = (b[1] - a[1]) * mPerLng(lat0);
  const by = (b[0] - a[0]) * M_PER_LAT;
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by || 1)));
  return Math.hypot(px - t * bx, py - t * by);
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------
type Graph = {
  coord: LatLng[];
  adj: { to: number; w: number }[][];
  grid: Map<string, number[]>;
};

const CELL = 0.003;
const cellOf = (lat: number, lng: number) =>
  `${Math.round(lat / CELL)}:${Math.round(lng / CELL)}`;

let cachedGraph: Promise<Graph> | null = null;

export function getStreetGraph(): Promise<Graph> {
  if (!cachedGraph) {
    cachedGraph = import("./data/manhattan-walk-graph.json").then((mod) => {
      const data = mod.default as unknown as {
        scale: number;
        lat: number[];
        lng: number[];
        edges: number[];
      };
      const n = data.lat.length;
      const coord: LatLng[] = new Array(n);
      for (let i = 0; i < n; i++) {
        coord[i] = [data.lat[i]! / data.scale, data.lng[i]! / data.scale];
      }
      const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
      for (let e = 0; e < data.edges.length; e += 2) {
        const a = data.edges[e]!;
        const b = data.edges[e + 1]!;
        const w = meters(coord[a]!, coord[b]!);
        adj[a]!.push({ to: b, w });
        adj[b]!.push({ to: a, w });
      }
      const grid = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        const k = cellOf(coord[i]![0], coord[i]![1]);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push(i);
      }
      return { coord, adj, grid };
    });
  }
  return cachedGraph;
}

function nearestNode(g: Graph, p: LatLng): number {
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
  return best;
}

// ---------------------------------------------------------------------------
// Corridor A*
// ---------------------------------------------------------------------------
function corridorPath(
  g: Graph,
  a: number,
  b: number,
  contour: LatLng[],
  lambda: number,
  corridorM: number,
): number[] | null {
  const target = g.coord[b]!;
  const distContour = (p: LatLng) => {
    let m = Infinity;
    for (let i = 1; i < contour.length; i++) {
      const dd = distToSeg(p, contour[i - 1]!, contour[i]!);
      if (dd < m) m = dd;
    }
    return m;
  };
  const open = new Map<number, number>([[a, 0]]);
  const gScore = new Map<number, number>([[a, 0]]);
  const came = new Map<number, number>();
  const done = new Set<number>();
  let guard = 0;
  while (open.size && guard++ < 200000) {
    let cur = -1;
    let cf = Infinity;
    for (const [n, f] of open) {
      if (f < cf) {
        cf = f;
        cur = n;
      }
    }
    if (cur === b) {
      const pathIds = [cur];
      let c = cur;
      while (came.has(c)) {
        c = came.get(c)!;
        pathIds.push(c);
      }
      return pathIds.reverse();
    }
    open.delete(cur);
    done.add(cur);
    for (const { to, w } of g.adj[cur] ?? []) {
      if (done.has(to)) continue;
      const cto = g.coord[to]!;
      const dc = distContour(cto);
      if (dc > corridorM) continue;
      const tentative = gScore.get(cur)! + w + lambda * dc;
      if (tentative < (gScore.get(to) ?? Infinity)) {
        came.set(to, cur);
        gScore.set(to, tentative);
        open.set(to, tentative + meters(cto, target));
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trace a placed contour
// ---------------------------------------------------------------------------
type TraceResult = {
  chain: LatLng[];
  /** Fraction of the target outline the streets actually drew (routed legs / all legs, by length). */
  coverage: number;
  /** Longest single dropped stretch, meters — a teleport in the route. */
  maxGapM: number;
};

function traceContour(
  g: Graph,
  contour: LatLng[],
  opts: {
    anchorM: number;
    lambda: number;
    corridorM: number;
    trimSpikes?: boolean;
    closeLoop?: boolean;
  },
): TraceResult {
  const dense: LatLng[] = [];
  for (let i = 1; i < contour.length; i++) {
    const a = contour[i - 1]!;
    const b = contour[i]!;
    const d = meters(a, b);
    const n = Math.max(1, Math.round(d / 25));
    for (let s = 0; s < n; s++) {
      dense.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
    }
  }
  dense.push(contour[contour.length - 1]!);

  const anchors: LatLng[] = [dense[0]!];
  let acc = 0;
  for (let i = 1; i < dense.length; i++) {
    acc += meters(dense[i - 1]!, dense[i]!);
    if (acc >= opts.anchorM) {
      anchors.push(dense[i]!);
      acc = 0;
    }
  }
  // A single closed blob loops back to its start; a multi-piece sketch is
  // an OPEN drawing — force-closing it adds a phantom cross-drawing chord
  // that can never route within the leg caps and poisons coverage at
  // every placement.
  if (opts.closeLoop !== false) anchors.push(dense[0]!);

  const chain: LatLng[] = [];
  let coveredM = 0;
  let droppedM = 0;
  let maxGapM = 0;
  for (let i = 1; i < anchors.length; i++) {
    const direct = meters(anchors[i - 1]!, anchors[i]!);
    const na = nearestNode(g, anchors[i - 1]!);
    const nb = nearestNode(g, anchors[i]!);
    if (na < 0 || nb < 0) {
      droppedM += direct;
      maxGapM = Math.max(maxGapM, direct);
      continue;
    }
    if (na === nb) {
      coveredM += direct;
      continue;
    }
    let p = corridorPath(g, na, nb, dense, opts.lambda, opts.corridorM);
    if (!p) p = corridorPath(g, na, nb, dense, opts.lambda, opts.corridorM * 3);
    if (!p) p = corridorPath(g, na, nb, dense, 0, 1e7);
    let plen = 0;
    if (p) {
      for (let k = 1; k < p.length; k++) plen += meters(g.coord[p[k - 1]!]!, g.coord[p[k]!]!);
    }
    // a dropped leg beats a huge detour loop across the city — but every
    // dropped leg is a TELEPORT in the final route, so it is counted and
    // the caller rejects candidates whose streets couldn't draw the shape.
    if (!p || plen > direct * 2.2 + 250 || plen > 1400) {
      droppedM += direct;
      maxGapM = Math.max(maxGapM, direct);
      continue;
    }
    coveredM += direct;
    for (const id of p) chain.push(g.coord[id]!);
  }
  const out: LatLng[] = [];
  for (const p of chain) {
    if (!out.length || meters(out[out.length - 1]!, p) > 1) out.push(p);
  }
  const total = coveredM + droppedM;
  return {
    // trimSpikes=false preserves deliberate out-and-back strokes: a user
    // sketch's spike (the swoosh tail, a unicorn horn) IS the art, and
    // splicing it out amputates the drawing. Default stays on for
    // single-blob organic shapes where spurs really are routing noise.
    chain: opts.trimSpikes === false ? out : trimNubs(out),
    coverage: total > 0 ? coveredM / total : 0,
    maxGapM,
  };
}

/** Splice out short out-and-back excursions (dead-end spurs) that read as errors. */
function trimNubs(chain: LatLng[], closeM = 34, maxLoopM = 380): LatLng[] {
  const out = chain.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length - 2; i++) {
      let acc = 0;
      for (let j = i + 2; j < out.length && acc < maxLoopM; j++) {
        acc += meters(out[j - 1]!, out[j]!);
        if (meters(out[i]!, out[j]!) < closeM) {
          out.splice(i + 1, j - i);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Placement search
// ---------------------------------------------------------------------------
type UnitPoint = [number, number];

function place(unit: UnitPoint[], center: LatLng, scaleM: number, rotDeg: number): LatLng[] {
  const r = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return unit.map(([x, y]) => {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    return [center[0] + (ry * scaleM) / M_PER_LAT, center[1] + (rx * scaleM) / mPerLng(center[0])] as LatLng;
  });
}

function sampleOutline(outline: LatLng[], n: number): LatLng[] {
  let total = 0;
  const seg: number[] = [0];
  for (let i = 1; i < outline.length; i++) {
    total += meters(outline[i - 1]!, outline[i]!);
    seg.push(total);
  }
  const out: LatLng[] = [];
  for (let k = 0; k < n; k++) {
    const d = (k / n) * total;
    let i = 1;
    while (i < seg.length && seg[i]! < d) i++;
    const t = (d - seg[i - 1]!) / (seg[i]! - seg[i - 1]! || 1);
    const a = outline[i - 1]!;
    const b = outline[Math.min(i, outline.length - 1)]!;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/**
 * The DISTINCTIVE parts (a head-curve, a sharp point) are what make a
 * design recognizable — the placement must land those on matching city
 * geometry. Weight outline samples by local curvature.
 */
function curvatureWeights(pts: LatLng[]): number[] {
  const n = pts.length;
  const w: number[] = [];
  const K = Math.max(2, Math.round(n / 40));
  for (let i = 0; i < n; i++) {
    const a = pts[(i - K + n) % n]!;
    const b = pts[i]!;
    const c = pts[(i + K) % n]!;
    const v1 = [(b[0] - a[0]) * M_PER_LAT, (b[1] - a[1]) * mPerLng(a[0])];
    const v2 = [(c[0] - b[0]) * M_PER_LAT, (c[1] - b[1]) * mPerLng(b[0])];
    const d1 = Math.hypot(v1[0]!, v1[1]!) || 1;
    const d2 = Math.hypot(v2[0]!, v2[1]!) || 1;
    const cos = (v1[0]! * v2[0]! + v1[1]! * v2[1]!) / (d1 * d2);
    w[i] = 0.15 + (1 - Math.max(-1, Math.min(1, cos)));
  }
  return w;
}

function coarseScore(g: Graph, outline: LatLng[]): { score: number; miss: number } {
  const pts = sampleOutline(outline, 72);
  const w = curvatureWeights(pts);
  let wsum = 0;
  let acc = 0;
  let miss = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const nd = nearestNode(g, p);
    const d = nd < 0 ? 500 : meters(p, g.coord[nd]!);
    if (d > 130) miss++;
    let bendPenalty = 0;
    if (w[i]! > 0.9 && nd >= 0) {
      const nbrs = (g.adj[nd] ?? []).map((e) => g.coord[e.to]!);
      let bestTurn = 0;
      for (let a = 0; a < nbrs.length; a++) {
        for (let b = a + 1; b < nbrs.length; b++) {
          const v1 = [
            (nbrs[a]![0] - g.coord[nd]![0]) * M_PER_LAT,
            (nbrs[a]![1] - g.coord[nd]![1]) * mPerLng(g.coord[nd]![0]),
          ];
          const v2 = [
            (nbrs[b]![0] - g.coord[nd]![0]) * M_PER_LAT,
            (nbrs[b]![1] - g.coord[nd]![1]) * mPerLng(g.coord[nd]![0]),
          ];
          const d1 = Math.hypot(v1[0]!, v1[1]!) || 1;
          const d2 = Math.hypot(v2[0]!, v2[1]!) || 1;
          const cos = (v1[0]! * v2[0]! + v1[1]! * v2[1]!) / (d1 * d2);
          const turn = 1 - Math.abs(cos);
          if (turn > bestTurn) bestTurn = turn;
        }
      }
      bendPenalty = (1 - Math.min(1, bestTurn * 1.6)) * 55 * w[i]!;
    }
    acc += w[i]! * Math.min(d, 300) + bendPenalty;
    wsum += w[i]!;
  }
  return { score: acc / (wsum || 1) + miss * 40, miss };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export type StreetTraceCandidate = {
  /** Traced street route (already on real street geometry). */
  chain: LatLng[];
  /** Placed target outline the trace was hugging (the intended art). */
  target: LatLng[];
  km: number;
  meanDeviationM: number;
  center: LatLng;
  scaleM: number;
  rotDeg: number;
};

/**
 * Normalized 0..1 (y down) contour → unit [-1,1] (y up) centered shape.
 */
function toUnit(contour: NormalizedPoint[]): UnitPoint[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of contour) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return contour.map((p) => [
    ((p.x - cx) * 2) / span,
    ((cy - p.y) * 2) / span,
  ]);
}

/**
 * Find where the city's streets best draw this shape, then trace it there.
 * Pure CPU on the cached graph — a request takes a few seconds.
 */
export async function traceShapeOnStreets(
  contour: NormalizedPoint[],
  options: {
    topK?: number;
    targetDistanceKm?: number;
    trimSpikes?: boolean;
    /** Trace anchor spacing, meters. Default 200; multi-piece sketches
     * with letter-scale detail need ~120 or the letters blur out. */
    anchorM?: number;
    /** Placement sweep overrides (half-size meters / rotation degrees). */
    scales?: number[];
    rots?: number[];
    /** False for open multi-piece sketches (no phantom closing chord). */
    closeLoop?: boolean;
  } = {},
): Promise<StreetTraceCandidate[]> {
  const topK = Math.max(1, Math.min(4, options.topK ?? 3));
  const unit = toUnit(contour);
  if (unit.length < 4) return [];
  const g = await getStreetGraph();

  // Hero scale is what makes curves read (the circle proof spans Midtown).
  // scaleM is the shape's half-size: 1400 → ~2.8 km drawing.
  const scales = options.scales ?? [1400, 2000, 2700];
  const rots = options.rots ?? [0, 15, -15, 29];
  const cands: { center: LatLng; scale: number; rot: number; score: number }[] = [];
  for (let lat = 40.71; lat <= 40.792; lat += 0.008) {
    for (let lng = -74.012; lng <= -73.938; lng += 0.008) {
      for (const scale of scales) {
        for (const rot of rots) {
          const outline = place(unit, [lat, lng], scale, rot);
          const { score, miss } = coarseScore(g, outline);
          // miss counts outline samples with no street within 130 m — i.e.
          // rivers, parks, off-island. 8-of-72 allowed shapes to hang a full
          // lobe over the water and still win ("floating above Manhattan,
          // half in the river"). At most 2 stray samples now.
          if (miss <= 2) cands.push({ center: [lat, lng], scale, rot, score });
        }
      }
    }
  }
  cands.sort((a, b) => a.score - b.score);

  const picks: typeof cands = [];
  for (const c of cands) {
    if (picks.length >= topK + 2) break;
    if (
      picks.some(
        (p) => meters(p.center, c.center) < 500 && Math.abs(p.scale - c.scale) < 300,
      )
    ) {
      continue;
    }
    picks.push(c);
  }

  const traced: StreetTraceCandidate[] = [];
  for (const pk of picks) {
    const target = place(unit, pk.center, pk.scale, pk.rot);
    const {
      chain,
      coverage,
      maxGapM,
    } = traceContour(g, target, {
      anchorM: options.anchorM ?? 200,
      lambda: 12,
      corridorM: 90,
      trimSpikes: options.trimSpikes,
      closeLoop: options.closeLoop,
    });
    if (
      typeof process !== "undefined" &&
      process.env?.STREET_TRACE_DEBUG === "1"
    ) {
      console.log(
        `[street-trace:debug] scale=${pk.scale} rot=${pk.rot} coverage=${coverage.toFixed(3)} maxGap=${maxGapM.toFixed(0)} chain=${chain.length}`,
      );
    }
    if (chain.length < 8) continue;
    // RUNNABILITY GATE: every dropped leg is a teleport. If the streets
    // couldn't draw ≥95% of the shape connected, this placement is not a
    // route — reject it instead of shipping a floating fragment.
    if (coverage < 0.95 || maxGapM > 180) continue;
    let dev = 0;
    for (const p of chain) {
      let m = Infinity;
      for (let j = 1; j < target.length; j++) {
        const dd = distToSeg(p, target[j - 1]!, target[j]!);
        if (dd < m) m = dd;
      }
      dev += m;
    }
    dev /= chain.length;
    let km = 0;
    for (let j = 1; j < chain.length; j++) km += meters(chain[j - 1]!, chain[j]!);
    km /= 1000;
    if (options.targetDistanceKm != null && Number.isFinite(options.targetDistanceKm)) {
      if (km > options.targetDistanceKm * 3.4) continue;
    }
    traced.push({
      chain,
      target,
      km: Number(km.toFixed(2)),
      meanDeviationM: Number(dev.toFixed(1)),
      center: pk.center,
      scaleM: pk.scale,
      rotDeg: pk.rot,
    });
  }
  traced.sort((a, b) => a.meanDeviationM - b.meanDeviationM);
  return traced.slice(0, topK);
}
