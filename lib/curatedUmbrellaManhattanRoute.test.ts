import assert from "node:assert/strict";
import {
  CURATED_UMBRELLA_DESIGN_INTENT,
  CURATED_UMBRELLA_MANHATTAN_COORDS,
  curatedUmbrellaManhattanMapNativeCandidate,
  curatedUmbrellaRouteKm,
  curatedUmbrellaRouteLine,
} from "./curatedUmbrellaManhattanRoute";

assert(CURATED_UMBRELLA_MANHATTAN_COORDS.length >= 90, "umbrella route should preserve compiled detail");
const km = curatedUmbrellaRouteKm();
assert(km >= 6.2 && km <= 6.8, `umbrella route should be about 6.5 km, got ${km}`);
const candidate = curatedUmbrellaManhattanMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.designIntent, CURATED_UMBRELLA_DESIGN_INTENT);
assert(candidate.designIntent.includes("scalloped lower edge"));
assert.equal(curatedUmbrellaRouteLine().blockWaypoints?.length, CURATED_UMBRELLA_MANHATTAN_COORDS.length);
console.log("curatedUmbrellaManhattanRoute tests ok");
