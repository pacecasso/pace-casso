import { simplifyCartesian } from "./douglasPeucker";
import { analyzeOneLinePath } from "./oneLinePathAnalysis";

export type NormalizedPathPoint = { x: number; y: number };

export type ArtPathInterpretation = {
  id: "trace" | "bold" | "grid" | "iconic-heart" | "ai-sketch";
  label: string;
  description: string;
  points: NormalizedPathPoint[];
};

type BBox = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
};

const CLOSE_THRESHOLD = 0.035;

function isValidPoint(p: NormalizedPathPoint | undefined): p is NormalizedPathPoint {
  return (
    !!p &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= -0.05 &&
    p.x <= 1.05 &&
    p.y >= -0.05 &&
    p.y <= 1.05
  );
}

function dist(a: NormalizedPathPoint, b: NormalizedPathPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function cleanPath(points: NormalizedPathPoint[]): NormalizedPathPoint[] {
  const out: NormalizedPathPoint[] = [];
  for (const p of points) {
    if (!isValidPoint(p)) continue;
    const next = { x: clamp01(p.x), y: clamp01(p.y) };
    const last = out[out.length - 1];
    if (!last || dist(last, next) > 0.001) out.push(next);
  }
  return out;
}

function pathIsClosed(points: NormalizedPathPoint[]): boolean {
  return points.length >= 4 && dist(points[0]!, points[points.length - 1]!) <= CLOSE_THRESHOLD;
}

function closeIfNeeded(
  points: NormalizedPathPoint[],
  closed: boolean,
): NormalizedPathPoint[] {
  if (!closed || points.length < 2) return points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return dist(first, last) <= 0.001 ? points : [...points, { ...first }];
}

function bboxOf(points: NormalizedPathPoint[]): BBox | null {
  if (!points.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return null;
  return { minX, maxX, minY, maxY, width, height };
}

function hasLargeConnectorJump(points: NormalizedPathPoint[], diag: number): boolean {
  if (points.length < 3) return false;
  const lengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    lengths.push(dist(points[i - 1]!, points[i]!));
  }
  const sorted = [...lengths].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const threshold = Math.max(diag * 0.24, median * 2.2, 0.18);
  return lengths.some((len) => len >= threshold);
}

function simplifyPath(
  points: NormalizedPathPoint[],
  tolerance: number,
  maxPoints: number,
): NormalizedPathPoint[] {
  if (points.length <= 2) return points;
  const closed = pathIsClosed(points);
  const work = closed ? points.slice(0, -1) : points;
  const simplified = simplifyCartesian(
    work.map((p) => [p.x, p.y]),
    tolerance,
  ).map(([x, y]) => ({ x: clamp01(x), y: clamp01(y) }));

  let out = simplified;
  if (out.length > maxPoints) {
    const stride = Math.ceil(out.length / maxPoints);
    out = out.filter((_, i) => i === 0 || i === out.length - 1 || i % stride === 0);
  }
  return closeIfNeeded(out.length >= 2 ? out : work, closed);
}

function snapPathToLocalGrid(
  points: NormalizedPathPoint[],
  divisions: number,
): NormalizedPathPoint[] {
  const box = bboxOf(points);
  if (!box) return points;
  const closed = pathIsClosed(points);
  const work = closed ? points.slice(0, -1) : points;
  const snapped: NormalizedPathPoint[] = [];
  for (const p of work) {
    const gx =
      box.minX +
      (Math.round(((p.x - box.minX) / box.width) * divisions) / divisions) *
        box.width;
    const gy =
      box.minY +
      (Math.round(((p.y - box.minY) / box.height) * divisions) / divisions) *
        box.height;
    const next = { x: clamp01(gx), y: clamp01(gy) };
    const last = snapped[snapped.length - 1];
    if (!last || dist(last, next) > 0.012) snapped.push(next);
  }
  return closeIfNeeded(snapped.length >= 2 ? snapped : points, closed);
}

function radialBoldSilhouette(points: NormalizedPathPoint[]): NormalizedPathPoint[] {
  const box = bboxOf(points);
  if (!box) return points;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const buckets = 18;
  const chosen: (NormalizedPathPoint | null)[] = Array.from({ length: buckets }, () => null);
  const chosenR = Array.from({ length: buckets }, () => -Infinity);

  for (const p of points) {
    const angle = Math.atan2(p.y - cy, p.x - cx);
    const idx = Math.max(
      0,
      Math.min(
        buckets - 1,
        Math.floor(((angle + Math.PI) / (Math.PI * 2)) * buckets),
      ),
    );
    const r = Math.hypot((p.x - cx) / box.width, (p.y - cy) / box.height);
    if (r > chosenR[idx]) {
      chosenR[idx] = r;
      chosen[idx] = p;
    }
  }

  const out = chosen.filter((p): p is NormalizedPathPoint => !!p);
  if (out.length < 5) return points;

  let bottomIdx = 0;
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.y > out[bottomIdx]!.y) bottomIdx = i;
  }
  const rotated = out.slice(bottomIdx).concat(out.slice(0, bottomIdx));
  rotated.push({ ...rotated[0]! });
  return simplifyPath(rotated, Math.max(box.width, box.height) * 0.025, 22);
}

