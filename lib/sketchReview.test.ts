import assert from "node:assert/strict";
import {
  buildSketchReviewOptions,
  cleanSketchPoints,
  deleteSketchPoint,
  insertSketchPoint,
  moveSketchPoint,
  simplifySketchToMaxPoints,
  smoothSketchPath,
} from "./sketchReview";

const noisyLine = Array.from({ length: 80 }, (_, i) => ({
  x: i / 79,
  y: 0.5 + Math.sin(i / 4) * 0.05,
}));

const cleaned = cleanSketchPoints([
  { x: -1, y: 2 },
  { x: 0.001, y: 0.999 },
  { x: 0.5, y: 0.5 },
]);
assert.deepEqual(
  cleaned[0],
  { x: 0, y: 1 },
  "cleaning should clamp imported sketch points into the normalized canvas",
);
assert.equal(
  cleaned.length,
  2,
  "cleaning should drop nearly duplicate points so the editor starts sane",
);

const simplified = simplifySketchToMaxPoints(noisyLine, 16);
assert(
  simplified.length <= 16,
  "sketch simplification should create a compact editable path",
);
assert.deepEqual(
  simplified[0],
  noisyLine[0],
  "simplification should preserve the first point",
);
assert.deepEqual(
  simplified[simplified.length - 1],
  noisyLine[noisyLine.length - 1],
  "simplification should preserve the final point",
);

const smoothed = smoothSketchPath(
  [
    { x: 0, y: 0 },
    { x: 0.5, y: 1 },
    { x: 1, y: 0 },
  ],
  1,
);
assert(smoothed[1]!.y < 1, "smoothing should soften sharp single-point spikes");

const options = buildSketchReviewOptions(noisyLine);
assert.equal(options.length, 4, "review should offer multiple sketch choices");
assert(
  options.every((option) => option.points.length >= 2),
  "every sketch choice must be routable as a line",
);
assert(
  options[0]!.points.length >= options[options.length - 1]!.points.length,
  "later sketch choices should be more simplified than the first option",
);

const moved = moveSketchPoint(noisyLine, 4, { x: 2, y: -1 });
assert.deepEqual(
  moved[4],
  { x: 1, y: 0 },
  "dragged sketch points should stay inside the normalized drawing area",
);

const inserted = insertSketchPoint(
  [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ],
  null,
);
assert.deepEqual(
  inserted.points,
  [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 1, y: 0 },
  ],
  "insert should add a midpoint on the longest segment",
);
assert.equal(inserted.selectedIndex, 1);

const deleted = deleteSketchPoint(inserted.points, inserted.selectedIndex);
assert.deepEqual(
  deleted.points,
  [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ],
  "delete should remove the selected point without changing the remaining path",
);

console.log("sketchReview tests ok");
