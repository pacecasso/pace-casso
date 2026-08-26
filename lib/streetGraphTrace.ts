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

import { scoreFinalRouteSimilarity } from "./finalRouteSimilarity";

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

function unitDirection(a: LatLng, b: LatLng): [number, number] {
  const x = (b[1] - a[1]) * mPerLng((a[0] + b[0]) / 2);
  const y = (b[0] - a[0]) * M_PER_LAT;
  const length = Math.hypot(x, y) || 1;
  return [x / length, y / length];
}

function directionDot(
  a: [number, number],
  b: [number, number],
): number {
  return a[0] * b[0] + a[1] * b[1];
}

/**
 * Snap an artwork anchor to a street node whose incident streets support the
 * contour's incoming and outgoing directions. Pure nearest-node snapping
 * alternates between parallel blocks and selects dead ends, creating ladders
 * and false out-and-back marks in the final drawing.
 */
type AnchorNodeCandidate = { id: number; score: number };

function directionAwareAnchorCandidates(
  g: Graph,
  dense: LatLng[],
  denseIndex: number,
  closed: boolean,
  limit = 5,
): AnchorNodeCandidate[] {
  const last = dense.length - 1;
  const cycleLength = closed ? Math.max(1, last) : dense.length;
  const index = Math.max(0, Math.min(denseIndex, last));
  const step = Math.min(4, Math.max(1, Math.floor(cycleLength / 12)));
  const offsetIndex = (delta: number): number => {
    if (!closed) return Math.max(0, Math.min(last, index + delta));
    const base = index === last ? 0 : index;
    return ((base + delta) % cycleLength + cycleLength) % cycleLength;
  };
  const prev = dense[offsetIndex(-step)]!;
  const point = dense[index]!;
  const next = dense[offsetIndex(step)]!;
  const incoming = unitDirection(prev, point);
  const outgoing = unitDirection(point, next);
  const openStart = !closed && index === 0;
  const openEnd = !closed && index === last;
  const hairpin = directionDot(incoming, outgoing) < -0.35;

  const clat = Math.round(point[0] / CELL);
  const clng = Math.round(point[1] / CELL);
  const candidates = new Set<number>();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const key = String(clat + dr) + ":" + String(clng + dc);
      for (const id of g.grid.get(key) ?? []) candidates.add(id);
    }
  }

  const ranked: AnchorNodeCandidate[] = [];
  for (const id of candidates) {
    const node = g.coord[id]!;
    const distance = meters(point, node);
    const edges = g.adj[id] ?? [];
    let directionCost = 4;
    for (let a = 0; a < edges.length; a++) {
      const incomingEdge = unitDirection(node, g.coord[edges[a]!.to]!);
      const arrival: [number, number] = [-incomingEdge[0], -incomingEdge[1]];
      if (openEnd) {
        directionCost = Math.min(
          directionCost,
          1 - directionDot(arrival, incoming),
        );
        continue;
      }
      for (let b = 0; b < edges.length; b++) {
        const departure = unitDirection(node, g.coord[edges[b]!.to]!);
        if (openStart) {
          directionCost = Math.min(
            directionCost,
            1 - directionDot(departure, outgoing),
          );
          continue;
        }
        if (a === b && !hairpin) continue;
        const cost =
          1 - directionDot(arrival, incoming) +
          1 - directionDot(departure, outgoing);
        if (cost < directionCost) directionCost = cost;
      }
    }
    const deadEndPenalty =
      edges.length < 2 && !hairpin && !openStart && !openEnd ? 260 : 0;
    const farPenalty = Math.max(0, distance - 180) * 3;
    const score = distance + directionCost * 110 + deadEndPenalty + farPenalty;
    ranked.push({ id, score });
  }
  ranked.sort((a, b) => a.score - b.score);
  if (ranked.length) return ranked.slice(0, Math.max(1, limit));
  const fallback = nearestNode(g, point);
  return fallback >= 0 ? [{ id: fallback, score: 0 }] : [];
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
  bendWeight = 28,
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
  const keyOf = (prev: number, cur: number) => String(prev) + ":" + String(cur);
  const parseKey = (key: string): [number, number] => {
    const sep = key.indexOf(":");
    return [Number(key.slice(0, sep)), Number(key.slice(sep + 1))];
  };
  const startKey = keyOf(-1, a);
  const open = new Map<string, number>([[startKey, 0]]);
  const gScore = new Map<string, number>([[startKey, 0]]);
  const came = new Map<string, string>();
  const done = new Set<string>();
  let guard = 0;
  while (open.size && guard++ < 400000) {
    let curKey = "";
    let cf = Infinity;
    for (const [key, f] of open) {
      if (f < cf) {
        cf = f;
        curKey = key;
      }
    }
    const [prev, cur] = parseKey(curKey);
    if (cur === b) {
      const pathIds = [cur];
      let walkKey = curKey;
      while (came.has(walkKey)) {
        const [camePrev] = parseKey(walkKey);
        pathIds.push(camePrev);
        walkKey = came.get(walkKey)!;
      }
      return pathIds.reverse();
    }
    open.delete(curKey);
    done.add(curKey);
    for (const { to, w } of g.adj[cur] ?? []) {
      const nextKey = keyOf(cur, to);
      if (done.has(nextKey)) continue;
      const cto = g.coord[to]!;
      const dc = distContour(cto);
      if (dc > corridorM) continue;
      let bendPenalty = 0;
      if (prev >= 0 && g.coord[prev]) {
        const incoming = unitDirection(g.coord[prev]!, g.coord[cur]!);
        const outgoing = unitDirection(g.coord[cur]!, cto);
        const dot = Math.max(-1, Math.min(1, directionDot(incoming, outgoing)));
        bendPenalty = (1 - dot) * bendWeight;
      }
      const tentative = gScore.get(curKey)! + w + lambda * dc + bendPenalty;
      if (tentative < (gScore.get(nextKey) ?? Infinity)) {
        came.set(nextKey, curKey);
        gScore.set(nextKey, tentative);
        open.set(nextKey, tentative + meters(cto, target));
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
  hasIntentionalRetrace?: boolean;
  /** Fraction of the target outline the streets actually drew (routed legs / all legs, by length). */
  coverage: number;
  /** Longest single dropped stretch, meters — a teleport in the route. */
  maxGapM: number;
};

type TraceAnchor = {
  point: LatLng;
  denseIndex: number;
};

function addRdpLandmarks(
  points: LatLng[],
  start: number,
  end: number,
  toleranceM: number,
  keep: Set<number>,
): void {
  const stack: Array<[number, number]> = [[start, end]];
  keep.add(start);
  keep.add(end);
  while (stack.length) {
    const [from, to] = stack.pop()!;
    if (to - from < 2) continue;
    let bestIndex = -1;
    let bestDistance = toleranceM;
    for (let i = from + 1; i < to; i++) {
      const distance = distToSeg(points[i]!, points[from]!, points[to]!);
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) continue;
    keep.add(bestIndex);
    stack.push([from, bestIndex], [bestIndex, to]);
  }
}

/**
 * Preserve high-salience bends exactly, then add only enough intermediate
 * anchors to keep long edges routable. Uniform spacing alone either misses
 * logo landmarks or overfits every block-sized pixel step.
 */
function traceAnchorIndexes(
  dense: LatLng[],
  anchorM: number,
  closed: boolean,
): number[] {
  const last = dense.length - 1;
  if (last <= 0) return [0];
  const toleranceM = Math.max(35, Math.min(120, anchorM * 0.28));
  const landmarks = new Set<number>();

  if (closed && meters(dense[0]!, dense[last]!) < 30 && last >= 4) {
    let split = 1;
    let farthest = 0;
    for (let i = 1; i < last; i++) {
      const distance = meters(dense[0]!, dense[i]!);
      if (distance > farthest) {
        farthest = distance;
        split = i;
      }
    }
    addRdpLandmarks(dense, 0, split, toleranceM, landmarks);
    addRdpLandmarks(dense, split, last, toleranceM, landmarks);
  } else {
    addRdpLandmarks(dense, 0, last, toleranceM, landmarks);
  }

  const indexes = [0];
  const forced = [true];
  let accumulated = 0;
  for (let i = 1; i <= last; i++) {
    accumulated += meters(dense[i - 1]!, dense[i]!);
    const landmark = landmarks.has(i);
    if (landmark) {
      if (
        accumulated < anchorM * 0.3 &&
        indexes.length > 1 &&
        !forced[forced.length - 1]
      ) {
        indexes[indexes.length - 1] = i;
        forced[forced.length - 1] = true;
      } else if (indexes[indexes.length - 1] !== i) {
        indexes.push(i);
        forced.push(true);
      }
      accumulated = 0;
    } else if (accumulated >= anchorM) {
      indexes.push(i);
      forced.push(false);
      accumulated = 0;
    }
  }
  if (indexes[indexes.length - 1] !== last) indexes.push(last);
  return indexes;
}

type RetracedPrefix = {
  turnIndex: number;
  returnIndex: number;
};

function pathLength(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += meters(points[i - 1]!, points[i]!);
  }
  return total;
}

/**
 * Find an intentional out-and-back stroke at the start of a drawing. The
 * street-resolution compiler uses this for details narrower than one block:
 * draw the centerline, retrace it, then continue around the broad silhouette.
 */
function findRetracedPrefix(contour: LatLng[]): RetracedPrefix | null {
  const maxReturn = Math.min(
    contour.length - 2,
    Math.floor(contour.length * 0.7),
  );
  for (let returnIndex = 6; returnIndex <= maxReturn; returnIndex += 2) {
    if (meters(contour[0]!, contour[returnIndex]!) > 2) continue;
    const turnIndex = returnIndex / 2;
    let matches = true;
    for (let i = 0; i <= turnIndex; i++) {
      if (meters(contour[i]!, contour[returnIndex - i]!) > 2) {
        matches = false;
        break;
      }
    }
    if (
      matches &&
      pathLength(contour.slice(0, turnIndex + 1)) >= 150
    ) {
      return { turnIndex, returnIndex };
    }
  }
  return null;
}

export function traceContour(
  g: Graph,
  contour: LatLng[],
  opts: {
    anchorM: number;
    lambda: number;
    corridorM: number;
    /** A* turn cost inside a leg; higher = straighter, more deliberate lines. */
    bendWeight?: number;
    trimSpikes?: boolean;
    closeLoop?: boolean;
    startNode?: number;
    preserveRetraces?: boolean;
  },
): TraceResult {
  const retraced =
    opts.preserveRetraces === false ? null : findRetracedPrefix(contour);
  if (retraced) {
    const outboundTarget = contour.slice(0, retraced.turnIndex + 1);
    const bodyTarget = contour.slice(retraced.returnIndex);
    const outbound = traceContour(g, outboundTarget, {
      ...opts,
      closeLoop: false,
      preserveRetraces: false,
    });
    if (!outbound.chain.length) return outbound;

    const startNode = nearestNode(g, outbound.chain[0]!);
    const bodyClosed =
      bodyTarget.length > 2 &&
      meters(bodyTarget[0]!, bodyTarget[bodyTarget.length - 1]!) < 2;
    const body = traceContour(g, bodyTarget, {
      ...opts,
      closeLoop: bodyClosed,
      startNode,
      preserveRetraces: false,
    });
    const outboundM = pathLength(outboundTarget);
    const bodyM = pathLength(bodyTarget);
    const totalM = outboundM * 2 + bodyM;
    const coveredM =
      outbound.coverage * outboundM * 2 + body.coverage * bodyM;
    // Remove incidental graph loops before assembling the deliberate
    // out-and-back. Cleaning the final route would erase the intended retrace.
    const outboundChain = trimNubs(outbound.chain);
    const bodyChain = trimNubs(body.chain);
    const reverse = outboundChain.slice(0, -1).reverse();
    const bodyContinuation = bodyChain.length ? bodyChain.slice(1) : [];
    return {
      chain: [...outboundChain, ...reverse, ...bodyContinuation],
      hasIntentionalRetrace: true,
      coverage: totalM > 0 ? coveredM / totalM : 0,
      maxGapM: Math.max(outbound.maxGapM, body.maxGapM),
    };
  }

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

  const finalDenseIndex = dense.length - 1;
  const closed = opts.closeLoop !== false;
  const anchors: TraceAnchor[] = traceAnchorIndexes(
    dense,
    opts.anchorM,
    closed,
  ).map((denseIndex) => ({
    point: dense[denseIndex]!,
    denseIndex,
  }));
  // A single closed blob loops back to its start; a multi-piece sketch is
  // an OPEN drawing: force-closing it adds a phantom cross-drawing chord
  // that can never route within the leg caps and poisons coverage at
  // every placement.
  if (opts.closeLoop !== false) {
    anchors.push({ point: dense[0]!, denseIndex: dense.length });
  }

  const anchorCandidates = anchors.map((anchor, index) => {
    if (
      index > 0 &&
      closed &&
      meters(anchor.point, anchors[0]!.point) < 2
    ) {
      return [] as AnchorNodeCandidate[];
    }
    return directionAwareAnchorCandidates(
      g,
      dense,
      Math.min(anchor.denseIndex, finalDenseIndex),
      closed,
    );
  });
  if (opts.startNode != null && g.coord[opts.startNode]) {
    anchorCandidates[0] = [{ id: opts.startNode, score: 0 }];
  }
  const firstCandidate = anchorCandidates[0]?.[0];
  if (!firstCandidate) {
    return { chain: [], coverage: 0, maxGapM: Infinity };
  }
  if (closed) {
    for (let i = 1; i < anchorCandidates.length; i++) {
      if (!anchorCandidates[i]!.length) {
        anchorCandidates[i] = [{ id: firstCandidate.id, score: 0 }];
      }
    }
  }
  const chain: LatLng[] = [];
  let coveredM = 0;
  let droppedM = 0;
  let maxGapM = 0;
  let currentNode = firstCandidate.id;
  for (let i = 1; i < anchors.length; i++) {
    const prevAnchor = anchors[i - 1]!;
    const nextAnchor = anchors[i]!;
    const direct = meters(prevAnchor.point, nextAnchor.point);
    const na = currentNode;
    const candidates = anchorCandidates[i]!;
    if (na < 0 || !candidates.length) {
      droppedM += direct;
      maxGapM = Math.max(maxGapM, direct);
      continue;
    }
    const start = Math.min(prevAnchor.denseIndex, finalDenseIndex);
    const end = Math.min(nextAnchor.denseIndex, finalDenseIndex);
    const localContour =
      end > start
        ? dense.slice(start, end + 1)
        : [prevAnchor.point, nextAnchor.point];

    let selected:
      | { node: number; path: number[]; score: number }
      | null = null;
    for (const candidate of candidates) {
      const nb = candidate.id;
      if (na === nb) {
        if (direct <= 30 && (!selected || candidate.score < selected.score)) {
          selected = { node: nb, path: [na], score: candidate.score };
        }
        continue;
      }
      let path = corridorPath(
        g,
        na,
        nb,
        localContour,
        opts.lambda,
        opts.corridorM,
        opts.bendWeight,
      );
      if (!path) {
        path = corridorPath(
          g,
          na,
          nb,
          localContour,
          opts.lambda,
          opts.corridorM * 3,
          opts.bendWeight,
        );
      }
      if (!path) continue;

      let pathLengthM = 0;
      let deviationSumM = 0;
      let bendCost = 0;
      for (let k = 0; k < path.length; k++) {
        if (k > 0) {
          pathLengthM += meters(g.coord[path[k - 1]!]!, g.coord[path[k]!]!);
        }
        if (k > 0 && k < path.length - 1) {
          const incoming = unitDirection(g.coord[path[k - 1]!]!, g.coord[path[k]!]!);
          const outgoing = unitDirection(g.coord[path[k]!]!, g.coord[path[k + 1]!]!);
          const dot = Math.max(-1, Math.min(1, directionDot(incoming, outgoing)));
          bendCost += 1 - dot;
        }
        let nearest = Infinity;
        for (let j = 1; j < localContour.length; j++) {
          nearest = Math.min(
            nearest,
            distToSeg(
              g.coord[path[k]!]!,
              localContour[j - 1]!,
              localContour[j]!,
            ),
          );
        }
        deviationSumM += nearest;
      }
      if (
        pathLengthM > direct * 2.2 + 250 ||
        pathLengthM > 1400
      ) {
        continue;
      }
      const meanDeviationM = deviationSumM / Math.max(1, path.length);
      const transitionScore =
        candidate.score * 0.3 +
        meanDeviationM * 4 +
        Math.max(0, pathLengthM - direct) * 0.25 +
        bendCost * 260;
      if (!selected || transitionScore < selected.score) {
        selected = { node: nb, path, score: transitionScore };
      }
    }

    if (!selected) {
      droppedM += direct;
      maxGapM = Math.max(maxGapM, direct);
      continue;
    }
    currentNode = selected.node;
    coveredM += direct;
    for (const id of selected.path) chain.push(g.coord[id]!);
  }
  const out: LatLng[] = [];
  for (const p of chain) {
    if (!out.length || meters(out[out.length - 1]!, p) > 1) out.push(p);
  }
  const total = coveredM + droppedM;
  return {
    // Cleanup is selected later by geometry score so a deliberate hairpin
    // can survive while an accidental graph loop is removed.
    chain: out,
    coverage: total > 0 ? coveredM / total : 0,
    maxGapM,
  };
}

/**
 * Erase loops that return to (effectively) the same spot: the same graph
 * node, or another node of the same intersection. 6 m stays within one
 * intersection — a wider proximity splice could jump between different
 * streets and silently make the route unrunnable.
 */
export function trimNubs(chain: LatLng[], closeM = 6, maxLoopM = 1000): LatLng[] {
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
// Deliberateness: straighten long intended edges into single street runs
// ---------------------------------------------------------------------------

type StraightEdge = { a: LatLng; b: LatLng; segStart: number; segEnd: number };

/**
 * Merge collinear runs of target segments into logical straight edges.
 * Photo contours deliver a straight logo edge as MANY short collinear
 * segments, so per-segment length checks never see the real edge.
 */
function mergeStraightEdges(target: LatLng[], minRunM: number): StraightEdge[] {
  const edges: StraightEdge[] = [];
  if (target.length < 3) return edges;
  const heading = (a: LatLng, b: LatLng) =>
    (Math.atan2((b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180), b[0] - a[0]) * 180) /
    Math.PI;
  let runStart = 0;
  let runHeading = heading(target[0]!, target[1]!);
  const flush = (endSeg: number) => {
    const a = target[runStart]!;
    const b = target[endSeg + 1]!;
    const chord = meters(a, b);
    if (chord < minRunM) return;
    let along = 0;
    for (let i = runStart + 1; i <= endSeg + 1; i++) along += meters(target[i - 1]!, target[i]!);
    // only genuinely straight runs — a gentle arc merged by the tolerance
    // is not an edge and must not be forced onto one street
    if (chord / Math.max(1e-9, along) < 0.985) return;
    edges.push({ a, b, segStart: runStart, segEnd: endSeg });
  };
  for (let j = 1; j < target.length - 1; j++) {
    const h = heading(target[j]!, target[j + 1]!);
    let dh = Math.abs(h - runHeading);
    if (dh > 180) dh = 360 - dh;
    if (dh > 12) {
      flush(j - 1);
      runStart = j;
      runHeading = h;
    } else {
      // drift the reference heading slowly so long gentle arcs still split
      runHeading = runHeading + (((h - runHeading + 540) % 360) - 180) * 0.2;
    }
  }
  flush(target.length - 2);
  return edges;
}

/** Resample to ~stepM spacing and count heading changes above 30°. */
function deliberateTurns(pts: LatLng[], stepM = 30): number {
  if (pts.length < 3) return 0;
  const rs: LatLng[] = [pts[0]!];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += meters(pts[i - 1]!, pts[i]!);
    if (acc >= stepM) {
      rs.push(pts[i]!);
      acc = 0;
    }
  }
  rs.push(pts[pts.length - 1]!);
  let turns = 0;
  for (let i = 2; i < rs.length; i++) {
    const ax = (rs[i - 1]![1] - rs[i - 2]![1]) * Math.cos((rs[i - 1]![0] * Math.PI) / 180);
    const ay = rs[i - 1]![0] - rs[i - 2]![0];
    const bx = (rs[i]![1] - rs[i - 1]![1]) * Math.cos((rs[i - 1]![0] * Math.PI) / 180);
    const by = rs[i]![0] - rs[i - 1]![0];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-12 || lb < 1e-12) continue;
    const dot = (ax * bx + ay * by) / (la * lb);
    if (dot < Math.cos((30 * Math.PI) / 180)) turns++;
  }
  return turns;
}

