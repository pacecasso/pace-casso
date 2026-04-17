import assert from "node:assert";
import { MANHATTAN_PRESET } from "./cityPresets";
import { findBestHeuristicPlacement, scorePlacementHeuristic } from "./autoFindPlacement";
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

console.log("autoFindPlacement heuristic tests ok");
