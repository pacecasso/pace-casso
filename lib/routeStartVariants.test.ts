import assert from "node:assert/strict";
import {
  buildClosedLoopStartVariants,
  buildRouteStartVariants,
  isClosedLoopCandidate,
} from "./routeStartVariants";

const ring: [number, number][] = [
  [40, -73],
  [40, -72.999],
  [40.001, -72.999],
  [40.001, -73],
  [40, -73],
];

const openLine: [number, number][] = [
  [40, -73],
  [40, -72.999],
  [40.001, -72.998],
  [40.002, -72.997],
];

assert.equal(isClosedLoopCandidate(ring), true);
assert.equal(isClosedLoopCandidate(openLine), false);

const variants = buildClosedLoopStartVariants(ring, 4);
assert.equal(variants.length, 4);
for (const v of variants) {
  assert.deepEqual(v[0], v[v.length - 1], "variants should remain explicitly closed");
  assert.equal(v.length, ring.length, "rotating start should not add extra vertices");
}
assert.deepEqual(variants[0], ring);
assert.notDeepEqual(variants[1][0], ring[0], "variant should rotate the start point");
assert(
  variants.some(
    (v) =>
      v[0]?.[0] === ring[0]![0] &&
      v[0]?.[1] === ring[0]![1] &&
      v[1]?.[0] === ring[3]![0] &&
      v[1]?.[1] === ring[3]![1],
  ),
  "closed-loop variants should include the opposite travel direction",
);

const openVariants = buildClosedLoopStartVariants(openLine, 4);
assert.equal(openVariants.length, 1);
assert.deepEqual(openVariants[0], openLine);

const openRouteVariants = buildRouteStartVariants(openLine, 4);
assert.equal(openRouteVariants.length, 2);
assert.deepEqual(openRouteVariants[0], openLine);
assert.deepEqual(openRouteVariants[1], [...openLine].reverse());

const singleOpenVariant = buildRouteStartVariants(openLine, 1);
assert.equal(singleOpenVariant.length, 1);
assert.deepEqual(singleOpenVariant[0], openLine);

const closedRouteVariants = buildRouteStartVariants(ring, 3);
assert.equal(closedRouteVariants.length, 3);
for (const v of closedRouteVariants) {
  assert.deepEqual(v[0], v[v.length - 1]);
}

console.log("routeStartVariants tests ok");
