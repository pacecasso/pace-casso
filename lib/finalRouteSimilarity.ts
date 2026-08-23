export type FinalRoutePoint = { x: number; y: number };

export type FinalRouteSimilarityDiagnostics = {
  lineCoverage: number;
  chamfer: number;
  orderedLandmarks: number;
  curvatureSequence: number;
  topology: number;
  cleanliness: number;
  closedness: number;
  intendedCoverage: number;
  actualPrecision: number;
  normalizedChamfer: number;
  longestStrayRun: number;
  pathEconomy: number;
  intendedSelfIntersections: number;
  actualSelfIntersections: number;
};

export type FinalRouteSimilarityResult = {
  score: number;
  diagnostics: FinalRouteSimilarityDiagnostics;
};

type PreparedPath = {
  points: FinalRoutePoint[];
  closed: boolean;
};

const EPSILON = 1e-9;
const LINE_SAMPLE_COUNT = 320;
const ORDER_SAMPLE_COUNT = 96;
const TOPOLOGY_SAMPLE_COUNT = 128;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundedScore(value: number): number {
  return Number((100 * clamp01(value)).toFixed(1));
}

function distance(a: FinalRoutePoint, b: FinalRoutePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function finitePoint(point: FinalRoutePoint | undefined): point is FinalRoutePoint {
  return point != null && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function sanitize(points: readonly FinalRoutePoint[]): FinalRoutePoint[] {
  const clean: FinalRoutePoint[] = [];
  for (const point of points) {
    if (!finitePoint(point)) continue;
    const previous = clean[clean.length - 1];
    if (!previous || distance(previous, point) > EPSILON) {
      clean.push({ x: point.x, y: point.y });
    }
  }
  return clean;
}

function prepare(points: readonly FinalRoutePoint[]): PreparedPath | null {
  const clean = sanitize(points);
  if (clean.length < 2) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of clean) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const span = Math.max(maxX - minX, maxY - minY);
  if (!Number.isFinite(span) || span <= EPSILON) return null;

  const endpointGap = distance(clean[0]!, clean[clean.length - 1]!);
  const closed = clean.length >= 4 && endpointGap <= span * 0.035;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const normalized = clean.map((point) => ({
    x: (point.x - centerX) / span,
    y: (point.y - centerY) / span,
  }));

  if (closed) {
    if (distance(normalized[0]!, normalized[normalized.length - 1]!) <= EPSILON) {
      normalized.pop();
    }
    let canonicalStart = 0;
    for (let index = 1; index < normalized.length; index++) {
      const candidate = normalized[index]!;
      const current = normalized[canonicalStart]!;
      if (
        candidate.x < current.x - EPSILON ||
        (Math.abs(candidate.x - current.x) <= EPSILON && candidate.y < current.y)
      ) {
        canonicalStart = index;
      }
    }
    const canonical = [
      ...normalized.slice(canonicalStart),
      ...normalized.slice(0, canonicalStart),
    ];
    canonical.push({ ...canonical[0]! });
    return { points: canonical, closed };
  }

  return { points: normalized, closed };
}


function resample(path: PreparedPath, count: number): FinalRoutePoint[] {
  const points = path.points;
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative[index - 1]! + distance(points[index - 1]!, points[index]!));
  }
  const total = cumulative[cumulative.length - 1]!;
  if (total <= EPSILON) return Array.from({ length: count }, () => ({ ...points[0]! }));

  const output: FinalRoutePoint[] = [];
  let segment = 1;
  for (let index = 0; index < count; index++) {
    const fraction = path.closed ? index / count : index / Math.max(1, count - 1);
    const target = total * fraction;
    while (segment < cumulative.length - 1 && cumulative[segment]! < target) segment++;
    const from = points[segment - 1]!;
    const to = points[segment]!;
    const start = cumulative[segment - 1]!;
    const segmentLength = Math.max(EPSILON, cumulative[segment]! - start);
    const local = clamp01((target - start) / segmentLength);
    output.push({
      x: from.x + (to.x - from.x) * local,
      y: from.y + (to.y - from.y) * local,
    });
  }
  return output;
}

