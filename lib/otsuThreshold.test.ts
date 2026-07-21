import assert from "node:assert/strict";
import { inkThresholdForUpload, otsuInkThreshold } from "./otsuThreshold";

const whiteWithBlackInk = new Float32Array([
  ...Array(100).fill(0.02),
  ...Array(20).fill(0.82),
]);
const t1 = otsuInkThreshold(whiteWithBlackInk);
assert(t1 > 0.05 && t1 < 0.4, `expected split above paper, got ${t1}`);

const grayWithDarkInk = new Float32Array([
  ...Array(80).fill(0.25),
  ...Array(80).fill(0.7),
]);
const t2 = otsuInkThreshold(grayWithDarkInk);
assert(t2 > 0.2 && t2 < 0.55, `expected mid split, got ${t2}`);

const allInvalid = new Float32Array([Number.NaN, Infinity, -Infinity]);
assert.equal(otsuInkThreshold(allInvalid), 0.5);

const clampedLow = otsuInkThreshold(new Float32Array([0, 0, 1]), {
  min: 0.2,
  max: 0.8,
});
assert(clampedLow >= 0.2 && clampedLow <= 0.8);

// --- inkThresholdForUpload: white-page artwork keeps its LIGHT strokes ----
{
  // Artwork on a white page: 60% white background, ink at two tones — dark
  // (0.2) and light (0.75, like a grey 3D swoosh tail). Plain Otsu splits
  // between the tones and erases the light stroke; the upload rule must
  // return a threshold that keeps BOTH tones as ink.
  const artwork: number[] = [];
  for (let i = 0; i < 600; i++) artwork.push(0.97);
  for (let i = 0; i < 200; i++) artwork.push(0.2);
  for (let i = 0; i < 200; i++) artwork.push(0.75);
  const t = inkThresholdForUpload(artwork);
  assert(t > 0.75, `light ink tone must fall below the threshold, got ${t}`);

  // A photo-like histogram (no dominant white page) falls back to Otsu.
  const photo: number[] = [];
  for (let i = 0; i < 1000; i++) photo.push((i % 100) / 100);
  assert.equal(inkThresholdForUpload(photo), otsuInkThreshold(photo));
}

console.log("otsuThreshold tests ok");
