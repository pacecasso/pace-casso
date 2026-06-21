import assert from "node:assert/strict";
import { otsuInkThreshold } from "./otsuThreshold";

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

console.log("otsuThreshold tests ok");