function pointToSegmentDistance(
  point: FinalRoutePoint,
  from: FinalRoutePoint,
  to: FinalRoutePoint,
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const denominator = dx * dx + dy * dy;
  if (denominator <= EPSILON) return distance(point, from);
  const t = clamp01(((point.x - from.x) * dx + (point.y - from.y) * dy) / denominator);
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}

function distancesToPath(
  samples: readonly FinalRoutePoint[],
  target: PreparedPath,
): number[] {
  return samples.map((sample) => {
    let nearest = Infinity;
    for (let index = 1; index < target.points.length; index++) {
      nearest = Math.min(
        nearest,
        pointToSegmentDistance(sample, target.points[index - 1]!, target.points[index]!),
      );
    }
    return nearest;
  });
}

function fractionWithin(distances: readonly number[], tolerance: number): number {
  if (!distances.length) return 0;
  let covered = 0;
  for (const value of distances) if (value <= tolerance) covered++;
  return covered / distances.length;
}

function harmonicMean(a: number, b: number): number {
  return a + b <= EPSILON ? 0 : (2 * a * b) / (a + b);
}

function mean(values: readonly number[]): number {
  if (!values.length) return Infinity;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pathLength(points: readonly FinalRoutePoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += distance(points[index - 1]!, points[index]!);
  }
  return total;
}

