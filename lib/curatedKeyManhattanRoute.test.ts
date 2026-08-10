import assert from "node:assert/strict";
import {
  curatedKeyManhattanMapNativeCandidate,
  curatedKeyRouteKm,
  curatedKeyRouteLine,
  CURATED_KEY_DESIGN_INTENT,
  CURATED_KEY_MANHATTAN_COORDS,
} from "./curatedKeyManhattanRoute";

assert(CURATED_KEY_MANHATTAN_COORDS.length >= 90, "key route should preserve bow, shaft, and teeth detail");
const km = curatedKeyRouteKm();
assert(km >= 8.8 && km <= 9.6, `key route should be ~9.2 km, got ${km}`);
const candidate = curatedKeyManhattanMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.kind, "street-design");
assert.equal(candidate.designIntent, CURATED_KEY_DESIGN_INTENT);
assert(candidate.designIntent.includes("two stepped teeth"));
const route = curatedKeyRouteLine();
assert.equal(route.blockWaypoints?.length, CURATED_KEY_MANHATTAN_COORDS.length);
assert(route.distanceMeters && route.distanceMeters > 8_800);
console.log("curatedKeyManhattanRoute tests ok");
