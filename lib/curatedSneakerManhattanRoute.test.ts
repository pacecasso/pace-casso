import assert from "node:assert/strict";
import {
  curatedSneakerManhattanMapNativeCandidate,
  curatedSneakerRouteKm,
  curatedSneakerRouteLine,
  CURATED_SNEAKER_DESIGN_INTENT,
  CURATED_SNEAKER_MANHATTAN_COORDS,
} from "./curatedSneakerManhattanRoute";

assert(
  CURATED_SNEAKER_MANHATTAN_COORDS.length >= 1000,
  "curated sneaker route should preserve the tuned street polyline detail",
);

const km = curatedSneakerRouteKm();
assert(km >= 18 && km <= 20, `curated sneaker route should be ~18.9 km, got ${km}`);

const candidate = curatedSneakerManhattanMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.kind, "street-design");
assert.equal(candidate.designIntent, CURATED_SNEAKER_DESIGN_INTENT);
assert(candidate.designIntent.includes("lace comb"));
assert.equal(candidate.anchors.length, CURATED_SNEAKER_MANHATTAN_COORDS.length);

const route = curatedSneakerRouteLine();
assert.equal(route.coordinates.length, CURATED_SNEAKER_MANHATTAN_COORDS.length);
assert(route.distanceMeters && route.distanceMeters > 18_000);
assert.equal(route.blockWaypoints?.length, CURATED_SNEAKER_MANHATTAN_COORDS.length);

console.log("curatedSneakerManhattanRoute tests ok");