function turnAngle(
  previous: FinalRoutePoint,
  current: FinalRoutePoint,
  next: FinalRoutePoint,
): number {
  const ax = current.x - previous.x;
  const ay = current.y - previous.y;
  const bx = next.x - current.x;
  const by = next.y - current.y;
  if (Math.hypot(ax, ay) <= EPSILON || Math.hypot(bx, by) <= EPSILON) return 0;
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

function curvatureSequence(samples: readonly FinalRoutePoint[], closed: boolean): number[] {
  const count = samples.length;
  const gap = 2;
  return samples.map((current, index) => {
    if (!closed && (index < gap || index >= count - gap)) return 0;
    const previous = samples[(index - gap + count) % count]!;
    const next = samples[(index + gap) % count]!;
    return turnAngle(previous, current, next);
  });
}

function reverseSamples(samples: readonly FinalRoutePoint[]): FinalRoutePoint[] {
  return [...samples].reverse();
}


function angleDifference(a: number, b: number): number {
  let difference = Math.abs(a - b) % (Math.PI * 2);
  if (difference > Math.PI) difference = Math.PI * 2 - difference;
  return difference;
}

function orderedComparison(
  intended: PreparedPath,
  actual: PreparedPath,
): { ordered: number; curvature: number } {
  const intendedSamples = resample(intended, ORDER_SAMPLE_COUNT);
  const intendedCurvature = curvatureSequence(intendedSamples, intended.closed);
  const closedAlignment = intended.closed && actual.closed;
  const phaseResolution = closedAlignment ? 4 : 1;
  const orientations = [resample(actual, ORDER_SAMPLE_COUNT * phaseResolution)];
  orientations.push(reverseSamples(orientations[0]!));

  let bestCost = Infinity;
  let bestPoints = orientations[0]!;
  let bestCurvature = curvatureSequence(bestPoints, actual.closed);

  for (const orientation of orientations) {
    const offsets = closedAlignment
      ? Array.from({ length: orientation.length }, (_, index) => index)
      : [0];
    for (const offset of offsets) {
      const candidate = closedAlignment
        ? Array.from(
            { length: ORDER_SAMPLE_COUNT },
            (_, index) => orientation[(offset + index * phaseResolution) % orientation.length]!,
          )
        : orientation;
      const candidateCurvature = curvatureSequence(candidate, actual.closed);
      let pointCost = 0;
      let turnCost = 0;
      for (let index = 0; index < ORDER_SAMPLE_COUNT; index++) {
        pointCost += distance(intendedSamples[index]!, candidate[index]!);
        turnCost += angleDifference(intendedCurvature[index]!, candidateCurvature[index]!);
      }
      const cost = pointCost / ORDER_SAMPLE_COUNT + (turnCost / ORDER_SAMPLE_COUNT) * 0.025;
      if (cost < bestCost) {
        bestCost = cost;
        bestPoints = candidate;
        bestCurvature = candidateCurvature;
      }
    }
  }

  let pointError = 0;
  let weightedTurnSimilarity = 0;
  let turnWeight = 0;
  for (let index = 0; index < ORDER_SAMPLE_COUNT; index++) {
    pointError += distance(intendedSamples[index]!, bestPoints[index]!);
    const saliency = 0.25 + Math.min(1.5, Math.abs(intendedCurvature[index]!) * 1.8);
    weightedTurnSimilarity +=
      saliency * Math.exp(-angleDifference(intendedCurvature[index]!, bestCurvature[index]!) / 0.7);
    turnWeight += saliency;
  }
  pointError /= ORDER_SAMPLE_COUNT;
  const pointScore = Math.exp(-pointError / 0.115);
  const curvatureScore = turnWeight > 0 ? weightedTurnSimilarity / turnWeight : 0;
  return {
    ordered: 0.65 * pointScore + 0.35 * curvatureScore,
    curvature: curvatureScore,
  };
}

function orientation(a: FinalRoutePoint, b: FinalRoutePoint, c: FinalRoutePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function properIntersection(
  a: FinalRoutePoint,
  b: FinalRoutePoint,
  c: FinalRoutePoint,
  d: FinalRoutePoint,
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  const tolerance = 1e-7;
  return (
    Math.abs(abC) > tolerance &&
    Math.abs(abD) > tolerance &&
    Math.abs(cdA) > tolerance &&
    Math.abs(cdB) > tolerance &&
    Math.sign(abC) !== Math.sign(abD) &&
    Math.sign(cdA) !== Math.sign(cdB)
  );
}

function selfIntersectionCount(path: PreparedPath): number {
  const sampled = resample(path, TOPOLOGY_SAMPLE_COUNT);
  const points = path.closed ? [...sampled, sampled[0]!] : sampled;
  const segmentCount = points.length - 1;
  let intersections = 0;
  for (let first = 0; first < segmentCount; first++) {
    for (let second = first + 2; second < segmentCount; second++) {
      if (path.closed && first === 0 && second === segmentCount - 1) continue;
      if (
        properIntersection(
          points[first]!,
          points[first + 1]!,
          points[second]!,
          points[second + 1]!,
        )
      ) {
        intersections++;
      }
    }
  }
  return intersections;
}

function longestConsecutiveFraction(
  distances: readonly number[],
  tolerance: number,
): number {
  let current = 0;
  let longest = 0;
  for (const value of distances) {
    if (value > tolerance) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return distances.length ? longest / distances.length : 1;
}

function emptyResult(): FinalRouteSimilarityResult {
  return {
    score: 0,
    diagnostics: {
      lineCoverage: 0,
      chamfer: 0,
      orderedLandmarks: 0,
      curvatureSequence: 0,
      topology: 0,
      cleanliness: 0,
      closedness: 0,
      intendedCoverage: 0,
      actualPrecision: 0,
      normalizedChamfer: 1,
      longestStrayRun: 1,
      pathEconomy: 0,
      intendedSelfIntersections: 0,
      actualSelfIntersections: 0,
    },
  };
}

/**
 * Compares only the rendered geometry of an intended polyline and a final
 * route. Translation and uniform scale are normalized independently; rotation,
 * reflection, traversal structure, extra ink, and missing ink remain visible.
 */
export function scoreFinalRouteSimilarity(
  intendedPoints: readonly FinalRoutePoint[],
  actualPoints: readonly FinalRoutePoint[],
): FinalRouteSimilarityResult {
  const intended = prepare(intendedPoints);
  const actual = prepare(actualPoints);
  if (!intended || !actual) return emptyResult();

  const intendedSamples = resample(intended, LINE_SAMPLE_COUNT);
  const actualSamples = resample(actual, LINE_SAMPLE_COUNT);
  const intendedToActual = distancesToPath(intendedSamples, actual);
  const actualToIntended = distancesToPath(actualSamples, intended);

  const scales = [
    { tolerance: 0.015, weight: 0.25 },
    { tolerance: 0.035, weight: 0.45 },
    { tolerance: 0.07, weight: 0.3 },
  ];
  let lineCoverage = 0;
  let intendedCoverage = 0;
  let actualPrecision = 0;
  for (const scale of scales) {
    const recall = fractionWithin(intendedToActual, scale.tolerance);
    const precision = fractionWithin(actualToIntended, scale.tolerance);
    lineCoverage += scale.weight * harmonicMean(recall, precision);
    intendedCoverage += scale.weight * recall;
    actualPrecision += scale.weight * precision;
  }

  const normalizedChamfer = (mean(intendedToActual) + mean(actualToIntended)) / 2;
  const chamferScore = Math.exp(-normalizedChamfer / 0.075);
  const lineGeometry = 0.72 * lineCoverage + 0.28 * chamferScore;
  const ordered = orderedComparison(intended, actual);

  const intendedIntersections = selfIntersectionCount(intended);
  const actualIntersections = selfIntersectionCount(actual);
  const closedness = intended.closed === actual.closed ? 1 : 0;
  const intersectionSimilarity = Math.exp(
    -0.75 * Math.abs(intendedIntersections - actualIntersections),
  );
  const topology = 0.7 * closedness + 0.3 * intersectionSimilarity;

  const intendedLength = pathLength(intended.points);
  const actualLength = pathLength(actual.points);
  const lengthRatio = actualLength / Math.max(EPSILON, intendedLength);
  const extraLength = Math.max(0, lengthRatio - 1);
  const missingLength = Math.max(0, 1 - lengthRatio);
  const pathEconomy = Math.exp(-(extraLength / 0.55 + missingLength / 0.35));
  const longestStrayRun = longestConsecutiveFraction(actualToIntended, 0.07);
  const strayCleanliness = Math.exp(-longestStrayRun / 0.075);
  const unexpectedIntersections = Math.max(0, actualIntersections - intendedIntersections);
  const intersectionCleanliness = Math.exp(-unexpectedIntersections * 0.8);
  const cleanliness =
    0.45 * pathEconomy +
    0.4 * strayCleanliness +
    0.15 * intersectionCleanliness;

  let score =
    0.42 * lineGeometry +
    0.3 * ordered.ordered +
    0.12 * topology +
    0.16 * cleanliness;
  if (intended.closed !== actual.closed) score *= 0.78;


  return {
    score: roundedScore(score),
    diagnostics: {
      lineCoverage: roundedScore(lineCoverage),
      chamfer: roundedScore(chamferScore),
      orderedLandmarks: roundedScore(ordered.ordered),
      curvatureSequence: roundedScore(ordered.curvature),
      topology: roundedScore(topology),
      cleanliness: roundedScore(cleanliness),
      closedness: roundedScore(closedness),
      intendedCoverage: roundedScore(intendedCoverage),
      actualPrecision: roundedScore(actualPrecision),
      normalizedChamfer: Number(normalizedChamfer.toFixed(4)),
      longestStrayRun: roundedScore(1 - longestStrayRun),
      pathEconomy: roundedScore(pathEconomy),
      intendedSelfIntersections: intendedIntersections,
      actualSelfIntersections: actualIntersections,
    },
  };
}

