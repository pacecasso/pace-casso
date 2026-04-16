import assert from "node:assert";
import {
  isLikelyNestedHoleRing,
  stitchNestedHoleRingsInPlace,
  weaveInnerRingIntoOuter,
} from "./contourRingStitch";

const outer: [number, number][] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];
const inner: [number, number][] = [
  [40, 40],
  [60, 40],
  [60, 60],
  [40, 60],
];

assert(isLikelyNestedHoleRing(outer, inner), "square-in-square should nest");

const rings: [number, number][][] = [outer.map((p) => [...p] as [number, number]), inner.map((p) => [...p] as [number, number])];
stitchNestedHoleRingsInPlace(rings);
assert.strictEqual(rings.length, 1);
assert(rings[0]!.length > outer.length + inner.length - 2, "stitched path should be longer");

const w = weaveInnerRingIntoOuter(outer, inner);
assert(w.length >= outer.length + inner.length, "weave should append inner");

console.log("contourRingStitch: ok");
