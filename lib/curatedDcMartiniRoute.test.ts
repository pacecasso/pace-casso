import assert from "node:assert";
import {
  CURATED_MARTINI_DC_COORDS,
  CURATED_MARTINI_DC_DESIGN_INTENT,
  curatedMartiniDcMapNativeCandidate,
  curatedMartiniDcRouteKm,
  curatedMartiniDcRouteLine,
} from "./curatedDcMartiniRoute";

assert(CURATED_MARTINI_DC_COORDS.length >= 150, "DC martini route should preserve simplified compiled street detail");

const km = curatedMartiniDcRouteKm();
assert(km >= 7.0 && km <= 7.3, `DC martini route should be about 7.1 km, got ${km}`);

const candidate = curatedMartiniDcMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.designIntent, CURATED_MARTINI_DC_DESIGN_INTENT);
assert(candidate.designIntent.includes("Verified martini DC v1"));
assert(candidate.designIntent.includes("triangular bowl"));
assert(candidate.anchors.length === CURATED_MARTINI_DC_COORDS.length);

const line = curatedMartiniDcRouteLine();
assert.equal(line.coordinates.length, CURATED_MARTINI_DC_COORDS.length);
assert.equal(line.blockWaypoints?.length, CURATED_MARTINI_DC_COORDS.length);
assert(line.distanceMeters != null);
assert(line.distanceMeters > 7_000 && line.distanceMeters < 7_300);

console.log("curatedDcMartiniRoute tests passed");

