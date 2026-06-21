import assert from "node:assert/strict";
import { cleanupRouteSpurs } from "./routeSpurCleanup";

const baseLat = 40.75;
const baseLng = -73.99;

const routeWithStub = {
  coordinates: [
    [baseLat, baseLng],
    [baseLat, baseLng + 0.002],
    [baseLat + 0.0015, baseLng + 0.002],
    [baseLat, baseLng + 0.00208],
    [baseLat, baseLng + 0.004],
  ] as [number, number][],
  blockWaypoints: [
    [baseLat, baseLng],
    [baseLat + 0.0015, baseLng + 0.002],
    [baseLat, baseLng + 0.004],
  ] as [number, number][],
};

const cleaned = cleanupRouteSpurs(routeWithStub);
assert.equal(cleaned.removedCount, 1, "short out-and-back stub should be removed");
assert.deepEqual(
  cleaned.route.coordinates,
  [
    [baseLat, baseLng],
    [baseLat, baseLng + 0.002],
    [baseLat, baseLng + 0.00208],
    [baseLat, baseLng + 0.004],
  ],
  "cleanup should preserve the main corridor and remove only the protruding point",
);
assert.equal(
  cleaned.route.blockWaypoints,
  undefined,
  "block waypoints should be recalculated after geometry cleanup",
);

const normalCorner = cleanupRouteSpurs({
  coordinates: [
    [baseLat, baseLng],
    [baseLat, baseLng + 0.002],
    [baseLat + 0.0015, baseLng + 0.002],
    [baseLat + 0.0015, baseLng + 0.004],
  ] as [number, number][],
});
assert.equal(
  normalCorner.removedCount,
  0,
  "ordinary route corners should not be removed",
);

const multiPointStub = cleanupRouteSpurs({
  coordinates: [
    [baseLat, baseLng],
    [baseLat, baseLng + 0.002],
    [baseLat + 0.001, baseLng + 0.002],
    [baseLat + 0.0014, baseLng + 0.00205],
    [baseLat, baseLng + 0.0021],
    [baseLat, baseLng + 0.004],
  ] as [number, number][],
});
assert.equal(
  multiPointStub.removedCount,
  2,
  "small multi-point side trips should be collapsed back to the main corridor",
);
assert.deepEqual(multiPointStub.route.coordinates, [
  [baseLat, baseLng],
  [baseLat, baseLng + 0.002],
  [baseLat, baseLng + 0.0021],
  [baseLat, baseLng + 0.004],
]);

console.log("routeSpurCleanup tests ok");
