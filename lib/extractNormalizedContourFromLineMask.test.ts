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
  // The path now covers the dominant piece rather than reaching across every
  // fragment: joining them yields a route that is mostly travel between
  // shapes, which is unreadable once drawn on real streets.
  const xs = contour.map((p) => p.x);
  assert(
    Math.max(...xs) - Math.min(...xs) <= 0.45,
    "path stays on the main shape instead of spanning separated components",
  );
}

console.log("extractNormalizedContourFromLineMask tests ok");
