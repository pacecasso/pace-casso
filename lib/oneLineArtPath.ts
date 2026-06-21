export type XY = [number, number];

export type OneLineOptions = {
  /** Treat first/last points within this distance as a closed loop. */
  closedLoopThreshold?: number;
  /** Drop immediately repeated points within this distance. */
  duplicateThreshold?: number;
};

const DEFAULT_CLOSED_LOOP_THRESHOLD = 1e-4;
const DEFAULT_DUPLICATE_THRESHOLD = 1e-8;

function dist(a: XY, b: XY): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function clonePoint(p: XY): XY {
  return [p[0], p[1]];
}

function collapseConsecutiveDupes(path: XY[], threshold: number): XY[] {
  const out: XY[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > threshold) out.push(clonePoint(p));
  }
  return out;
}

function isClosed(path: XY[], threshold: number): boolean {
  return path.length > 3 && dist(path[0]!, path[path.length - 1]!) <= threshold;
}

function openLoop(path: XY[], threshold: number): XY[] {
  if (!isClosed(path, threshold)) return path;
  return path.slice(0, -1);
}

function rotateLoop(path: XY[], index: number): XY[] {
  if (!path.length) return [];
  const start = Math.max(0, Math.min(path.length - 1, index));
  const out = path.slice(start).concat(path.slice(0, start));
  out.push(clonePoint(out[0]!));
  return out;
}

function leftmostPointIndex(path: XY[]): number {
  let best = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i]!;
    const b = path[best]!;
    if (p[0] < b[0] || (p[0] === b[0] && p[1] < b[1])) best = i;
  }
  return best;
}

function nearestPointIndex(path: XY[], target: XY): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = dist(path[i]!, target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

type Candidate = {
  index: number;
  path: XY[];
  distance: number;
};

function orientPathForConnection(
  path: XY[],
  current: XY | null,
  closedLoopThreshold: number,
): Candidate["path"] {
  const open = openLoop(path, closedLoopThreshold);
  if (open.length < 2) return path;

  if (isClosed(path, closedLoopThreshold)) {
    const idx = current ? nearestPointIndex(open, current) : leftmostPointIndex(open);
    return rotateLoop(open, idx);
  }

  if (!current) {
    const start = path[0]!;
    const end = path[path.length - 1]!;
    return end[0] < start[0] || (end[0] === start[0] && end[1] < start[1])
      ? [...path].reverse()
      : path;
  }

  const startD = dist(current, path[0]!);
  const endD = dist(current, path[path.length - 1]!);
  return endD < startD ? [...path].reverse() : path;
}

function candidateDistance(path: XY[], current: XY | null): number {
  if (!current) {
    const p = path[0]!;
    return p[0] * 10_000 + p[1];
  }
  return dist(current, path[0]!);
}

/**
 * Turn several independent artwork strokes into one drawable path.
 *
 * Disconnected artwork still needs connectors for a watch/GPS route. This
 * helper keeps those connectors short by ordering strokes with a nearest-end
 * heuristic and by rotating closed loops so the bridge lands at the best spot.
 */
export function joinPolylinesAsOneLine(
  paths: XY[][],
  options: OneLineOptions = {},
): XY[] {
  const closedLoopThreshold =
    options.closedLoopThreshold ?? DEFAULT_CLOSED_LOOP_THRESHOLD;
  const duplicateThreshold =
    options.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD;

  const remaining = paths
    .map((p) => collapseConsecutiveDupes(p, duplicateThreshold))
    .filter((p) => p.length >= 2);
  const out: XY[] = [];
  let current: XY | null = null;

  while (remaining.length) {
    let best: Candidate | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const oriented = orientPathForConnection(
        remaining[i]!,
        current,
        closedLoopThreshold,
      );
      const d = candidateDistance(oriented, current);
      if (!best || d < best.distance) {
        best = { index: i, path: oriented, distance: d };
      }
    }
    if (!best) break;
    remaining.splice(best.index, 1);

    for (const p of best.path) {
      const last = out[out.length - 1];
      if (!last || dist(last, p) > duplicateThreshold) out.push(clonePoint(p));
    }
    current = out[out.length - 1] ?? null;
  }

  return out;
}
