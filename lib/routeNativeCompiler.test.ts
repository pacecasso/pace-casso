import assert from "node:assert/strict";
import {
  buildRouteNativeSubjectProfile,
  isRunnableRouteNativeCandidate,
  orderRouteNativeCandidates,
  routeNativeContinuityStats,
  routeNativeFeatureCoverage,
  scoreRouteNativeCandidate,
} from "./routeNativeCompiler";
import { curatedSneakerManhattanMapNativeCandidate } from "./curatedSneakerManhattanRoute";

const sneakerFeatures = ["sneaker", "shoe", "laces", "sole", "toe", "heel"];
const sneakerProfile = buildRouteNativeSubjectProfile(sneakerFeatures);
assert.equal(sneakerProfile.complexity, "detailed");
assert.equal(sneakerProfile.maxKm, 35);
assert(sneakerProfile.minDirectGridPoints >= 200);

const sneaker = curatedSneakerManhattanMapNativeCandidate();
const sneakerScore = scoreRouteNativeCandidate(sneaker, sneakerFeatures);
assert(
  sneakerScore.score >= 85,
  `known sneaker should score as a strong route-native candidate, got ${sneakerScore.score}`,
);
assert.equal(sneakerScore.runnableDirectGrid, true);
assert.equal(isRunnableRouteNativeCandidate(sneaker, sneakerFeatures), true);

const sparseFake = {
  ...sneaker,
  anchors: sneaker.anchors.slice(0, 8),
  km: 3.2,
  designIntent: "Generic shoe outline with laces and sole",
};
const sparseScore = scoreRouteNativeCandidate(sparseFake, sneakerFeatures);
assert.equal(isRunnableRouteNativeCandidate(sparseFake, sneakerFeatures), false);
assert(
  sneakerScore.score > sparseScore.score + 20,
  `dense routed sneaker should beat sparse fake by a wide margin (${sneakerScore.score} vs ${sparseScore.score})`,
);

assert(
  routeNativeFeatureCoverage("low top sneaker shoe with lace comb, long sole, toe panel, and heel", sneakerFeatures) >= 95,
  "explicit sneaker/shoe/lace/sole/toe/heel text should get near-complete coverage",
);
assert(
  routeNativeFeatureCoverage("shoe outline only", sneakerFeatures) < 50,
  "missing laces/sole/toe/heel should not get high semantic coverage",
);

const discontinuous = {
  ...sneaker,
  anchors: [sneaker.anchors[0]!, [40.85, -73.96] as [number, number], sneaker.anchors[1]!],
};
const stats = routeNativeContinuityStats(discontinuous.anchors);
assert(stats.maxHopMeters > 300, "forced jump should be visible in continuity stats");
assert.equal(isRunnableRouteNativeCandidate(discontinuous, sneakerFeatures), false);

const ordered = orderRouteNativeCandidates([sparseFake, sneaker], sneakerFeatures);
assert.equal(ordered[0], sneaker, "route-native ordering should put the recognizable runnable sneaker first");

console.log("routeNativeCompiler tests ok");