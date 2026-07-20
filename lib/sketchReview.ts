import { analyzeOneLinePath } from "./oneLinePathAnalysis";

export type NormalizedSketchPoint = { x: number; y: number };

export type SketchReviewOption = {
  id: string;
  label: string;
  points: NormalizedSketchPoint[];
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function pointDistance(a: NormalizedSketchPoint, b: NormalizedSketchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function cleanSketchPoints(
  points: NormalizedSketchPoint[],
  minDistance = 0.006,
): NormalizedSketchPoint[] {
  const out: NormalizedSketchPoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const next = { x: clamp01(p.x), y: clamp01(p.y) };
    const prev = out[out.length - 1];
    if (prev && pointDistance(prev, next) < minDistance) continue;
    out.push(next);
  }
  return out;
}

function perpendicularDistance(
  p: NormalizedSketchPoint,
  a: NormalizedSketchPoint,
  b: NormalizedSketchPoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = Math.hypot(dx, dy);
  if (denom <= 0) return pointDistance(p, a);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / denom;
}

export function simplifySketchPath(
  points: NormalizedSketchPoint[],
  tolerance: number,
): NormalizedSketchPoint[] {
  const clean = cleanSketchPoints(points);
  if (clean.length <= 2) return clean;

  let farthestIndex = -1;
  let farthestDistance = -1;
  const first = clean[0]!;
  const last = clean[clean.length - 1]!;
  for (let i = 1; i < clean.length - 1; i++) {
    const d = perpendicularDistance(clean[i]!, first, last);
    if (d > farthestDistance) {
      farthestDistance = d;
      farthestIndex = i;
    }
  }

  if (farthestDistance <= tolerance || farthestIndex < 0) {
    return [first, last];
  }

  const left = simplifySketchPath(clean.slice(0, farthestIndex + 1), tolerance);
  const right = simplifySketchPath(clean.slice(farthestIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

export function smoothSketchPath(
  points: NormalizedSketchPoint[],
  passes = 1,
): NormalizedSketchPoint[] {
  let out = cleanSketchPoints(points);
  for (let pass = 0; pass < passes; pass++) {
    if (out.length <= 2) return out;
    out = out.map((p, i) => {
      if (i === 0 || i === out.length - 1) return p;
      const prev = out[i - 1]!;
      const next = out[i + 1]!;
      return {
        x: clamp01(prev.x * 0.25 + p.x * 0.5 + next.x * 0.25),
        y: clamp01(prev.y * 0.25 + p.y * 0.5 + next.y * 0.25),
      };
    });
  }
  return out;
}

export function simplifySketchToMaxPoints(
  points: NormalizedSketchPoint[],
  maxPoints: number,
): NormalizedSketchPoint[] {
  const clean = cleanSketchPoints(points);
  if (clean.length <= maxPoints) return clean;
  let tolerance = 0.004;
  let best = clean;
  for (let i = 0; i < 24; i++) {
    const next = simplifySketchPath(clean, tolerance);
    if (next.length >= 2) best = next;
    if (next.length <= maxPoints) return next;
    tolerance *= 1.35;
  }
  return best;
}

/** Split a traced path into its components at pen-jump connectors. */
export function splitSketchComponents(
  points: NormalizedSketchPoint[],
): NormalizedSketchPoint[][] {
  const { connectorSegmentIndices } = analyzeOneLinePath(points);
  if (!connectorSegmentIndices.length) return points.length ? [points] : [];
  const cuts = new Set(connectorSegmentIndices);
  const components: NormalizedSketchPoint[][] = [];
  let current: NormalizedSketchPoint[] = points.length ? [points[0]!] : [];
  for (let i = 1; i < points.length; i++) {
    if (cuts.has(i - 1)) {
      if (current.length >= 2) components.push(current);
      current = [];
    }
    current.push(points[i]!);
  }
  if (current.length >= 2) components.push(current);
  return components.length ? components : [points];
}

function componentPerimeter(points: NormalizedSketchPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += pointDistance(points[i - 1]!, points[i]!);
  }
  return total;
}

/**
 * Component-aware simplification: a logo lockup (symbol + letters) traces as
 * many separate pieces joined by pen-jump connectors. Running one global
 * point budget across all of them collapses ten recognizable shapes into
 * crisscross soup — a 30-point budget is right for one heart and fatal for
 * "swoosh + JUST DO IT". Split at the connectors, give each component a
 * share of the budget proportional to its ink (never fewer than 6 points),
 * simplify each piece by itself, and rejoin in the original order.
 */
export function simplifySketchPreservingComponents(
  points: NormalizedSketchPoint[],
  maxPoints: number,
): NormalizedSketchPoint[] {
  const components = splitSketchComponents(points);
  if (components.length <= 1) {
    return simplifySketchToMaxPoints(points, maxPoints);
  }
  const perims = components.map(componentPerimeter);
  const totalPerim = perims.reduce((s, v) => s + v, 0) || 1;
  const out: NormalizedSketchPoint[] = [];
  for (let i = 0; i < components.length; i++) {
    const share = Math.max(
      6,
      Math.round((perims[i]! / totalPerim) * maxPoints),
    );
    out.push(...simplifySketchToMaxPoints(components[i]!, share));
  }
  return out;
}

export function buildSketchReviewOptions(
  points: NormalizedSketchPoint[],
): SketchReviewOption[] {
  const clean = cleanSketchPoints(points);
  if (clean.length < 2) return [];

  // Multi-component art needs a budget that scales with how many separate
  // pieces the drawing has, or the variants destroy it (see
  // simplifySketchPreservingComponents).
  const componentCount = splitSketchComponents(clean).length;
  const scale = Math.max(1, componentCount);
  const readable = simplifySketchPreservingComponents(
    clean,
    Math.min(300, Math.max(72, scale * 34)),
  );
  const routeSketch = simplifySketchPreservingComponents(
    smoothSketchPath(clean, 1),
    Math.min(160, Math.max(42, scale * 15)),
  );
  const bigTurns = simplifySketchPreservingComponents(
    smoothSketchPath(clean, 2),
    Math.min(110, Math.max(26, scale * 10)),
  );
  const minimal = simplifySketchPreservingComponents(
    smoothSketchPath(clean, 2),
    Math.min(80, Math.max(16, scale * 7)),
  );

  return [
    { id: "readable", label: "Readable", points: readable },
    { id: "route-sketch", label: "Route sketch", points: routeSketch },
    { id: "big-turns", label: "Big turns", points: bigTurns },
    { id: "minimal", label: "Minimal", points: minimal },
  ].filter((option) => option.points.length >= 2);
}

export function moveSketchPoint(
  points: NormalizedSketchPoint[],
  index: number,
  point: NormalizedSketchPoint,
): NormalizedSketchPoint[] {
  if (index < 0 || index >= points.length) return points;
  return points.map((p, i) =>
    i === index ? { x: clamp01(point.x), y: clamp01(point.y) } : p,
  );
}

export function insertSketchPoint(
  points: NormalizedSketchPoint[],
  selectedIndex: number | null,
): { points: NormalizedSketchPoint[]; selectedIndex: number } {
  const clean = cleanSketchPoints(points, 0);
  if (clean.length < 2) {
    const next = [...clean, { x: 0.5, y: 0.5 }];
    return { points: next, selectedIndex: next.length - 1 };
  }

  let insertAfter = selectedIndex ?? -1;
  if (insertAfter < 0 || insertAfter >= clean.length - 1) {
    let longest = -1;
    insertAfter = 0;
    for (let i = 0; i < clean.length - 1; i++) {
      const d = pointDistance(clean[i]!, clean[i + 1]!);
      if (d > longest) {
        longest = d;
        insertAfter = i;
      }
    }
  }

  const a = clean[insertAfter]!;
  const b = clean[Math.min(clean.length - 1, insertAfter + 1)]!;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const next = [
    ...clean.slice(0, insertAfter + 1),
    mid,
    ...clean.slice(insertAfter + 1),
  ];
  return { points: next, selectedIndex: insertAfter + 1 };
}

export function deleteSketchPoint(
  points: NormalizedSketchPoint[],
  selectedIndex: number | null,
): { points: NormalizedSketchPoint[]; selectedIndex: number | null } {
  if (selectedIndex == null || points.length <= 2) {
    return { points, selectedIndex };
  }
  if (selectedIndex < 0 || selectedIndex >= points.length) {
    return { points, selectedIndex: null };
  }
  const next = points.filter((_, i) => i !== selectedIndex);
  return {
    points: next,
    selectedIndex: next.length === 0 ? null : Math.min(selectedIndex, next.length - 1),
  };
}
