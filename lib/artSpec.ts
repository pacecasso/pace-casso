export type NormalizedPoint = { x: number; y: number };

export type BoundingBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  diagonal: number;
};

export type ArtLandmarkKind =
  | "start"
  | "end"
  | "curvature"
  | "min-x"
  | "max-x"
  | "min-y"
  | "max-y";

export type ArtLandmark = {
  kind: ArtLandmarkKind;
  pointIndex: number;
  point: NormalizedPoint;
  /** 0..1, where 1 is a reversal. Extrema use their geometric prominence. */
  strength: number;
};

export type ArtStroke = {
  id: string;
  sourceStartIndex: number;
  sourceEndIndex: number;
  points: NormalizedPoint[];
  bbox: BoundingBox;
  pathLength: number;
  /** Shoelace area after implicitly closing the stroke. */
  approximateArea: number;
  /** 0..1 measure based on endpoint gap relative to the stroke span. */
  closedness: number;
  isClosed: boolean;
  endpoints: [NormalizedPoint, NormalizedPoint];
  landmarks: ArtLandmark[];
  /** Geometry-only importance derived from span, enclosed area, and ink length. */
  visualSalience: number;
  isDominant: boolean;
};

export type TravelConnector = {
  id: string;
  sourceSegmentIndex: number;
  fromStrokeId: string;
  toStrokeId: string;
  from: NormalizedPoint;
  to: NormalizedPoint;
  length: number;
};

export type CompositionClass =
  | "single-shape"
  | "dominant-symbol-with-secondary-marks"
  | "balanced-multi-stroke"
  | "glyph-sequence";

export type ArtSpec = {
  sourcePoints: NormalizedPoint[];
  bbox: BoundingBox;
  artworkPathLength: number;
  travelPathLength: number;
  strokes: ArtStroke[];
  connectors: TravelConnector[];
  dominantStrokeIds: string[];
  composition: CompositionClass;
};

const EPSILON = 1e-9;

function distance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * fraction)),
  );
  return sorted[index]!;
}

function boundingBox(points: NormalizedPoint[]): BoundingBox {
  if (!points.length) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
      diagonal: 0,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    diagonal: Math.hypot(width, height),
  };
}

function polylineLength(points: NormalizedPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1]!, points[i]!);
  }
  return total;
}

function polygonArea(points: NormalizedPoint[]): number {
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twiceArea) / 2;
}

function dedupeConsecutive(points: NormalizedPoint[]): NormalizedPoint[] {
  const output: NormalizedPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const copy = { x: point.x, y: point.y };
    const previous = output[output.length - 1];
    if (!previous || distance(previous, copy) > EPSILON) output.push(copy);
  }
  return output;
}

function pointLineDistance(
  point: NormalizedPoint,
  start: NormalizedPoint,
  end: NormalizedPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (denominator <= EPSILON) return distance(point, start);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator),
  );
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

function turnStrength(
  previous: NormalizedPoint,
  point: NormalizedPoint,
  next: NormalizedPoint,
): number {
  const ax = point.x - previous.x;
  const ay = point.y - previous.y;
  const bx = next.x - point.x;
  const by = next.y - point.y;
  const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (lengths <= EPSILON) return 0;
  const cosine = Math.max(-1, Math.min(1, (ax * bx + ay * by) / lengths));
  return Math.acos(cosine) / Math.PI;
}

