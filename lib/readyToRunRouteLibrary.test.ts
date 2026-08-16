import assert from "node:assert";
import { READY_TO_RUN_ROUTE_LIBRARY, readyRouteToLine } from "./readyToRunRouteLibrary";

const ids = READY_TO_RUN_ROUTE_LIBRARY.map((run) => run.id);

assert.deepEqual(ids, [
  "sneaker",
  "catalog-heart",
  "catalog-elephant",
  "catalog-runner",
  "catalog-the-big-apple",
  "apple",
]);
assert.ok(!ids.includes("catalog-smiley-face"));
assert.ok(!ids.includes("catalog-giraffe"));
assert.equal(READY_TO_RUN_ROUTE_LIBRARY[0]?.id, "sneaker");

for (const run of READY_TO_RUN_ROUTE_LIBRARY) {
  const route = readyRouteToLine(run);
  assert.equal(route.coordinates.length, run.coords.length);
  assert.equal(route.blockWaypoints?.length, run.coords.length);
  assert.equal(route.preserveBlockWaypoints, true);
  assert.ok((route.distanceMeters ?? 0) > 1000);
}

console.log("readyToRunRouteLibrary tests ok");
