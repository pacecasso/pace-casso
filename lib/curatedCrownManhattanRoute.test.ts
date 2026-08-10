import assert from "node:assert/strict";
import {
  curatedCrownManhattanMapNativeCandidate,
  curatedCrownRouteKm,
  curatedCrownRouteLine,
  CURATED_CROWN_DESIGN_INTENT,
  CURATED_CROWN_MANHATTAN_COORDS,
} from "./curatedCrownManhattanRoute";

assert(
  CURATED_CROWN_MANHATTAN_COORDS.length >= 90,
  "curated crown route should preserve the compiled crown points and base band",
);

const km = curatedCrownRouteKm();
assert(km >= 9.5 && km <= 10.7, `curated crown route should be ~10.1 km, got ${km}`);

const candidate = curatedCrownManhattanMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.kind, "street-design");
assert.equal(candidate.designIntent, CURATED_CROWN_DESIGN_INTENT);
assert(candidate.designIntent.includes("three tall points"));
assert.equal(candidate.anchors.length, CURATED_CROWN_MANHATTAN_COORDS.length);

const route = curatedCrownRouteLine();
assert.equal(route.coordinates.length, CURATED_CROWN_MANHATTAN_COORDS.length);
assert(route.distanceMeters && route.distanceMeters > 9_500);
assert.equal(route.blockWaypoints?.length, CURATED_CROWN_MANHATTAN_COORDS.length);

console.log("curatedCrownManhattanRoute tests ok");