export function heartConfidence(points: NormalizedPathPoint[]): number {
  if (!pathIsClosed(points)) return 0;
  const box = bboxOf(points);
  if (!box || box.width < 0.08 || box.height < 0.08) return 0;
  const midX = (box.minX + box.maxX) / 2;
  const topLimit = box.minY + box.height * 0.56;
  const leftTop = points
    .filter((p) => p.x < midX - box.width * 0.08 && p.y < topLimit)
    .reduce((best, p) => Math.min(best, p.y), Infinity);
  const rightTop = points
    .filter((p) => p.x > midX + box.width * 0.08 && p.y < topLimit)
    .reduce((best, p) => Math.min(best, p.y), Infinity);
  const centerCleft = points
    .filter((p) => Math.abs(p.x - midX) < box.width * 0.2 && p.y < topLimit)
    .reduce((best, p) => Math.max(best, p.y), -Infinity);
  const bottom = points.reduce((best, p) => (p.y > best.y ? p : best), points[0]!);

  if (!Number.isFinite(leftTop) || !Number.isFinite(rightTop) || !Number.isFinite(centerCleft)) {
    return 0;
  }

  let score = 0;
  const topAvg = (leftTop + rightTop) / 2;
  if (centerCleft - topAvg > box.height * 0.045) score += 0.42;
  if (Math.abs(bottom.x - midX) < box.width * 0.26) score += 0.24;
  if (bottom.y > box.minY + box.height * 0.78) score += 0.2;
  const aspect = box.width / box.height;
  if (aspect > 0.65 && aspect < 1.45) score += 0.14;
  return score;
}

function iconicHeart(points: NormalizedPathPoint[]): NormalizedPathPoint[] | null {
  if (heartConfidence(points) < 0.68) return null;
  const box = bboxOf(points);
  if (!box) return null;
  const p = (x: number, y: number): NormalizedPathPoint => ({
    x: clamp01(box.minX + x * box.width),
    y: clamp01(box.minY + y * box.height),
  });
  return [
    p(0.5, 0.9),
    p(0.2, 0.62),
    p(0.1, 0.36),
    p(0.22, 0.16),
    p(0.39, 0.2),
    p(0.5, 0.35),
    p(0.61, 0.2),
    p(0.78, 0.16),
    p(0.9, 0.36),
    p(0.8, 0.62),
    p(0.5, 0.9),
  ];
}

function samePath(a: NormalizedPathPoint[], b: NormalizedPathPoint[]): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const n = Math.min(a.length, b.length);
  if (n < 2) return false;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += dist(a[i]!, b[i]!);
  return sum / n < 0.01;
}

function pushUnique(
  out: ArtPathInterpretation[],
  next: ArtPathInterpretation,
): void {
  if (next.points.length < 2) return;
  if (out.some((v) => samePath(v.points, next.points))) return;
  out.push(next);
}

export function buildArtPathInterpretations(
  source: NormalizedPathPoint[] | null | undefined,
): ArtPathInterpretation[] {
  const trace = cleanPath(source ?? []);
  if (trace.length < 2) return [];
  const box = bboxOf(trace);
  const diag = box ? Math.hypot(box.width, box.height) : 1;

  const out: ArtPathInterpretation[] = [
    {
      id: "trace",
      label: "Trace",
      description: "Closest to the edited line art.",
      points: trace,
    },
  ];

  pushUnique(out, {
    id: "bold",
    label: "Bold sketch",
    description: "Drops fine detail and keeps broad readable gestures.",
    points: simplifyPath(trace, diag * 0.022, 34),
  });

  const analysis = analyzeOneLinePath(trace);
  const likelyConnector = analysis.connectorCount > 0 || hasLargeConnectorJump(trace, diag);
  if (pathIsClosed(trace) || !likelyConnector) {
    const gridBase = pathIsClosed(trace)
      ? radialBoldSilhouette(trace)
      : simplifyPath(trace, diag * 0.03, 28);
    pushUnique(out, {
      id: "grid",
      label: "Grid sketch",
      description: "A street-grid interpretation with fewer, stronger bends.",
      points: simplifyPath(snapPathToLocalGrid(gridBase, 8), diag * 0.012, 30),
    });
  }

  const heart = iconicHeart(trace);
  if (heart) {
    pushUnique(out, {
      id: "iconic-heart",
      label: "Iconic heart",
      description: "Draws the idea as a simple GPS-art heart, not a literal trace.",
      points: heart,
    });
  }

  return out;
}
