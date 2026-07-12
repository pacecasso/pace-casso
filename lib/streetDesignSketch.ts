import { analyzeOneLinePath } from "./oneLinePathAnalysis";

export type StreetDesignPoint = { x: number; y: number };

export type StreetDesignReview = {
  pass: boolean;
  score: number;
  reasons: string[];
  metrics: {
    pointCount: number;
    width: number;
    height: number;
    totalLength: number;
    tinySegmentRatio: number;
    connectorCount: number;
    selfIntersections: number;
    gridCellsTouched: number;
  };
};

function isValidPoint(p: StreetDesignPoint | undefined): p is StreetDesignPoint {
  return (
    p != null &&
    Number.isFinite(p.x) &&
    p.x >= 0 &&
    p.x <= 1 &&
    Number.isFinite(p.y) &&
    p.y >= 0 &&
    p.y <= 1
  );
}

function segmentLength(a: StreetDesignPoint, b: StreetDesignPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function orientation(
  a: StreetDesignPoint,
  b: StreetDesignPoint,
  c: StreetDesignPoint,
): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function onSegment(
  a: StreetDesignPoint,
  b: StreetDesignPoint,
  c: StreetDesignPoint,
): boolean {
  return (
    Math.min(a.x, c.x) - 1e-9 <= b.x &&
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    Math.min(a.y, c.y) - 1e-9 <= b.y &&
    b.y <= Math.max(a.y, c.y) + 1e-9
  );
}

function segmentsIntersect(
  a: StreetDesignPoint,
  b: StreetDesignPoint,
  c: StreetDesignPoint,
  d: StreetDesignPoint,
): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (Math.abs(o1) < 1e-9 && onSegment(a, c, b)) return true;
  if (Math.abs(o2) < 1e-9 && onSegment(a, d, b)) return true;
  if (Math.abs(o3) < 1e-9 && onSegment(c, a, d)) return true;
  if (Math.abs(o4) < 1e-9 && onSegment(c, b, d)) return true;
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function selfIntersectionCount(points: StreetDesignPoint[]): number {
  let count = 0;
  const lastSegment = points.length - 2;
  const closed =
    points.length > 3 &&
    segmentLength(points[0]!, points[points.length - 1]!) <= 0.025;

  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1; j < points.length - 1; j++) {
      if (Math.abs(i - j) <= 1) continue;
      if (closed && i === 0 && j === lastSegment) continue;
      if (segmentsIntersect(points[i]!, points[i + 1]!, points[j]!, points[j + 1]!)) {
        count++;
      }
    }
  }
  return count;
}

function gridCoverage(points: StreetDesignPoint[], cellsPerSide = 4): number {
  const seen = new Set<string>();
  for (const p of points) {
    if (!isValidPoint(p)) continue;
    const x = Math.max(0, Math.min(cellsPerSide - 1, Math.floor(p.x * cellsPerSide)));
    const y = Math.max(0, Math.min(cellsPerSide - 1, Math.floor(p.y * cellsPerSide)));
    seen.add(`${x}:${y}`);
  }
  return seen.size;
}

export function reviewStreetDesignSketch(
  points: StreetDesignPoint[] | null | undefined,
): StreetDesignReview {
  const valid = (points ?? []).filter(isValidPoint);
  const reasons: string[] = [];

  if (valid.length < 2) {
    return {
      pass: false,
      score: 0,
      reasons: ["not enough valid points"],
      metrics: {
        pointCount: valid.length,
        width: 0,
        height: 0,
        totalLength: 0,
        tinySegmentRatio: 0,
        connectorCount: 0,
        selfIntersections: 0,
        gridCellsTouched: 0,
      },
    };
  }

  const xs = valid.map((p) => p.x);
  const ys = valid.map((p) => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  let totalLength = 0;
  let tinyLength = 0;
  for (let i = 1; i < valid.length; i++) {
    const len = segmentLength(valid[i - 1]!, valid[i]!);
    totalLength += len;
    if (len < 0.025) tinyLength += len;
  }
  const tinySegmentRatio = totalLength > 0 ? tinyLength / totalLength : 1;
  const analysis = analyzeOneLinePath(valid, {
    minConnectorLength: 0.24,
    medianMultiplier: 8,
  });
  const selfIntersections = selfIntersectionCount(valid);
  const gridCellsTouched = gridCoverage(valid);

  let score = 100;

  if (valid.length < 5) {
    score -= 28;
    reasons.push("too few strokes to read as a subject");
  }
  if (valid.length > 42) {
    score -= Math.min(35, (valid.length - 42) * 1.8);
    reasons.push("too many points for street-scale art");
  }
  if (width < 0.18 || height < 0.18) {
    score -= 35;
    reasons.push("draft collapses into a small area");
  }
  if (gridCellsTouched < 4) {
    score -= 22;
    reasons.push("not enough visual spread");
  }
  if (tinySegmentRatio > 0.28) {
    score -= Math.min(28, tinySegmentRatio * 70);
    reasons.push("too much tiny detail for city blocks");
  }
  if (analysis.connectorCount > 4) {
    score -= Math.min(24, (analysis.connectorCount - 4) * 6);
    reasons.push("too many long connector jumps");
  }
  if (selfIntersections > 2) {
    score -= Math.min(32, (selfIntersections - 2) * 7);
    reasons.push("line crosses itself too often");
  }
  if (totalLength < 0.65) {
    score -= 18;
    reasons.push("line is too short to carry the image");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const pass =
    score >= 48 &&
    width >= 0.16 &&
    height >= 0.16 &&
    valid.length >= 4 &&
    selfIntersections <= Math.max(5, Math.floor(valid.length / 4));

  return {
    pass,
    score,
    reasons,
    metrics: {
      pointCount: valid.length,
      width,
      height,
      totalLength,
      tinySegmentRatio,
      connectorCount: analysis.connectorCount,
      selfIntersections,
      gridCellsTouched,
    },
  };
}