function strokeLandmarks(
  points: NormalizedPoint[],
  bbox: BoundingBox,
): ArtLandmark[] {
  if (!points.length) return [];
  const candidates = new Map<string, ArtLandmark>();
  const add = (landmark: ArtLandmark): void => {
    const key = `${landmark.kind}:${landmark.pointIndex}`;
    candidates.set(key, landmark);
  };

  add({ kind: "start", pointIndex: 0, point: points[0]!, strength: 1 });
  if (points.length > 1) {
    add({
      kind: "end",
      pointIndex: points.length - 1,
      point: points[points.length - 1]!,
      strength: 1,
    });
  }

  const extrema: Array<[ArtLandmarkKind, (point: NormalizedPoint) => number]> = [
    ["min-x", (point) => point.x],
    ["max-x", (point) => -point.x],
    ["min-y", (point) => point.y],
    ["max-y", (point) => -point.y],
  ];
  for (const [kind, value] of extrema) {
    let bestIndex = 0;
    for (let i = 1; i < points.length; i++) {
      if (value(points[i]!) < value(points[bestIndex]!)) bestIndex = i;
    }
    const point = points[bestIndex]!;
    const centerX = (bbox.minX + bbox.maxX) / 2;
    const centerY = (bbox.minY + bbox.maxY) / 2;
    const prominence =
      kind.endsWith("x")
        ? Math.abs(point.x - centerX) / Math.max(bbox.width / 2, EPSILON)
        : Math.abs(point.y - centerY) / Math.max(bbox.height / 2, EPSILON);
    add({ kind, pointIndex: bestIndex, point, strength: Math.min(1, prominence) });
  }

  const strengths = points.map((_, index) =>
    index > 0 && index < points.length - 1
      ? turnStrength(points[index - 1]!, points[index]!, points[index + 1]!)
      : 0,
  );
  for (let i = 1; i < points.length - 1; i++) {
    const strength = strengths[i]!;
    if (
      strength >= 0.18 &&
      strength >= strengths[i - 1]! &&
      strength >= strengths[i + 1]!
    ) {
      const scale = Math.max(bbox.diagonal, EPSILON);
      const prominence = pointLineDistance(
        points[i]!,
        points[i - 1]!,
        points[i + 1]!,
      ) / scale;
      if (prominence >= 0.004 || strength >= 0.42) {
        add({
          kind: "curvature",
          pointIndex: i,
          point: points[i]!,
          strength,
        });
      }
    }
  }

  return [...candidates.values()].sort(
    (a, b) => a.pointIndex - b.pointIndex || a.kind.localeCompare(b.kind),
  );
}

function connectorIndexes(points: NormalizedPoint[]): Set<number> {
  const lengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const length = distance(points[i - 1]!, points[i]!);
    if (length > EPSILON) lengths.push(length);
  }
  if (lengths.length < 3) return new Set();

  const bbox = boundingBox(points);
  const median = percentile(lengths, 0.5);
  const upperQuartile = percentile(lengths, 0.75);
  const absoluteFloor = Math.max(bbox.diagonal * 0.018, EPSILON);
  const robustFloor = Math.max(median * 2.75, upperQuartile * 1.8, absoluteFloor);
  const connectors = new Set<number>();

  // Prefer the explicit boundary encoded by the current contour extractor:
  // each closed component repeats its first point before the next component.
  let closedStrokeStart = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const componentPoints = points.slice(closedStrokeStart, i + 1);
    const componentBox = boundingBox(componentPoints);
    const closureTolerance = Math.max(
      EPSILON * 10,
      median * 0.05,
      componentBox.diagonal * 1e-4,
    );
    if (
      componentPoints.length >= 4 &&
      distance(componentPoints[0]!, componentPoints[componentPoints.length - 1]!) <=
        closureTolerance &&
      distance(points[i]!, points[i + 1]!) > EPSILON
    ) {
      connectors.add(i);
      closedStrokeStart = i + 1;
    }
  }
  if (connectors.size) return connectors;

  // Open centerlines have no loop marker, so recover their boundaries from
  // discontinuities that are large globally and relative to both neighbors.
  let strokeStart = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const length = distance(points[i]!, points[i + 1]!);
    const currentPoints = points.slice(strokeStart, i + 1);
    const currentBox = boundingBox(currentPoints);
    const exactClosureTolerance = Math.max(
      EPSILON * 10,
      median * 0.05,
      currentBox.diagonal * 1e-4,
    );
    const exactlyClosesCurrent =
      currentPoints.length >= 4 &&
      distance(currentPoints[0]!, currentPoints[currentPoints.length - 1]!) <=
        exactClosureTolerance;

    // The contour extractor repeats the first vertex at the end of every
    // closed component, then appends the next component directly. That exact
    // closure is a stronger boundary marker than jump length, especially for
    // sparse glyphs whose legitimate edges can be longer than their spacing.
    if (exactlyClosesCurrent && length > EPSILON) {
      connectors.add(i);
      strokeStart = i + 1;
      continue;
    }

    if (length < robustFloor) continue;

    const previous = i > 0 ? distance(points[i - 1]!, points[i]!) : median;
    const next =
      i + 2 < points.length ? distance(points[i + 1]!, points[i + 2]!) : median;
    const localScale = Math.max(median, Math.min(previous, next));
    const isStrongOutlier = length >= localScale * 3.1;

    // Closed component traces provide stronger evidence: a jump begins just
    // after returning to the component's start. This avoids splitting a real
    // long edge in sparse line art merely because neighboring edges are short.

    const closureTolerance = Math.max(median * 2.5, currentBox.diagonal * 0.055);
    const closesCurrent =
      currentPoints.length >= 4 &&
      distance(currentPoints[0]!, currentPoints[currentPoints.length - 1]!) <=
        closureTolerance;

    if (isStrongOutlier && (closesCurrent || length >= robustFloor * 1.35)) {
      connectors.add(i);
      strokeStart = i + 1;
    }
  }
  return connectors;
}

