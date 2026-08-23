import assert from "node:assert/strict";
import {
  curatedNikeBlockLockupMapNativeCandidate,
  curatedNikeBlockLockupRouteKm,
  CURATED_NIKE_BLOCK_LOCKUP_DESIGN_INTENT,
  CURATED_NIKE_BLOCK_LOCKUP_MANHATTAN_COORDS,
} from "./curatedNikeBlockLockupManhattanRoute";

assert(
  CURATED_NIKE_BLOCK_LOCKUP_MANHATTAN_COORDS.length >= 2000,
  "curated Nike block lockup should preserve the proven corridor route",
);

const km = curatedNikeBlockLockupRouteKm();
assert(km >= 49 && km <= 51, `curated Nike block lockup should be about 50 km, got ${km}`);

const candidate = curatedNikeBlockLockupMapNativeCandidate();
assert.equal(candidate.routeMode, "direct-grid");
assert.equal(candidate.kind, "street-wordmark");
assert(candidate.designIntent.includes("Curated Nike block lockup Manhattan v1"));
assert(candidate.designIntent.includes("JUST DO IT"));
assert.equal(candidate.designIntent, CURATED_NIKE_BLOCK_LOCKUP_DESIGN_INTENT);
assert.equal(candidate.anchors.length, CURATED_NIKE_BLOCK_LOCKUP_MANHATTAN_COORDS.length);

console.log("curatedNikeBlockLockupManhattanRoute tests ok");
