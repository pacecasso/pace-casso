import assert from "node:assert/strict";
import {
  CURATED_GAS_LOGO_BROOKLYN_COORDS,
  CURATED_GAS_LOGO_BROOKLYN_DESIGN_INTENT,
  curatedGasLogoBrooklynMapNativeCandidate,
  curatedGasLogoBrooklynRouteKm,
  curatedGasLogoBrooklynRouteLine,
} from "./curatedGasLogoBrooklynRoute";
import { haversineMeters } from "./haversine";

assert(
  CURATED_GAS_LOGO_BROOKLYN_COORDS.length >= 1000,
  "Brooklyn gas route should preserve the verified walked chain",
);

const km = curatedGasLogoBrooklynRouteKm();
assert(km >= 29 && km <= 33, `Brooklyn gas route should be about 30 km, got ${km}`);

let maxHop = 0;
for (let i = 1; i < CURATED_GAS_LOGO_BROOKLYN_COORDS.length; i++) {
  maxHop = Math.max(
    maxHop,
    haversineMeters(
      CURATED_GAS_LOGO_BROOKLYN_COORDS[i - 1]!,
      CURATED_GAS_LOGO_BROOKLYN_COORDS[i]!,
    ),
  );
}
assert(maxHop <= 300, `Brooklyn gas route should not teleport, max hop ${maxHop}`);

const candidate = curatedGasLogoBrooklynMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.designIntent, CURATED_GAS_LOGO_BROOKLYN_DESIGN_INTENT);
assert.equal(candidate.anchors.length, CURATED_GAS_LOGO_BROOKLYN_COORDS.length);

const route = curatedGasLogoBrooklynRouteLine();
assert.equal(route.blockWaypoints?.length, CURATED_GAS_LOGO_BROOKLYN_COORDS.length);

console.log("curatedGasLogoBrooklynRoute tests ok");