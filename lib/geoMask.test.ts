/**
 * npx tsx lib/geoMask.test.ts
 *
 * Covers the two pure helpers that decide whether a line-art upload survives:
 * fillEnclosed (the Sep 18 catpic bug - a 7 px outline eroded to nothing) and
 * medianInkRun (how we can tell line art from a silhouette in the first place).
 * The image-decoding paths need sharp and a real file, so they are exercised by
 * the offline rigs, not here.
 */
import assert from "node:assert";
import { fillEnclosed, medianInkRun } from "./geoMask";

const W = 40;
const H = 40;

function blank(): Uint8Array {
  return new Uint8Array(W * H);
}
function ink(m: Uint8Array, x: number, y: number) {
  if (x >= 0 && x < W && y >= 0 && y < H) m[y * W + x] = 255;
}
function count(m: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i] === 255) n++;
  return n;
}
/** an axis-aligned rectangle outline, `t` pixels thick */
function rectOutline(x0: number, y0: number, x1: number, y1: number, t: number): Uint8Array {
  const m = blank();
  for (let k = 0; k < t; k++) {
    for (let x = x0; x <= x1; x++) {
      ink(m, x, y0 + k);
      ink(m, x, y1 - k);
    }
    for (let y = y0; y <= y1; y++) {
      ink(m, x0 + k, y);
      ink(m, x1 - k, y);
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// fillEnclosed
// ---------------------------------------------------------------------------
{
  // a closed outline gets its interior filled
  const outline = rectOutline(10, 10, 29, 29, 2);
  const before = count(outline);
  const filled = fillEnclosed(outline, W, H);
  const after = count(filled);
  assert.ok(after > before, `filling adds pixels (${before} -> ${after})`);
  // the whole 20x20 block is now ink, and nothing outside it is
  assert.equal(after, 20 * 20, "exactly the enclosed rectangle is filled");
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inside = x >= 10 && x <= 29 && y >= 10 && y <= 29;
      assert.equal(
        filled[y * W + x] === 255,
        inside,
        `pixel ${x},${y} ${inside ? "should" : "should not"} be ink`,
      );
    }
}

{
  // every original ink pixel is still ink - filling never erases the drawing
  const outline = rectOutline(5, 5, 34, 34, 3);
  const filled = fillEnclosed(outline, W, H);
  for (let i = 0; i < outline.length; i++)
    if (outline[i] === 255) assert.equal(filled[i], 255, "the outline itself is preserved");
}

{
  // an OPEN outline encloses nothing: the flood reaches everywhere, so the mask
  // comes back as it went in rather than as a filled box
  const open = rectOutline(10, 10, 29, 29, 2);
  for (let x = 14; x <= 25; x++) {
    open[10 * W + x] = 0;
    open[11 * W + x] = 0;
  }
  const before = count(open);
  const filled = fillEnclosed(open, W, H);
  assert.equal(count(filled), before, "an open outline is left alone, not flooded");
}

{
  // a solid shape is already filled: nothing changes
  const solid = blank();
  for (let y = 12; y < 28; y++) for (let x = 12; x < 28; x++) ink(solid, x, y);
  const filled = fillEnclosed(solid, W, H);
  assert.equal(count(filled), count(solid), "a solid silhouette is unchanged");
}

{
  // two separate closed shapes both get filled
  const two = blank();
  for (let k = 0; k < 2; k++) {
    for (let x = 3; x <= 14; x++) { ink(two, x, 3 + k); ink(two, x, 14 - k); }
    for (let y = 3; y <= 14; y++) { ink(two, 3 + k, y); ink(two, 14 - k, y); }
    for (let x = 23; x <= 34; x++) { ink(two, x, 23 + k); ink(two, x, 34 - k); }
    for (let y = 23; y <= 34; y++) { ink(two, 23 + k, y); ink(two, 34 - k, y); }
  }
  const filled = fillEnclosed(two, W, H);
  assert.equal(count(filled), 12 * 12 * 2, "both enclosed shapes are filled");
}

{
  // a shape touching the border still fills, and an empty mask stays empty
  const edge = blank();
  for (let x = 0; x <= 10; x++) { ink(edge, x, 0); ink(edge, x, 10); }
  for (let y = 0; y <= 10; y++) { ink(edge, 0, y); ink(edge, 10, y); }
  const filledEdge = fillEnclosed(edge, W, H);
  assert.equal(count(filledEdge), 11 * 11, "a shape against the border fills");
  assert.equal(count(fillEnclosed(blank(), W, H)), 0, "an empty mask stays empty");
}

// ---------------------------------------------------------------------------
// medianInkRun - telling line art from a silhouette
// ---------------------------------------------------------------------------
{
  assert.equal(medianInkRun(blank(), W, H), 0, "no ink, no run");

  // a 3 px thick outline: most rows cross two 3 px verticals, so the median is 3
  const thin = rectOutline(10, 10, 29, 29, 3);
  assert.equal(medianInkRun(thin, W, H), 3, "a 3 px outline measures 3 px thick");

  // the same shape, filled, is 20 px across
  assert.equal(medianInkRun(fillEnclosed(thin, W, H), W, H), 20, "filled, it measures its full width");

  // this is the whole point: catpic was 7 px against a 6 px erode radius
  assert.ok(
    medianInkRun(thin, W, H) < medianInkRun(fillEnclosed(thin, W, H), W, H),
    "filling is what turns line art into something an opening cannot erase",
  );
}

console.log("geoMask tests passed");
