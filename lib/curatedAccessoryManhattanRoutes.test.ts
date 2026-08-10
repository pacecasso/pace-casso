import assert from "node:assert/strict";
import {
  CURATED_GLASSES_DESIGN_INTENT,
  CURATED_GLASSES_MANHATTAN_COORDS,
  CURATED_MARTINI_DESIGN_INTENT,
  CURATED_MARTINI_MANHATTAN_COORDS,
  curatedGlassesManhattanMapNativeCandidate,
  curatedGlassesRouteKm,
  curatedGlassesRouteLine,
  curatedMartiniManhattanMapNativeCandidate,
  curatedMartiniRouteKm,
  curatedMartiniRouteLine,
} from "./curatedAccessoryManhattanRoutes";

assert(CURATED_MARTINI_MANHATTAN_COORDS.length >= 65, "martini route should preserve compiled detail");
assert(CURATED_GLASSES_MANHATTAN_COORDS.length >= 95, "glasses route should preserve compiled detail");
const martiniKm = curatedMartiniRouteKm();
assert(martiniKm >= 7.5 && martiniKm <= 8.3, `martini route should be about 7.8 km, got ${martiniKm}`);
const glassesKm = curatedGlassesRouteKm();
assert(glassesKm >= 11 && glassesKm <= 12, `glasses route should be about 11.5 km, got ${glassesKm}`);
const martini = curatedMartiniManhattanMapNativeCandidate();
assert.equal(martini.routeMode, "direct-grid");
assert.equal(martini.designIntent, CURATED_MARTINI_DESIGN_INTENT);
assert(martini.designIntent.includes("cocktail glass"));
assert(martini.designIntent.includes("Not promoted"));
assert(!martini.designIntent.includes("Verified martini"));
assert.equal(curatedMartiniRouteLine().blockWaypoints?.length, CURATED_MARTINI_MANHATTAN_COORDS.length);
const glasses = curatedGlassesManhattanMapNativeCandidate();
assert.equal(glasses.routeMode, "direct-grid");
assert.equal(glasses.designIntent, CURATED_GLASSES_DESIGN_INTENT);
assert(glasses.designIntent.includes("two rectangular lenses"));
assert(glasses.designIntent.includes("Not promoted until it passes blind review"));
assert(!glasses.designIntent.includes("Verified glasses"));
assert.equal(curatedGlassesRouteLine().blockWaypoints?.length, CURATED_GLASSES_MANHATTAN_COORDS.length);
console.log("curatedAccessoryManhattanRoutes tests ok");

