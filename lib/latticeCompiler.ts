/**
 * Lattice compiler — the production version of the "compile designs onto the
 * street lattice" approach that produced the curated Manhattan runs.
 *
 * Instead of projecting a contour onto the map and letting Mapbox pick
 * shortest walking paths between sparse anchors (which erases the shape),
 * this quantizes an already-placed contour onto real street junctions and
 * routes every leg along the actual street graph with a hug-the-chord
 * penalty. The output chain visits real intersections one block at a time,
 * so a walking-directions snap of it reproduces it near-losslessly.
 *
 * Pure logic — the graph data (lib/data/manhattan-lattice.json) is passed in,
 * so everything here is unit-testable with a synthetic grid.
 */

export type LatLng = [number, number];

export type LatticeData = {
  version: number;
  city: string;
  bounds: { south: number; west: number; north: number; east: number };
  /** Junction coordinates, index-addressed. */
  nodes: LatLng[];
  /** [nodeA, nodeB, lengthMeters, viaPoints (a->b order, endpoints excluded)] */
  edges: [number, number, number, LatLng[]][];
};

type AdjEntry = {
  to: number;
  len: number;
  /** Simplified intermediate geometry in a->to order. */
  via: LatLng[];
};

export type LatticeGraph = {
  nodes: LatLng[];
  adj: Map<number, AdjEntry[]>;
  /** Spatial hash: cell key -> node indices. */
  cells: Map<string, number[]>;
  cellSizeDeg: number;
};

export type LatticeCompileOptions = {
  /** Resample spacing along the input path, meters. Default 45. */
  sampleMeters?: number;
  /** Max distance from an input sample to a junction to pin it, meters. Default 120. */
  pinRadiusMeters?: number;
  /** Min travel along the input between consecutive pins, meters. Default 55. */
  minPinSpacingMeters?: number;
  /** Reject a leg whose street path exceeds chord * ratio + slack. Defaults 1.9 / 120. */
  maxLegDetourRatio?: number;
  maxLegDetourSlackMeters?: number;
};

export type LatticeCompileResult = {
  /** Full coordinate chain: every junction + curved-edge geometry, in order. */
  chain: LatLng[];
  /** Junction waypoints only (the pins actually visited). */
  junctions: LatLng[];
  km: number;
  inputKm: number;
  /** Mean/max distance from input samples to the compiled chain, meters. */
  meanDeviationMeters: number;
  maxDeviationMeters: number;
  legCount: number;
  /** Pins that had to be skipped because no acceptable street path existed. */
  skippedPins: number;
};

const EARTH_M_PER_DEG_LAT = 111320;

