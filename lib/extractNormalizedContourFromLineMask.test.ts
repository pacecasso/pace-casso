import assert from "node:assert";
import { extractNormalizedContourFromLineMask } from "./extractNormalizedContourFromLineMask";

const W = 80;
const H = 40;
const INK = 255;

function separatedLetterLikeStrokes(): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 12; y <= 25; y++) {
    for (let x = 8; x <= 13; x++) m[y * W + x] = INK;
    for (let x = 46; x <= 51; x++) m[y * W + x] = INK;
  }
  return m;
}

{
  const contour = extractNormalizedContourFromLineMask(
    separatedLetterLikeStrokes(),
    0.22,
    W,
    H,
  );
  assert(contour && contour.length >= 4, "multi-component art should produce a path");
  const xs = contour.map((p) => p.x);
  assert(
    Math.max(...xs) - Math.min(...xs) > 0.45,
    "path should span both separated components",
  );
}

console.log("extractNormalizedContourFromLineMask tests ok");