type StrokeDraft = {
  sourceStartIndex: number;
  sourceEndIndex: number;
  points: NormalizedPoint[];
};

function splitStrokes(points: NormalizedPoint[]): {
  drafts: StrokeDraft[];
  connectorSegmentIndexes: number[];
} {
  const splitAfter = connectorIndexes(points);
  const drafts: StrokeDraft[] = [];
  const connectorSegmentIndexes = [...splitAfter].sort((a, b) => a - b);
  let start = 0;
  for (const segmentIndex of [...connectorSegmentIndexes, points.length - 1]) {
    const end = segmentIndex;
    const strokePoints = points.slice(start, end + 1);
    if (strokePoints.length) {
      drafts.push({
        sourceStartIndex: start,
        sourceEndIndex: end,
        points: strokePoints,
      });
    }
    start = end + 1;
  }
  return { drafts, connectorSegmentIndexes };
}

function buildStroke(draft: StrokeDraft, index: number): ArtStroke {
  const bbox = boundingBox(draft.points);
  const pathLength = polylineLength(draft.points);
  const endpointGap =
    draft.points.length > 1
      ? distance(draft.points[0]!, draft.points[draft.points.length - 1]!)
      : 0;
  const closureScale = Math.max(bbox.diagonal, pathLength * 0.2, EPSILON);
  const closedness = Math.max(0, 1 - endpointGap / closureScale);
  return {
    id: `stroke-${index + 1}`,
    sourceStartIndex: draft.sourceStartIndex,
    sourceEndIndex: draft.sourceEndIndex,
    points: draft.points,
    bbox,
    pathLength,
    approximateArea: polygonArea(draft.points),
    closedness,
    isClosed: draft.points.length >= 4 && closedness >= 0.78,
    endpoints: [draft.points[0]!, draft.points[draft.points.length - 1]!],
    landmarks: strokeLandmarks(draft.points, bbox),
    visualSalience: 0,
    isDominant: false,
  };
}

function assignVisualSalience(strokes: ArtStroke[]): void {
  const maxSpan = Math.max(...strokes.map((stroke) => stroke.bbox.diagonal), EPSILON);
  const maxInk = Math.max(...strokes.map((stroke) => stroke.pathLength), EPSILON);
  const maxAreaRoot = Math.max(
    ...strokes.map((stroke) => Math.sqrt(stroke.approximateArea)),
    EPSILON,
  );

  for (const stroke of strokes) {
    const span = stroke.bbox.diagonal / maxSpan;
    const ink = stroke.pathLength / maxInk;
    const area = Math.sqrt(stroke.approximateArea) / maxAreaRoot;
    stroke.visualSalience = 0.42 * span + 0.33 * ink + 0.25 * area;
  }

  const maximum = Math.max(...strokes.map((stroke) => stroke.visualSalience), EPSILON);
  for (const stroke of strokes) {
    stroke.visualSalience /= maximum;
    stroke.isDominant = stroke.visualSalience >= 0.52;
  }
}