function metersPerDegLng(latDeg: number): number {
  return EARTH_M_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Distance (meters) from point p to segment a-b, equirectangular approx. */
function pointToSegmentMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const mLng = metersPerDegLng(a[0]);
  const px = (p[1] - a[1]) * mLng;
  const py = (p[0] - a[0]) * EARTH_M_PER_DEG_LAT;
  const bx = (b[1] - a[1]) * mLng;
  const by = (b[0] - a[0]) * EARTH_M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

const CELL_SIZE_DEG = 0.003; // ~330 m of latitude per cell

function cellKey(lat: number, lng: number, size: number): string {
  return `${Math.floor(lat / size)}:${Math.floor(lng / size)}`;
}

export function buildLatticeGraph(data: LatticeData): LatticeGraph {
  const adj = new Map<number, AdjEntry[]>();
  const push = (from: number, entry: AdjEntry) => {
    let list = adj.get(from);
    if (!list) {
      list = [];
      adj.set(from, list);
    }
    list.push(entry);
  };
  for (const [a, b, len, via] of data.edges) {
    push(a, { to: b, len, via });
    push(b, { to: a, len, via: [...via].reverse() });
  }
  const cells = new Map<string, number[]>();
  data.nodes.forEach(([lat, lng], i) => {
    const key = cellKey(lat, lng, CELL_SIZE_DEG);
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  });
  return { nodes: data.nodes, adj, cells, cellSizeDeg: CELL_SIZE_DEG };
}

/** Nearest junction to a point within maxMeters, or -1. */
export function nearestLatticeNode(
  graph: LatticeGraph,
  p: LatLng,
  maxMeters: number,
): number {
  return nearestLatticeNodeBiased(graph, p, maxMeters, null, 0);
}

/**
 * Nearest junction, optionally pulled toward a direction: a corner apex
 * (star tip, heart point) should pin to the junction that sits OUT toward
 * the tip, not whichever is metrically closest — nearest is usually inside
 * the shape and truncates the feature.
 */
export function nearestLatticeNodeBiased(
  graph: LatticeGraph,
  p: LatLng,
  maxMeters: number,
  outwardUnit: [number, number] | null,
  biasMeters: number,
): number {
  const size = graph.cellSizeDeg;
  const cellRadius = Math.ceil(maxMeters / (EARTH_M_PER_DEG_LAT * size));
  const baseLat = Math.floor(p[0] / size);
  const baseLng = Math.floor(p[1] / size);
  const mLng = metersPerDegLng(p[0]);
  let best = -1;
  let bestScore = maxMeters;
  for (let dy = -cellRadius; dy <= cellRadius; dy++) {
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      const list = graph.cells.get(`${baseLat + dy}:${baseLng + dx}`);
      if (!list) continue;
      for (const i of list) {
        const d = haversineMeters(p, graph.nodes[i]);
        if (d > maxMeters) continue;
        let score = d;
        if (outwardUnit && biasMeters > 0 && d > 1) {
          const ex = (graph.nodes[i][1] - p[1]) * mLng;
          const ey = (graph.nodes[i][0] - p[0]) * EARTH_M_PER_DEG_LAT;
          const cos = (ex * outwardUnit[0] + ey * outwardUnit[1]) / d;
          score = d - biasMeters * Math.max(0, cos);
        }
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
  }
  return best;
}

/**
 * Indices of high-curvature samples (corners): local maxima of the turn
 * angle measured over a +/-2 sample window. Wraps when the path is closed
 * so a corner at the seam (a heart's notch) is still found.
 */
export function detectCornerSamples(
  samples: LatLng[],
  closed: boolean,
  minTurnDeg = 38,
): Set<number> {
  const n = closed ? samples.length - 1 : samples.length;
  if (n < 5) return new Set();
  const idx = (i: number) => (closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i)));
  const turn: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!closed && (i < 2 || i > n - 3)) continue;
    const a = samples[idx(i - 2)];
    const b = samples[i];
    const c = samples[idx(i + 2)];
    const mLng = metersPerDegLng(b[0]);
    const v1x = (b[1] - a[1]) * mLng;
    const v1y = (b[0] - a[0]) * EARTH_M_PER_DEG_LAT;
    const v2x = (c[1] - b[1]) * mLng;
    const v2y = (c[0] - b[0]) * EARTH_M_PER_DEG_LAT;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1 || l2 < 1) continue;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
    turn[i] = (Math.acos(cos) * 180) / Math.PI;
  }
  const corners = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (turn[i] < minTurnDeg) continue;
    const prev = turn[idx(i - 1)];
    const next = turn[idx(i + 1)];
    if (turn[i] >= prev && turn[i] >= next) corners.add(i);
  }
  return corners;
}

/** Unit vector pointing outward from a corner (away from the turn's inside). */
export function cornerOutwardUnit(
  samples: LatLng[],
  i: number,
  closed: boolean,
): [number, number] | null {
  const n = closed ? samples.length - 1 : samples.length;
  const idx = (k: number) => (closed ? (k + n) % n : Math.max(0, Math.min(n - 1, k)));
  const a = samples[idx(i - 2)];
  const b = samples[i];
  const c = samples[idx(i + 2)];
  const mLng = metersPerDegLng(b[0]);
  const inX = (b[1] - a[1]) * mLng;
  const inY = (b[0] - a[0]) * EARTH_M_PER_DEG_LAT;
  const outX = (c[1] - b[1]) * mLng;
  const outY = (c[0] - b[0]) * EARTH_M_PER_DEG_LAT;
  const l1 = Math.hypot(inX, inY);
  const l2 = Math.hypot(outX, outY);
  if (l1 < 1 || l2 < 1) return null;
  // bisector of (reversed incoming) and outgoing points INTO the turn;
  // the apex sticks out the other way
  const bx = -inX / l1 + outX / l2;
  const by = -inY / l1 + outY / l2;
  const bl = Math.hypot(bx, by);
  if (bl < 0.05) return null; // straight-through: no meaningful apex
  return [-bx / bl, -by / bl];
}

