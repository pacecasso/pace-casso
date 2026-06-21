import assert from "node:assert/strict";
import { rasterizeNormalizedPathToLineMask } from "./artPathMask";

const mask = rasterizeNormalizedPathToLineMask(
  [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.9 },
  ],
  20,
  1,
);

function inkAt(x: number, y: number): boolean {
  return mask[y * 20 + x] > 0;
}

assert.equal(mask.length, 400);
assert(inkAt(2, 2), "starts near first point");
assert(inkAt(10, 2), "paints horizontal segment");
assert(inkAt(17, 10), "paints vertical segment");
assert.equal(inkAt(2, 17), false, "does not fill unrelated corners");

const single = rasterizeNormalizedPathToLineMask([{ x: 0.5, y: 0.5 }], 10, 1);
assert(single.some((v) => v > 0), "single points still leave editable ink");

console.log("artPathMask tests ok");
