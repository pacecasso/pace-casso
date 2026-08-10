import assert from "node:assert/strict";
import {
  curatedRobotManhattanMapNativeCandidate,
  curatedRobotRouteKm,
  curatedRobotRouteLine,
  CURATED_ROBOT_DESIGN_INTENT,
  CURATED_ROBOT_MANHATTAN_COORDS,
} from "./curatedRobotManhattanRoute";

assert(
  CURATED_ROBOT_MANHATTAN_COORDS.length >= 150,
  "curated robot route should preserve the compiled lattice head and face detail",
);

const km = curatedRobotRouteKm();
assert(km >= 18 && km <= 19, `curated robot route should be ~18.5 km, got ${km}`);

const candidate = curatedRobotManhattanMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.kind, "street-design");
assert.equal(candidate.designIntent, CURATED_ROBOT_DESIGN_INTENT);
assert(candidate.designIntent.includes("two square eyes"));
assert.equal(candidate.anchors.length, CURATED_ROBOT_MANHATTAN_COORDS.length);

const route = curatedRobotRouteLine();
assert.equal(route.coordinates.length, CURATED_ROBOT_MANHATTAN_COORDS.length);
assert(route.distanceMeters && route.distanceMeters > 18_000);
assert.equal(route.blockWaypoints?.length, CURATED_ROBOT_MANHATTAN_COORDS.length);

console.log("curatedRobotManhattanRoute tests ok");
