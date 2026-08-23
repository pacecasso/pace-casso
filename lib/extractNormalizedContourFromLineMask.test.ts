import assert from "node:assert";
import { extractNormalizedContourFromLineMask } from "./extractNormalizedContourFromLineMask";
import { filledSilhouetteToLineArtMask } from "./filledSilhouetteToLineArtMask";
import { scoreFinalRouteSimilarity } from "./finalRouteSimilarity";

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

{
  const w = 100;
  const h = 60;
  const filled = new Uint8Array(w * h);
  for (let y = 10; y <= 44; y++) {
    const left = 8 + Math.floor((y - 10) * 0.35);
    const right = 90 - Math.floor((y - 10) * 1.7);
    for (let x = left; x <= Math.max(left + 3, right); x++) {
      filled[y * w + x] = INK;
    }
  }
  const outline = filledSilhouetteToLineArtMask(filled, w, h, 3);
  const contour = extractNormalizedContourFromLineMask(
    outline,
    0.22,
    w,
    h,
    { source: "silhouette-outline" },
  );
  assert(contour, "silhouette outline should produce a contour");
  const expected = [
    { x: 8 / w, y: 10 / h },
    { x: 90 / w, y: 10 / h },
    { x: 32 / w, y: 44 / h },
    { x: 20 / w, y: 44 / h },
    { x: 8 / w, y: 10 / h },
  ];
  const similarity = scoreFinalRouteSimilarity(expected, contour);
  assert(
    similarity.score >= 90,
    "silhouette boundary should stay clean, got " + similarity.score,
  );
  assert.strictEqual(
    similarity.diagnostics.actualSelfIntersections,
    0,
    "untouched silhouette must not acquire skeleton branches",
  );
}

console.log("extractNormalizedContourFromLineMask tests ok");
