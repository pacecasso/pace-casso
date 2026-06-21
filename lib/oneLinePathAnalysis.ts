export type NormalizedPathPoint = { x: number; y: number };

export type OneLinePathAnalysis = {
  connectorSegmentIndices: number[];
  connectorCount: number;
  longestConnectorRatio: number;
  isClosed: boolean;
};

type Options = {
  minConnectorLength?: number;
  medianMultiplier?: number;
  closedThreshold?: number;
};

const DEFAULT_MIN_CONNECTOR_LENGTH = 0.12;
const DEFAULT_MEDIAN_MULTIPLIER = 6;
const DEFAULT_CLOSED_THRESHOLD = 0.025;

function isValidNormalizedPoint(p: NormalizedPathPoint | undefined): boolean {
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

function segmentLength(
  a: NormalizedPathPoint,
  b: NormalizedPathPoint,
): number | null {
  if (!isValidNormalizedPoint(a) || !isValidNormalizedPoint(b)) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return Number.isFinite(len) ? len : null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function analyzeOneLinePath(
  points: NormalizedPathPoint[] | null | undefined,
  options: Options = {},
): OneLinePathAnalysis {
  if (!points || points.length < 2) {
    return {
      connectorSegmentIndices: [],
      connectorCount: 0,
      longestConnectorRatio: 0,
      isClosed: false,
    };
  }

  const minConnectorLength =
    options.minConnectorLength ?? DEFAULT_MIN_CONNECTOR_LENGTH;
  const medianMultiplier =
    options.medianMultiplier ?? DEFAULT_MEDIAN_MULTIPLIER;
  const closedThreshold = options.closedThreshold ?? DEFAULT_CLOSED_THRESHOLD;

  const lengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const len = segmentLength(points[i - 1]!, points[i]!);
    if (len != null && len > 1e-8) lengths.push(len);
  }

  const mid = median(lengths);
  const threshold = Math.max(minConnectorLength, mid * medianMultiplier);
  const connectorSegmentIndices: number[] = [];
  let longest = 0;

  for (let i = 1; i < points.length; i++) {
    const len = segmentLength(points[i - 1]!, points[i]!);
    if (len != null && len >= threshold) {
      connectorSegmentIndices.push(i - 1);
      if (len > longest) longest = len;
    }
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const isClosed =
    points.length > 3 &&
    isValidNormalizedPoint(first) &&
    isValidNormalizedPoint(last) &&
    (segmentLength(first, last) ?? Infinity) <= closedThreshold;

  return {
    connectorSegmentIndices,
    connectorCount: connectorSegmentIndices.length,
    longestConnectorRatio: mid > 0 ? longest / mid : 0,
    isClosed,
  };
}

export function connectorSegmentPairs<T>(
  points: T[],
  connectorSegmentIndices: number[],
): [T, T][] {
  const pairs: [T, T][] = [];
  for (const idx of connectorSegmentIndices) {
    const a = points[idx];
    const b = points[idx + 1];
    if (a === undefined || b === undefined) continue;
    pairs.push([a, b]);
  }
  return pairs;
}
