import assert from "node:assert/strict";
import {
  contourToLocalMeters,
  quantizeContourToCityBlocks,
} from "./cityBlockQuantize";

/** Simple heart-like closed polygon in normalized space. */
const HEART: { x: number; y: number }[] = [
  { x: 0.5, y: 0.92 },
  { x: 0.15, y: 0.55 },
  { x: 0.12, y: 0.35 },
  { x: 0.28, y: 0.12 },
  { x: 0.5, y: 0.28 },
  { x: 0.72, y: 0.12 },
  { x: 0.88, y: 0.35 },
  { x: 0.85, y: 0.55 },
  { x: 0.5, y: 0.92 },
];

const placement = { center: [40.73, -73.99] as [number, number], rotationDeg: 0, scale: 1.8 };

const local = contourToLocalMeters(HEART, placement);
assert.ok(local.length >= 8);
assert.ok(local.some(([e, n]) => e < 0), "heart has west extent");
assert.ok(local.some(([e, n]) => e > 0), "heart has east extent");

const q = quantizeContourToCityBlocks(HEART, placement, 100);
assert.ok(q, "quantize should succeed");
assert.ok(q!.filledCellCount >= 20, `expected filled cells, got ${q!.filledCellCount}`);
assert.ok(q!.cornerLatLngs.length >= 8, `expected corners, got ${q!.cornerLatLngs.length}`);
assert.ok(
  q!.blockStepLatLngs.length >= q!.cornerLatLngs.length,
  "block steps >= corners",
);

// Closed loop
const first = q!.cornerLatLngs[0]!;
const last = q!.cornerLatLngs[q!.cornerLatLngs.length - 1]!;
assert.ok(Math.abs(first[0] - last[0]) < 1e-4 && Math.abs(first[1] - last[1]) < 1e-4);

console.log(
  `cityBlockQuantize.test.ts ok — ${q!.filledCellCount} cells, ${q!.cornerLatLngs.length} corners`,
);
