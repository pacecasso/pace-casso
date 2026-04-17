import assert from "node:assert";
import { centerlinePolylineFromLineMask } from "./centerlineFromMask";

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

{
  const path = centerlinePolylineFromLineMask(thickHorizontalBar(), W, H);
  assert(path && path.length >= 8, "centerline should exist");
  const ys = path!.map(([, y]) => y);
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const ySpread = Math.max(...ys) - Math.min(...ys);
  assert(ySpread < 2.2, `centerline should be one row-ish, spread=${ySpread}`);
  assert(Math.abs(yMean - 14) < 1.2, `mean y ~ mid stroke, got ${yMean}`);
}

console.log("centerlineFromMask tests ok");
