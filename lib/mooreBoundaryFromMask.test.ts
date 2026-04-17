import assert from "node:assert";
import { mooreContourRingsFromLineMask } from "./mooreBoundaryFromMask";

const W = 20;
const H = 20;
const INK = 255;

function hollowSquareFrame(): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 5; y <= 14; y++) {
    for (let x = 5; x <= 14; x++) {
      const edge = x === 5 || x === 14 || y === 5 || y === 14;
      if (edge) m[y * W + x] = INK;
    }
  }
  return m;
}

function solidDisk(): Uint8Array {
  const m = new Uint8Array(W * H);
  const cx = 10;
  const cy = 10;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= 5 ** 2) m[y * W + x] = INK;
    }
  }
  return m;
}

{
  const rings = mooreContourRingsFromLineMask(hollowSquareFrame(), W, H);
  assert(rings && rings.length >= 2, "frame should yield outer + inner ring");
  const outer = rings[0]!;
  const inner = rings[1]!;
  assert(outer.length > 24 && inner.length > 8, "rings should have many vertices");
}

{
  const rings = mooreContourRingsFromLineMask(solidDisk(), W, H);
  assert(rings && rings.length === 1, "solid blob should be one outer ring only");
  assert(rings[0]!.length > 18, "disk boundary should be reasonably long");
}

console.log("mooreBoundaryFromMask tests ok");