function center(stroke: ArtStroke): NormalizedPoint {
  return {
    x: (stroke.bbox.minX + stroke.bbox.maxX) / 2,
    y: (stroke.bbox.minY + stroke.bbox.maxY) / 2,
  };
}

function isGlyphSequence(strokes: ArtStroke[]): boolean {
  if (strokes.length < 3) return false;
  const ordered = [...strokes].sort((a, b) => center(a).x - center(b).x);
  const medianHeight = percentile(
    ordered.map((stroke) => stroke.bbox.height),
    0.5,
  );
  const medianWidth = percentile(
    ordered.map((stroke) => stroke.bbox.width),
    0.5,
  );
  if (medianHeight <= EPSILON || medianWidth <= EPSILON) return false;

  const comparable = ordered.filter(
    (stroke) =>
      stroke.bbox.height >= medianHeight * 0.55 &&
      stroke.bbox.height <= medianHeight * 1.75 &&
      stroke.visualSalience >= 0.38,
  );
  if (comparable.length / ordered.length < 0.75) return false;

  const centers = ordered.map(center);
  const centerYs = centers.map((point) => point.y);
  const verticalSpread = Math.max(...centerYs) - Math.min(...centerYs);
  const overall = boundingBox(ordered.flatMap((stroke) => stroke.points));
  if (verticalSpread > medianHeight * 0.6 || overall.width <= overall.height * 1.35) {
    return false;
  }

  let separatedNeighbors = 0;
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    const overlap = Math.max(
      0,
      Math.min(previous.bbox.maxX, current.bbox.maxX) -
        Math.max(previous.bbox.minX, current.bbox.minX),
    );
    if (overlap <= Math.min(previous.bbox.width, current.bbox.width) * 0.25) {
      separatedNeighbors++;
    }
  }
  return separatedNeighbors >= ordered.length - 2;
}

function classifyComposition(strokes: ArtStroke[]): CompositionClass {
  if (strokes.length <= 1) return "single-shape";
  if (isGlyphSequence(strokes)) return "glyph-sequence";

  const dominantCount = strokes.filter((stroke) => stroke.isDominant).length;
  if (dominantCount === 1) return "dominant-symbol-with-secondary-marks";
  return "balanced-multi-stroke";
}

/**
 * Recover artwork structure from the current flattened trace. Long jump
 * segments become travel connectors; all remaining geometry stays attached to
 * its original stroke and is described without filenames or semantic labels.
 */
export function buildArtSpec(trace: NormalizedPoint[]): ArtSpec {
  const sourcePoints = dedupeConsecutive(trace);
  if (!sourcePoints.length) {
    return {
      sourcePoints: [],
      bbox: boundingBox([]),
      artworkPathLength: 0,
      travelPathLength: 0,
      strokes: [],
      connectors: [],
      dominantStrokeIds: [],
      composition: "single-shape",
    };
  }

  const { drafts, connectorSegmentIndexes } = splitStrokes(sourcePoints);
  const strokes = drafts.map(buildStroke);
  assignVisualSalience(strokes);

  const connectors: TravelConnector[] = connectorSegmentIndexes.map(
    (sourceSegmentIndex, index) => {
      const fromStroke = strokes[index]!;
      const toStroke = strokes[index + 1]!;
      const from = sourcePoints[sourceSegmentIndex]!;
      const to = sourcePoints[sourceSegmentIndex + 1]!;
      return {
        id: `connector-${index + 1}`,
        sourceSegmentIndex,
        fromStrokeId: fromStroke.id,
        toStrokeId: toStroke.id,
        from,
        to,
        length: distance(from, to),
      };
    },
  );

  return {
    sourcePoints,
    bbox: boundingBox(sourcePoints),
    artworkPathLength: strokes.reduce((sum, stroke) => sum + stroke.pathLength, 0),
    travelPathLength: connectors.reduce((sum, connector) => sum + connector.length, 0),
    strokes,
    connectors,
    dominantStrokeIds: strokes
      .filter((stroke) => stroke.isDominant)
      .map((stroke) => stroke.id),
    composition: classifyComposition(strokes),
  };
}
