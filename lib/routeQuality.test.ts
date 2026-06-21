import assert from "node:assert/strict";
import {
  doublingBackRatio,
  jaggedTurnRatio,
  protrudingDetourRatio,
  routeQualityScore,
} from "./routeQuality";

const noBacktrack: [number, number][] = [
  [40, -73],
  [40, -72.996],
  [40.003, -72.996],
  [40.003, -73],
];

const directOutAndBack: [number, number][] = [
  [40, -73],
  [40, -72.996],
  [40, -73],
];

const nearParallelReturn: [number, number][] = [
  [40, -73],
  [40, -72.996],
  [40.00018, -72.996],
  [40.00018, -73],
];

const broadGridShape: [number, number][] = [
  [40, -73],
  [40, -72.996],
  [40.003, -72.995],
  [40.006, -72.998],
  [40.003, -73.001],
  [40, -73],
];

const stairStepCurve: [number, number][] = [
  [40, -73],
  [40, -72.9991],
  [40.00045, -72.9991],
  [40.00045, -72.9982],
  [40.0009, -72.9982],
  [40.0009, -72.9973],
  [40.00135, -72.9973],
  [40.00135, -72.9964],
  [40.0018, -72.9964],
  [40.0018, -72.9955],
  [40.00225, -72.9955],
  [40.00225, -72.9946],
];

const routeWithStickOut: [number, number][] = [
  [40, -73],
  [40, -72.999],
  [40.001, -72.999],
  [40.00005, -72.99885],
  [40, -72.998],
  [40, -72.997],
];

assert.equal(routeQualityScore([]), 0, "empty routes should not look clean");
assert.equal(
  routeQualityScore([[40, -73]]),
  0,
  "single-point routes should not look clean",
);
assert.equal(
  routeQualityScore([
    [40, -73],
    [40, -73],
  ]),
  0,
  "zero-length routes should not look clean",
);
assert.equal(
  routeQualityScore([
    [Number.NaN, -73],
    [40, -73],
  ]),
  0,
  "invalid-only geometry should not look clean",
);
assert.equal(
  routeQualityScore([
    [40, -73],
    [40, -72.996],
  ]),
  100,
  "a valid single straight leg with no retracing should score clean",
);

assert(
  doublingBackRatio(noBacktrack) < 0.05,
  "simple open rectangle should not count as doubling back",
);
assert(
  doublingBackRatio(directOutAndBack) > 0.9,
  "direct return along the same line should be heavily penalized",
);
assert(
  doublingBackRatio(nearParallelReturn) > 0.8,
  "nearby parallel reverse return should be treated as doubling back",
);
assert(
  jaggedTurnRatio(broadGridShape) < 0.08,
  "a few broad grid turns should not be treated as jagged",
);
assert(
  jaggedTurnRatio(stairStepCurve) > jaggedTurnRatio(broadGridShape),
  "many short stair steps should be recognized as jagged",
);
assert(
  protrudingDetourRatio(noBacktrack) < 0.05,
  "a broad grid corner should not be treated as a protruding spur",
);
assert(
  protrudingDetourRatio(routeWithStickOut) > 0.2,
  "a short stick-out excursion should be treated as route clutter",
);
assert(
  routeQualityScore(noBacktrack) > routeQualityScore(directOutAndBack),
  "cleaner routes should score higher than out-and-back routes",
);
assert(
  routeQualityScore(broadGridShape) > routeQualityScore(stairStepCurve),
  "grid-native approximations should score higher than chiseled curves",
);
assert(
  routeQualityScore(noBacktrack) > routeQualityScore(routeWithStickOut),
  "clean grid routes should score higher than routes with stick-out excursions",
);

console.log("routeQuality tests ok");
