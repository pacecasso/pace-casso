import assert from "node:assert";
import { MANHATTAN_PRESET } from "./cityPresets";
import {
  anchorFootprintMetrics,
  buildRotationAngles,
  findBestHeuristicPlacement,
  principalAxisAngleDeg,
  rankHeuristicTop,
  scorePlacementHeuristic,
} from "./autoFindPlacement";
import { buildAnchorLatLngsFromContour } from "./placementFromContour";
import type { ContourPoint } from "./placementFromContour";

const square: ContourPoint[] = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
  { x: 0.25, y: 0.25 },
];

{
  const { placement, score } = findBestHeuristicPlacement(square, MANHATTAN_PRESET);
  assert(Number.isFinite(score) && score > -1e8, `expected finite score, got ${score}`);
  const s2 = scorePlacementHeuristic(square, MANHATTAN_PRESET, placement);
  assert(Math.abs(s2 - score) < 1e-6);
}

/** Horizontal bar in normalized space → principal axis ~0° */
const horizontalBar: ContourPoint[] = Array.from({ length: 21 }, (_, i) => ({
  x: i / 20,
  y: 0.5,
}));

{
  const ang = principalAxisAngleDeg(horizontalBar);
  assert(ang != null && Math.abs(ang) < 8, `expected ~0° axis, got ${ang}`);
  const rots = buildRotationAngles(horizontalBar, MANHATTAN_PRESET);
  assert(
    rots.some((r) => Math.abs(r - 29) <= 11 || Math.abs(r - 19) <= 11),
    `expected PCA grid seeds near Manhattan bearing, got ${rots.filter((r) => r >= 15 && r <= 40).slice(0, 8)}`,
  );
}

{
  const ranked = rankHeuristicTop(horizontalBar, MANHATTAN_PRESET, 5);
  assert(ranked.length >= 1);
  assert(ranked[0].score > -1e8);
}

/** Regression: scaling up a valid placement increases route length and should lower score when still in bounds. */
{
  const { placement: base } = findBestHeuristicPlacement(square, MANHATTAN_PRESET);
  let factor = 1.55;
  let scaled = { ...base, scale: Math.min(3, base.scale * factor) };
  let sBase = scorePlacementHeuristic(square, MANHATTAN_PRESET, base);
  let sScaled = scorePlacementHeuristic(square, MANHATTAN_PRESET, scaled);
  while (sScaled === -Infinity && factor > 1.08) {
    factor -= 0.05;
    scaled = { ...base, scale: Math.min(3, base.scale * factor) };
    sScaled = scorePlacementHeuristic(square, MANHATTAN_PRESET, scaled);
  }
  if (sScaled !== -Infinity) {
    assert(
      sBase > sScaled,
      `expected base scale to beat scaled-up (long-route penalty), got ${sBase} vs ${sScaled} at factor ${factor}`,
    );
  }
}

/** Footprint metrics: best heuristic placement yields sane bbox. */
{
  const { placement } = findBestHeuristicPlacement(square, MANHATTAN_PRESET);
  const { anchorLatLngs } = buildAnchorLatLngsFromContour(square, placement);
  const fp = anchorFootprintMetrics(anchorLatLngs, MANHATTAN_PRESET);
  assert(
    fp != null &&
      fp.widthM > 10 &&
      fp.heightM > 10 &&
      fp.aspectRatio >= 1 &&
      Number.isFinite(fp.minEdgeMarginKm),
  );
}

console.log("autoFindPlacement heuristic tests ok");
