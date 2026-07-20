import assert from "node:assert";
import {
  centerlinePolylineFromLineMask,
  centerlinePolylinesFromLineMask,
  prepareTracedBinaryComponents,
} from "./centerlineFromMask";

const W = 48;
const H = 32;
const INK = 255;

/** 5 px tall × 36 px wide horizontal bar (thick stroke). */
function thickHorizontalBar(): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 12; y <= 16; y++) {
    for (let x = 6; x <= 41; x++) {
      m[y * W + x] = INK;
    }
  }
  return m;
}

function twoSeparatedBars(): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 12; y <= 16; y++) {
    for (let x = 4; x <= 14; x++) m[y * W + x] = INK;
    for (let x = 32; x <= 42; x++) m[y * W + x] = INK;
  }
  return m;
}

{
  const path = centerlinePolylineFromLineMask(thickHorizontalBar(), W, H);
  assert(path && path.length >= 8, "centerline should exist");
  const ys = path!.map(([, y]) => y);
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const ySpread = Math.max(...ys) - Math.min(...ys);
  assert(ySpread < 2.2, `centerline should be one row-ish, spread=${ySpread}`);
  assert(Math.abs(yMean - 14) < 1.2, `mean y ~ mid stroke, got ${yMean}`);
}

{
  // We trace the MAIN shape only. Welding separate pieces into one route
  // makes it mostly connector — on a logo lockup that produced a mangled
  // half-word hanging off the symbol by a long diagonal. Lettering is
  // served by the block-letter wordmark route instead, and users can bridge
  // pieces deliberately with the draw tool.
  const mask = twoSeparatedBars();
  const components = prepareTracedBinaryComponents(mask, W, H);
  assert.equal(
    components.length,
    1,
    "only the dominant component is traced, not every piece in the picture",
  );
  const paths = centerlinePolylinesFromLineMask(mask, W, H);
  assert.equal(
    paths.length,
    1,
    "skeletonization follows the traced components, so it yields the main shape",
  );
}

console.log("centerlineFromMask tests ok");