/** Resample a polyline to roughly even spacing (meters). Keeps endpoints. */
export function resamplePathMeters(
  path: LatLng[],
  spacingMeters: number,
): LatLng[] {
  if (path.length < 2) return [...path];
  const out: LatLng[] = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const segLen = haversineMeters(a, b);
    if (segLen === 0) continue;
    let along = spacingMeters - carry;
    while (along < segLen) {
      const t = along / segLen;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      along += spacingMeters;
    }
    carry = segLen - (along - spacingMeters);
  }
  const last = path[path.length - 1];
  const tail = out[out.length - 1];
  if (haversineMeters(last, tail) > 1) out.push(last);
  return out;
}

/**
 * A* over the lattice from `from` to `to`, biased to hug the straight chord
 * between them: each edge pays its length plus a penalty for how far its
 * far endpoint strays from the chord. Pins are typically 1-3 blocks apart,
 * so the chord is a faithful stand-in for the drawn line between them.
 */
function hugChordAStar(
  graph: LatticeGraph,
  from: number,
  to: number,
  devWeight: number,
): { path: number[]; lengthM: number } | null {
  if (from === to) return { path: [from], lengthM: 0 };
  const chordA = graph.nodes[from];
  const chordB = graph.nodes[to];
  const g = new Map<number, number>([[from, 0]]);
  const lenAt = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const done = new Set<number>();
  // [f, g, node]
  const open: [number, number, number][] = [
    [haversineMeters(chordA, chordB), 0, from],
  ];
  while (open.length > 0) {
    let bestI = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i][0] < open[bestI][0]) bestI = i;
    }
    const [, gc, cur] = open.splice(bestI, 1)[0];
    if (cur === to) break;
    if (done.has(cur)) continue;
    done.add(cur);
    for (const { to: nxt, len } of graph.adj.get(cur) ?? []) {
      const dev = pointToSegmentMeters(graph.nodes[nxt], chordA, chordB);
      const cost = len + devWeight * dev;
      const ng = gc + cost;
      if (ng < (g.get(nxt) ?? Infinity)) {
        g.set(nxt, ng);
        lenAt.set(nxt, (lenAt.get(cur) ?? 0) + len);
        prev.set(nxt, cur);
        open.push([ng + haversineMeters(graph.nodes[nxt], chordB), ng, nxt]);
      }
    }
  }
  if (!prev.has(to)) return null;
  const path: number[] = [];
  let cur: number | undefined = to;
  while (cur !== undefined) {
    path.push(cur);
    cur = prev.get(cur);
  }
  path.reverse();
  return { path, lengthM: lenAt.get(to) ?? 0 };
}

function appendLegGeometry(
  chain: LatLng[],
  graph: LatticeGraph,
  nodePath: number[],
): void {
  for (let i = 0; i < nodePath.length; i++) {
    const node = graph.nodes[nodePath[i]];
    if (i > 0) {
      const fromNode = nodePath[i - 1];
      const entry = graph.adj
        .get(fromNode)
        ?.find((e) => e.to === nodePath[i]);
      if (entry) {
        for (const v of entry.via) chain.push(v);
      }
    }
    const last = chain[chain.length - 1];
    if (!last || last[0] !== node[0] || last[1] !== node[1]) {
      chain.push(node);
    }
  }
}

/**
 * Compile a placed contour (lat/lng polyline) onto the street lattice.
 * Returns null when the placement can't be expressed on this lattice
 * (too few reachable junctions — e.g. dropped in a park or off-grid).
 */