/**
 * Deliberateness pass. Per-anchor tracing re-snaps to the ideal line every
 * anchorM meters, so a long straight intended edge comes out as a sawtooth
 * hopping between the parallel streets that straddle it — the top visual
 * complaint on otherwise-good routes. For each long intended edge, re-run
 * the corridor A* over the WHOLE edge (no intermediate anchors, strong
 * bend penalty) and keep the new span only when it is measurably more
 * deliberate: fewer resampled turns, not meaningfully longer, still inside
 * the corridor. Spans connect at the same graph nodes, so runnability is
 * preserved by construction.
 */
export function straightenLongRuns(
  g: Graph,
  chain: LatLng[],
  target: LatLng[],
  lambda: number,
  minRunM = 450,
): LatLng[] {
  if (chain.length < 8 || target.length < 3) return chain;
  const edges = mergeStraightEdges(target, minRunM);
  if (!edges.length) return chain;

  // A closed chain puts the first edge's points at BOTH ends (the seam),
  // fragmenting its window. Rotate the loop so it starts at a corner; the
  // caller-visible route is the same loop with a different start.
  const closed = meters(chain[0]!, chain[chain.length - 1]!) < 10;
  if (closed) {
    const ring = chain.slice(0, -1);
    const segAt = (p: LatLng) => {
      let m = Infinity;
      let si = -1;
      for (let j = 1; j < target.length; j++) {
        const dd = distToSeg(p, target[j - 1]!, target[j]!);
        if (dd < m) {
          m = dd;
          si = j - 1;
        }
      }
      return si;
    };
    const s0 = segAt(ring[0]!);
    let cut = 0;
    for (let i = 1; i < ring.length; i++) {
      if (segAt(ring[i]!) !== s0) {
        cut = i;
        break;
      }
    }
    if (cut > 0) {
      chain = [...ring.slice(cut), ...ring.slice(0, cut), ring[cut]!];
    }
  }

  // nearest target segment index for every chain point (once, shared)
  const segOf = new Array<number>(chain.length);
  for (let i = 0; i < chain.length; i++) {
    let m = Infinity;
    let si = -1;
    for (let j = 1; j < target.length; j++) {
      const dd = distToSeg(chain[i]!, target[j - 1]!, target[j]!);
      if (dd < m) {
        m = dd;
        si = j - 1;
      }
    }
    segOf[i] = m <= 150 ? si : -1;
  }
  const spanLen = (pts: LatLng[]) => {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += meters(pts[i - 1]!, pts[i]!);
    return s;
  };

  // replace back-to-front so indices stay valid
  const windows: { i0: number; i1: number; edge: StraightEdge }[] = [];
  for (const edge of edges) {
    // longest contiguous run of on-edge chain points (gap tolerance 3 —
    // corner-ambiguous points near the far end must not stretch the
    // window across unrelated edges)
    const dbgw = typeof process !== "undefined" && process.env?.STRAIGHTEN_DEBUG === "1";
    let best: [number, number] | null = null;
    let runStart = -1;
    let lastOn = -1;
    for (let i = 0; i <= chain.length; i++) {
      const on =
        i < chain.length && segOf[i]! >= edge.segStart && segOf[i]! <= edge.segEnd;
      if (on) {
        if (runStart === -1) runStart = i;
        lastOn = i;
      } else if (runStart !== -1 && (i - lastOn > 3 || i === chain.length)) {
        if (!best || lastOn - runStart > best[1] - best[0]) best = [runStart, lastOn];
        runStart = -1;
      }
    }
    if (!best || best[1] - best[0] < 4) {
      if (dbgw) console.log(`[straighten] edge seg${edge.segStart}-${edge.segEnd}: no window`);
      continue;
    }
    const [i0, i1] = best;
    // the window must cover most of the edge, not a corner clip
    const covered = meters(chain[i0]!, chain[i1]!);
    if (covered < meters(edge.a, edge.b) * 0.7) {
      if (dbgw) console.log(`[straighten] edge seg${edge.segStart}-${edge.segEnd}: partial cover ${covered.toFixed(0)}/${meters(edge.a, edge.b).toFixed(0)}`);
      continue;
    }
    windows.push({ i0, i1, edge });
  }
  windows.sort((a, b) => b.i0 - a.i0);
  const dbg = typeof process !== "undefined" && process.env?.STRAIGHTEN_DEBUG === "1";
  if (dbg) console.log(`[straighten] edges=${edges.length} windows=${windows.length}`);

  let out = chain;
  for (const { i0, i1, edge } of windows) {
    const oldSpan = out.slice(i0, i1 + 1);
    const oldTurns = deliberateTurns(oldSpan);
    if (oldTurns <= 2) { if (dbg) console.log(`[straighten] win ${i0}-${i1}: already deliberate (${oldTurns})`); continue; }
    const a = nearestNode(g, out[i0]!);
    const b = nearestNode(g, out[i1]!);
    if (a < 0 || b < 0 || a === b) continue;
    // Corridor = the span's own chord (endpoints inside by construction).
    // Weights are the INVERSE of tracing: barely-weighted line adherence
    // (lambda 12 is what carves the fine sawtooth in the first place) and
    // a heavy bend penalty, so the A* buys long straight street runs.
    const chord: [LatLng, LatLng] = [out[i0]!, out[i1]!];
    // 150 m corridor first; superblocks (Grand Central, Port Authority)
    // can pinch it shut, so retry wider — the maxDev gate below still
    // rejects results that wander.
    const ids =
      corridorPath(g, a, b, chord, 1.2, 150, 320) ??
      corridorPath(g, a, b, chord, 1.2, 260, 320);
    if (!ids || ids.length < 2) { if (dbg) console.log(`[straighten] win ${i0}-${i1}: no corridor path (chord ${meters(chord[0], chord[1]).toFixed(0)}m ${chord[0]![0].toFixed(4)},${chord[0]![1].toFixed(4)} -> ${chord[1]![0].toFixed(4)},${chord[1]![1].toFixed(4)})`); continue; }
    const newSpan = ids.map((id) => g.coord[id]!);
    // corridor discipline: no point of the new span may leave the edge zone
    let maxDev = 0;
    for (const p of newSpan) {
      const dd = distToSeg(p, chord[0], chord[1]);
      if (dd > maxDev) maxDev = dd;
    }
    if (maxDev > 170) { if (dbg) console.log(`[straighten] win ${i0}-${i1}: maxDev ${maxDev.toFixed(0)}`); continue; }
    const newTurns = deliberateTurns(newSpan);
    const oldLen = spanLen(oldSpan);
    const newLen = spanLen(newSpan);
    if (dbg) console.log(`[straighten] win ${i0}-${i1}: turns ${oldTurns}->${newTurns} len ${oldLen.toFixed(0)}->${newLen.toFixed(0)} dev ${maxDev.toFixed(0)}`);
    // accept either a strictly-free improvement or a big deliberateness
    // win bought with a little distance
    const freeWin = newTurns < oldTurns && newLen <= oldLen * 1.02;
    const bigWin = newTurns <= oldTurns * 0.7 && newLen <= oldLen * 1.08;
    if (!freeWin && !bigWin) continue;
    out = [...out.slice(0, i0), ...newSpan, ...out.slice(i1 + 1)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Placement search
// ---------------------------------------------------------------------------
type UnitPoint = [number, number];

export function place(unit: UnitPoint[], center: LatLng, scaleM: number, rotDeg: number): LatLng[] {
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
  /** Geometry-only likeness of the final continuous route to the source. */
  visualScore: number;
  /** Artifact/readability cleanliness from the final visual scorer. */
  visualCleanliness: number;
  /** Length economy from the final visual scorer; higher means less extra ink. */
  pathEconomy: number;
  /** 1 only when every target leg survived as connected street geometry. */
  coverage: number;
  /** Zero for production candidates; any positive value is a missing jump. */
  maxGapM: number;
};

/**
 * Normalized 0..1 (y down) contour → unit [-1,1] (y up) centered shape.
 */
export function toUnit(contour: NormalizedPoint[]): UnitPoint[] {
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

function toSimilarityPoints(path: LatLng[]): NormalizedPoint[] {
  if (!path.length) return [];
  const lat0 = path.reduce((sum, point) => sum + point[0], 0) / path.length;
  const lng0 = path.reduce((sum, point) => sum + point[1], 0) / path.length;
  const lngScale = mPerLng(lat0);
  return path.map(([lat, lng]) => ({
    x: (lng - lng0) * lngScale,
    y: -(lat - lat0) * M_PER_LAT,
  }));
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
    /** Restrict the placement sweep, e.g. to the uniform-grid window for
     * letter/box-bearing designs that mangle on organic streets. */
    bounds?: { latMin?: number; latMax?: number; lngMin?: number; lngMax?: number };
    /** Runnability gate override (default 1). Lower values are for offline
     * diagnostics only because every dropped leg is a visible teleport. */
    minCoverage?: number;
    /** Placement center grid resolution in degrees. Default 0.006. */
    centerStepDeg?: number;
    /** How many coarse placements to fully route per scale band. */
    placementsPerScale?: number;
    /** Corridor-A* overrides for offline tuning; defaults 12 / 90 / 28. */
    lambda?: number;
    corridorM?: number;
    bendWeight?: number;
  } = {},
): Promise<StreetTraceCandidate[]> {
  const topK = Math.max(1, Math.min(4, options.topK ?? 3));
  const unit = toUnit(contour);
  if (unit.length < 4) return [];
  const g = await getStreetGraph();

  // Hero scale is what makes curves read (the circle proof spans Midtown).
  // scaleM is the shape's half-size: 1400 → ~2.8 km drawing.
  const scales = options.scales ?? [900, 1300, 1800, 2400, 3200, 4000];
  const rots = options.rots ?? [0, 15, -15, 29, -29, 45];
  const cands: {
    center: LatLng;
    scale: number;
    rot: number;
    score: number;
    relativeScore: number;
  }[] = [];
  const latMin = options.bounds?.latMin ?? 40.71;
  const latMax = options.bounds?.latMax ?? 40.792;
  const lngMin = options.bounds?.lngMin ?? -74.012;
  const lngMax = options.bounds?.lngMax ?? -73.938;
  const centerStepDeg = Math.max(0.003, options.centerStepDeg ?? 0.006);
  for (let lat = latMin; lat <= latMax; lat += centerStepDeg) {
    for (let lng = lngMin; lng <= lngMax; lng += centerStepDeg) {
      for (const scale of scales) {
        for (const rot of rots) {
          const outline = place(unit, [lat, lng], scale, rot);
          const { score, miss } = coarseScore(g, outline);
          // miss counts outline samples with no street within 130 m — i.e.
          // rivers, parks, off-island. 8-of-72 allowed shapes to hang a full
          // lobe over the water and still win ("floating above Manhattan,
          // half in the river"). At most 2 stray samples now.
          if (miss <= 2) {
            cands.push({
              center: [lat, lng],
              scale,
              rot,
              score,
              relativeScore: score / scale,
            });
          }
        }
      }
    }
  }
  // Compare map fit relative to artwork scale so a longer route is not
  // demoted merely because its street error is measured in more meters.
  cands.sort(
    (a, b) => a.relativeScore - b.relativeScore || a.score - b.score,
  );

  // Trace several genuinely different placements from every scale band.
  // A single global top-six list was almost always six small routes, even
  // when a larger interpretation preserved the silhouette much better.
  const picks: typeof cands = [];
  const perScale = Math.max(
    2,
    options.placementsPerScale ?? Math.ceil((topK * 12) / scales.length),
  );
  for (const scale of scales) {
    let selectedAtScale = 0;
    for (const candidate of cands) {
      if (candidate.scale !== scale) continue;
      if (
        picks.some(
          (picked) =>
            picked.scale === scale &&
            meters(picked.center, candidate.center) < 450 &&
            Math.abs(picked.rot - candidate.rot) < 12,
        )
      ) {
        continue;
      }
      picks.push(candidate);
      selectedAtScale++;
      if (selectedAtScale >= perScale) break;
    }
  }
  picks.sort(
    (a, b) => a.relativeScore - b.relativeScore || a.score - b.score,
  );

  const traced: StreetTraceCandidate[] = [];
  for (const pk of picks) {
    const target = place(unit, pk.center, pk.scale, pk.rot);
    const {
      chain,
      coverage,
      maxGapM,
      hasIntentionalRetrace,
    } = traceContour(g, target, {
      anchorM: options.anchorM ?? 200,
      lambda: options.lambda ?? 12,
      corridorM: options.corridorM ?? 90,
      bendWeight: options.bendWeight,
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
    // RUNNABILITY GATE: every dropped leg is a teleport. Production accepts
    // only fully connected traces; there is no visual-score exception.
    if (coverage < (options.minCoverage ?? 0.999999) || maxGapM > 0) continue;

    const intendedSimilarity = toSimilarityPoints(target);
    const routeVariants = [chain];
    if (options.trimSpikes !== false && !hasIntentionalRetrace) {
      routeVariants.push(trimNubs(chain));
      // Deliberateness variant: long intended edges re-routed as single
      // anchor-free street runs. Last in the list so the tie-tolerant
      // selection below prefers it when the shape holds. (STRAIGHTEN_OFF=1
      // is a measurement kill-switch for offline A/B runs.)
      if (typeof process === "undefined" || process.env?.STRAIGHTEN_OFF !== "1") {
        const straightened = straightenLongRuns(g, chain, target, options.lambda ?? 12);
        if (straightened !== chain) routeVariants.push(trimNubs(straightened));
      }
    }
    let selectedChain = routeVariants[0]!;
    let visual = scoreFinalRouteSimilarity(
      intendedSimilarity,
      toSimilarityPoints(selectedChain),
    );
    for (let i = 1; i < routeVariants.length; i++) {
      const variant = routeVariants[i]!;
      if (variant.length < 8) continue;
      const candidateVisual = scoreFinalRouteSimilarity(
        intendedSimilarity,
        toSimilarityPoints(variant),
      );
      // Cleanliness preference: nub spurs barely move the similarity
      // score, so a strict > let the raw nubby chain win every tie. The
      // trimmed variant now wins unless trimming meaningfully hurt the
      // shape.
      if (candidateVisual.score > visual.score - 1.5) {
        selectedChain = variant;
        visual = candidateVisual;
      }
    }

    let dev = 0;
    for (const p of selectedChain) {
      let m = Infinity;
      for (let j = 1; j < target.length; j++) {
        const dd = distToSeg(p, target[j - 1]!, target[j]!);
        if (dd < m) m = dd;
      }
      dev += m;
    }
    dev /= selectedChain.length;
    let km = 0;
    for (let j = 1; j < selectedChain.length; j++) {
      km += meters(selectedChain[j - 1]!, selectedChain[j]!);
    }
    km /= 1000;
    if (options.targetDistanceKm != null && Number.isFinite(options.targetDistanceKm)) {
      if (km > options.targetDistanceKm * 3.4) continue;
    }
    traced.push({
      chain: selectedChain,
      target,
      km: Number(km.toFixed(2)),
      meanDeviationM: Number(dev.toFixed(1)),
      center: pk.center,
      scaleM: pk.scale,
      rotDeg: pk.rot,
      visualScore: visual.score,
      visualCleanliness: visual.diagnostics.cleanliness,
      pathEconomy: visual.diagnostics.pathEconomy,
      coverage,
      maxGapM,
    });
  }
  traced.sort((a, b) => {
    const visualDelta = b.visualScore - a.visualScore;
    if (Math.abs(visualDelta) > 1) return visualDelta;
    const cleanlinessDelta = b.visualCleanliness - a.visualCleanliness;
    if (Math.abs(cleanlinessDelta) > 1) return cleanlinessDelta;
    const economyDelta = b.pathEconomy - a.pathEconomy;
    if (Math.abs(economyDelta) > 1) return economyDelta;
    const deviationDelta =
      a.meanDeviationM / a.scaleM - b.meanDeviationM / b.scaleM;
    if (Math.abs(deviationDelta) > 0.0005) return deviationDelta;
    return a.km - b.km;
  });
  return traced.slice(0, topK);
}



