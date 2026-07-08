import assert from "node:assert/strict";
import {
  curatedGasLogoMapNativeCandidate,
  curatedGasLogoRouteKm,
  CURATED_GAS_LOGO_MANHATTAN_COORDS,
} from "./curatedGasLogoManhattanRoute";

assert(
  CURATED_GAS_LOGO_MANHATTAN_COORDS.length >= 20,
  "curated gas route should have enough corners to read on streets",
);
const km = curatedGasLogoRouteKm();
assert(km >= 8 && km <= 16, `curated gas route should be ~10 km, got ${km}`);
const candidate = curatedGasLogoMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert(
  candidate.designIntent.includes("Curated GAS logo Manhattan v1"),
  "curated candidate should be tagged for snap bypass",
);

console.log("curatedGasLogoManhattanRoute tests ok");