export function compileContourToLattice(
  pathLatLngs: LatLng[],
  graph: LatticeGraph,
  options: LatticeCompileOptions = {},
): LatticeCompileResult | null {
  const sampleM = options.sampleMeters ?? 45;
  const pinRadiusM = options.pinRadiusMeters ?? 120;
  const minPinSpacingM = options.minPinSpacingMeters ?? 55;
  const detourRatio = options.maxLegDetourRatio ?? 1.9;
  const detourSlackM = options.maxLegDetourSlackMeters ?? 120;

  if (pathLatLngs.length < 3) return null;
  const closed =
    haversineMeters(pathLatLngs[0], pathLatLngs[pathLatLngs.length - 1]) < 80;
  const samples = resamplePathMeters(pathLatLngs, sampleM);
  if (samples.length < 4) return null;

  let inputKm = 0;
  for (let i = 1; i < pathLatLngs.length; i++) {
    inputKm += haversineMeters(pathLatLngs[i - 1], pathLatLngs[i]);
  }
  inputKm /= 1000;

  // Pin samples to junctions. Corners pin first-class (wider radius, biased
  // toward the apex) so tips and notches survive quantization; between
  // corners, suppress jitter: a new pin needs either a new junction or real
  // travel along the drawing since the previous pin.
  const corners = detectCornerSamples(samples, closed);
  const pins: number[] = [];
  const pinIsCorner: boolean[] = [];
  let missed = 0;
  let alongSincePin = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i > 0) alongSincePin += haversineMeters(samples[i - 1], samples[i]);
    const isCorner = corners.has(i);
    const node = isCorner
      ? nearestLatticeNodeBiased(
          graph,
          samples[i],
          pinRadiusM * 1.15,
          cornerOutwardUnit(samples, i, closed),
          35,
        )
      : nearestLatticeNode(graph, samples[i], pinRadiusM);
    if (node === -1) {
      missed++;
      continue;
    }
    const last = pins[pins.length - 1];
    if (node === last) continue;
    if (!isCorner && pins.length > 0 && alongSincePin < minPinSpacingM) {
      continue;
    }
    // A-B-A flicker between two junctions straddling the line: require real
    // travel before returning to the pin before last. Corners are exempt —
    // a genuine tip IS an out-and-back.
    if (
      !isCorner &&
      pins.length >= 2 &&
      node === pins[pins.length - 2] &&
      alongSincePin < 140
    ) {
      continue;
    }
    pins.push(node);
    pinIsCorner.push(isCorner);
    alongSincePin = 0;
  }
  // Too much of the drawing has no street underneath it -> not compilable here.
  if (missed > samples.length * 0.2) return null;
  if (closed && pins.length >= 3 && pins[0] !== pins[pins.length - 1]) {
    pins.push(pins[0]);
    pinIsCorner.push(false);
  }
  if (pins.length < 4) return null;

  // Route each leg; skip pins whose legs would force big detours.
  const chain: LatLng[] = [];
  const junctions: LatLng[] = [graph.nodes[pins[0]]];
  let totalM = 0;
  let legCount = 0;
  let skippedPins = 0;
  let cur = pins[0];
  chain.push(graph.nodes[pins[0]]);
  for (let i = 1; i < pins.length; i++) {
    const target = pins[i];
    if (target === cur) continue;
    const chordM = haversineMeters(graph.nodes[cur], graph.nodes[target]);
    const leg = hugChordAStar(graph, cur, target, 1.5);
    // Legs touching a corner pin may legitimately double back (a star tip is
    // an out-and-back) — give them extra detour headroom.
    const cornerLeg = pinIsCorner[i] || pinIsCorner[i - 1];
    const maxLegM = cornerLeg
      ? chordM * (detourRatio + 0.9) + detourSlackM + 60
      : chordM * detourRatio + detourSlackM;
    if (!leg || leg.lengthM > maxLegM) {
      skippedPins++;
      // A skipped closing pin would leave the loop open; treat as failure
      // only if we end up skipping too much overall (checked below).
      continue;
    }
    appendLegGeometry(chain, graph, leg.path);
    junctions.push(graph.nodes[target]);
    totalM += leg.lengthM;
    legCount++;
    cur = target;
  }
  if (legCount < 3) return null;
  if (skippedPins > pins.length * 0.25) return null;

  // Fidelity: how far does the compiled chain sit from the drawing?
  let devSum = 0;
  let devMax = 0;
  for (const s of samples) {
    let best = Infinity;
    for (let i = 1; i < chain.length; i++) {
      const d = pointToSegmentMeters(s, chain[i - 1], chain[i]);
      if (d < best) best = d;
      if (best < 1) break;
    }
    if (Number.isFinite(best)) {
      devSum += best;
      if (best > devMax) devMax = best;
    }
  }

  return {
    chain,
    junctions,
    km: totalM / 1000,
    inputKm,
    meanDeviationMeters: devSum / samples.length,
    maxDeviationMeters: devMax,
    legCount,
    skippedPins,
  };
}
