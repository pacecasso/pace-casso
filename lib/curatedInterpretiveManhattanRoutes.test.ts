import assert from "node:assert/strict";
import {
  curatedApple2ManhattanMapNativeCandidate,
  curatedApple2RouteKm,
  curatedApple2RouteLine,
  curatedTigerManhattanMapNativeCandidate,
  curatedTigerRouteKm,
  curatedTigerRouteLine,
  CURATED_APPLE2_DESIGN_INTENT,
  CURATED_APPLE2_MANHATTAN_COORDS,
  CURATED_TIGER_DESIGN_INTENT,
  CURATED_TIGER_MANHATTAN_COORDS,
} from "./curatedInterpretiveManhattanRoutes";

assert(CURATED_APPLE2_MANHATTAN_COORDS.length >= 120, "apple route should preserve compiled route detail");
assert(CURATED_TIGER_MANHATTAN_COORDS.length >= 290, "tiger route should preserve compiled route detail");

const appleKm = curatedApple2RouteKm();
assert(appleKm >= 12 && appleKm <= 13.5, `apple route should be ~12.8 km, got ${appleKm}`);
const tigerKm = curatedTigerRouteKm();
assert(tigerKm >= 29.5 && tigerKm <= 31, `tiger route should be ~30.5 km, got ${tigerKm}`);

const apple = curatedApple2ManhattanMapNativeCandidate();
assert.equal(apple.routeMode, "direct-grid");
assert.equal(apple.designIntent, CURATED_APPLE2_DESIGN_INTENT);
assert(apple.designIntent.includes("bite notch"));
assert.equal(curatedApple2RouteLine().blockWaypoints?.length, CURATED_APPLE2_MANHATTAN_COORDS.length);

const tiger = curatedTigerManhattanMapNativeCandidate();
assert.equal(tiger.routeMode, "direct-grid");
assert.equal(tiger.designIntent, CURATED_TIGER_DESIGN_INTENT);
assert(tiger.designIntent.includes("stripe strokes"));
assert.equal(curatedTigerRouteLine().blockWaypoints?.length, CURATED_TIGER_MANHATTAN_COORDS.length);

console.log("curatedInterpretiveManhattanRoutes tests ok");
