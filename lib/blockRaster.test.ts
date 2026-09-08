import assert from "node:assert";
import { rasterizeMask, boundaryLoops, simplifyLoop, loopLength, cellStats } from "./blockRaster";

// a 20x20 mask with a filled 12x12 square holding a 4x4 hole
const w = 20;
const h = 20;
const mask = new Uint8Array(w * h);
for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) mask[y * w + x] = 255;
for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) mask[y * w + x] = 0;

const cells = rasterizeMask(mask, w, h, 6, 6);
const stats = cellStats(cells);
assert.strictEqual(cells.cols, 6);
assert.strictEqual(stats.on, 32, "6x6 ring with a 2x2 hole = 32 on cells");
assert.strictEqual(stats.components, 1);

const loops = boundaryLoops(cells);
assert.strictEqual(loops.length, 2, "outer loop + hole loop");
const byLen = loops.map((l) => loopLength(l, 1, 1)).sort((a, b) => a - b);
assert.deepStrictEqual(byLen, [8, 24], "hole perimeter 8, outer perimeter 24");
// simplified square loops have exactly 4 corners
assert.deepStrictEqual(
  loops.map((l) => l.length).sort((a, b) => a - b),
  [4, 4],
);

// orientation: outer loop counter-clockwise (positive signed area), hole clockwise
const signedArea = (loop: [number, number][]) => {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % loop.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};
const areas = loops.map(signedArea).sort((a, b) => a - b);
assert.strictEqual(areas[0], -4, "hole is clockwise, area 4");
assert.strictEqual(areas[1], 36, "outer is counter-clockwise, area 36");

// thin stroke: a 3-pixel-wide diagonal band rasterized coarsely stays
// 4-connected (corner-touching cells get bridged)
const w2 = 30;
const m2 = new Uint8Array(w2 * w2);
for (let t = 0; t < 30; t++) for (let d = -1; d <= 1; d++) if (t + d >= 0 && t + d < 30) m2[t * w2 + t + d] = 255;
const c2 = rasterizeMask(m2, w2, w2, 6, 6, { threshold: 0.3, thinThreshold: 0.02 });
const s2 = cellStats(c2);
assert.strictEqual(s2.components, 1, "diagonal line bridges into one component");
assert.ok(s2.on >= 6 && s2.on <= 11, `diagonal on-cells ${s2.on}`);

// pinch point: two squares touching at one corner produce two loops, not one
const w3 = 4;
const m3 = new Uint8Array(w3 * w3);
m3[0 * w3 + 0] = 255;
m3[1 * w3 + 1] = 255;
const c3 = rasterizeMask(m3, w3, w3, 2, 2, { threshold: 0.9, thinThreshold: 2 });
assert.strictEqual(cellStats(c3).on, 2);
const l3 = boundaryLoops(c3);
assert.strictEqual(l3.length, 2, "two diagonal cells = two loops");
assert.ok(l3.every((l) => loopLength(l, 1, 1) === 4));

// simplifyLoop keeps corners only
assert.deepStrictEqual(
  simplifyLoop([
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [2, 2],
    [0, 2],
  ]),
  [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ],
);

console.log("blockRaster.test.ts: all assertions passed");
