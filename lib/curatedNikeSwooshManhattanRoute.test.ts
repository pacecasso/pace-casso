import assert from "node:assert/strict";
import {
  curatedNikeSwooshMapNativeCandidate,
  curatedNikeSwooshRouteKm,
  CURATED_NIKE_SWOOSH_DESIGN_INTENT,
  CURATED_NIKE_SWOOSH_MANHATTAN_COORDS,
} from "./curatedNikeSwooshManhattanRoute";

assert(
  CURATED_NIKE_SWOOSH_MANHATTAN_COORDS.length >= 70,
  "curated Nike swoosh route should preserve the verified lattice chain",
);

const km = curatedNikeSwooshRouteKm();
assert(km >= 8 && km <= 10, `curated Nike swoosh route should be ~8.7 km, got ${km}`);

const candidate = curatedNikeSwooshMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.kind, "street-design");
assert(candidate.designIntent.includes("Curated Nike swoosh Manhattan v1"));
assert.equal(candidate.designIntent, CURATED_NIKE_SWOOSH_DESIGN_INTENT);
assert.equal(candidate.anchors.length, CURATED_NIKE_SWOOSH_MANHATTAN_COORDS.length);

console.log("curatedNikeSwooshManhattanRoute tests ok");
