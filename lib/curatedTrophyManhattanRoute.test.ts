import assert from "node:assert/strict";
import {
  CURATED_TROPHY_DESIGN_INTENT,
  CURATED_TROPHY_MANHATTAN_COORDS,
  curatedTrophyManhattanMapNativeCandidate,
  curatedTrophyRouteKm,
  curatedTrophyRouteLine,
} from "./curatedTrophyManhattanRoute";

assert(CURATED_TROPHY_MANHATTAN_COORDS.length >= 70, "trophy route should preserve compiled detail");
const km = curatedTrophyRouteKm();
assert(km >= 10.4 && km <= 11.1, `trophy route should be about 10.8 km, got ${km}`);
const candidate = curatedTrophyManhattanMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.designIntent, CURATED_TROPHY_DESIGN_INTENT);
assert(candidate.designIntent.includes("side handles"));
assert(candidate.designIntent.includes("stepped base"));
assert.equal(curatedTrophyRouteLine().blockWaypoints?.length, CURATED_TROPHY_MANHATTAN_COORDS.length);
console.log("curatedTrophyManhattanRoute tests ok");
