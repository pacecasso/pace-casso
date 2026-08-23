import assert from "node:assert/strict";
import { buildArtSpec, type NormalizedPoint } from "./artSpec";

function closed(points: NormalizedPoint[]): NormalizedPoint[] {
  return [...points, { ...points[0]! }];
}

function flatten(strokes: NormalizedPoint[][]): NormalizedPoint[] {
  return strokes.flatMap((stroke) => stroke);
}

const taperedRibbon = closed([
  { x: 0.08, y: 0.34 },
  { x: 0.24, y: 0.48 },
  { x: 0.45, y: 0.54 },
  { x: 0.68, y: 0.47 },
  { x: 0.88, y: 0.27 },
  { x: 0.69, y: 0.4 },
  { x: 0.46, y: 0.45 },
  { x: 0.22, y: 0.42 },
]);
const smallMarks = [
  closed([
    { x: 0.35, y: 0.72 },
    { x: 0.39, y: 0.64 },
    { x: 0.43, y: 0.72 },
  ]),
  closed([
    { x: 0.48, y: 0.72 },
    { x: 0.48, y: 0.64 },
    { x: 0.55, y: 0.64 },
    { x: 0.55, y: 0.72 },
  ]),
  closed([
    { x: 0.6, y: 0.72 },
    { x: 0.64, y: 0.64 },
    { x: 0.68, y: 0.72 },
  ]),
];
const ribbonSpec = buildArtSpec(flatten([taperedRibbon, ...smallMarks]));
assert.equal(ribbonSpec.strokes.length, 4);
assert.equal(ribbonSpec.connectors.length, 3);
assert.equal(ribbonSpec.composition, "dominant-symbol-with-secondary-marks");
assert.deepEqual(ribbonSpec.dominantStrokeIds, ["stroke-1"]);
assert(ribbonSpec.strokes[0]!.isClosed);
assert(ribbonSpec.strokes[0]!.approximateArea > ribbonSpec.strokes[1]!.approximateArea);
assert(
  ribbonSpec.strokes[0]!.landmarks.some((landmark) => landmark.kind === "curvature"),
  "the tapered symbol should retain high-curvature landmarks",
);

const loveLike = [
  closed([
    { x: 0.08, y: 0.2 },
    { x: 0.08, y: 0.7 },
    { x: 0.2, y: 0.7 },
    { x: 0.2, y: 0.63 },
    { x: 0.14, y: 0.63 },
    { x: 0.14, y: 0.2 },
  ]),
  closed([
    { x: 0.28, y: 0.2 },
    { x: 0.4, y: 0.2 },
    { x: 0.43, y: 0.27 },
    { x: 0.43, y: 0.63 },
    { x: 0.4, y: 0.7 },
    { x: 0.28, y: 0.7 },
    { x: 0.25, y: 0.63 },
    { x: 0.25, y: 0.27 },
  ]),
  closed([
    { x: 0.48, y: 0.2 },
    { x: 0.54, y: 0.7 },
    { x: 0.6, y: 0.2 },
    { x: 0.57, y: 0.2 },
    { x: 0.54, y: 0.57 },
    { x: 0.51, y: 0.2 },
  ]),
  closed([
    { x: 0.68, y: 0.2 },
    { x: 0.82, y: 0.2 },
    { x: 0.82, y: 0.27 },
    { x: 0.74, y: 0.27 },
    { x: 0.74, y: 0.42 },
    { x: 0.81, y: 0.42 },
    { x: 0.81, y: 0.49 },
    { x: 0.74, y: 0.49 },
    { x: 0.74, y: 0.63 },
    { x: 0.82, y: 0.63 },
    { x: 0.82, y: 0.7 },
    { x: 0.68, y: 0.7 },
  ]),
];
const loveSpec = buildArtSpec(flatten(loveLike));
assert.equal(loveSpec.strokes.length, 4);
assert.equal(loveSpec.connectors.length, 3);
assert.equal(loveSpec.composition, "glyph-sequence");
assert.equal(loveSpec.dominantStrokeIds.length, 4);

const heart = closed([
  { x: 0.5, y: 0.88 },
  { x: 0.14, y: 0.5 },
  { x: 0.14, y: 0.27 },
  { x: 0.29, y: 0.14 },
  { x: 0.5, y: 0.35 },
  { x: 0.71, y: 0.14 },
  { x: 0.86, y: 0.27 },
  { x: 0.86, y: 0.5 },
]);
const heartSpec = buildArtSpec(heart);
assert.equal(heartSpec.strokes.length, 1);
assert.equal(heartSpec.connectors.length, 0);
assert.equal(heartSpec.composition, "single-shape");
assert(heartSpec.strokes[0]!.isClosed);
assert(heartSpec.strokes[0]!.landmarks.some((landmark) => landmark.kind === "min-x"));
assert(heartSpec.strokes[0]!.landmarks.some((landmark) => landmark.kind === "max-y"));

const leftBox = closed([
  { x: 0.08, y: 0.15 },
  { x: 0.28, y: 0.15 },
  { x: 0.28, y: 0.35 },
  { x: 0.08, y: 0.35 },
]);
const rightBox = closed([
  { x: 0.72, y: 0.62 },
  { x: 0.92, y: 0.62 },
  { x: 0.92, y: 0.82 },
  { x: 0.72, y: 0.82 },
]);
const connectorSpec = buildArtSpec(flatten([leftBox, rightBox]));
assert.equal(connectorSpec.strokes.length, 2);
assert.equal(connectorSpec.connectors.length, 1);
assert.deepEqual(connectorSpec.strokes[0]!.points, leftBox);
assert.deepEqual(connectorSpec.strokes[1]!.points, rightBox);
assert.deepEqual(connectorSpec.connectors[0]!.from, leftBox[leftBox.length - 1]);
assert.deepEqual(connectorSpec.connectors[0]!.to, rightBox[0]);
assert.equal(
  connectorSpec.artworkPathLength + connectorSpec.travelPathLength,
  connectorSpec.strokes.reduce((sum, stroke) => sum + stroke.pathLength, 0) +
    connectorSpec.connectors[0]!.length,
);

console.log("artSpec tests ok");
