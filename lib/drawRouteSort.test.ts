import assert from "node:assert";
import { pickIndex, rankDrawRoutes, routesScored, sortDrawRoutes } from "./drawRouteSort";

// the Nov 9 rocket as the engine delivered it: five sizes, each with a match score
const rocket = [
  { km: 10.5, score: 0.852 },
  { km: 43.6, score: 0.794 },
  { km: 18.6, score: 0.78 },
  { km: 35.6, score: 0.77 },
  { km: 20.8, score: 0.726 },
];
assert.ok(routesScored(rocket));
const ranked = rankDrawRoutes(rocket);
assert.deepStrictEqual(ranked.map((r) => r.route.km), [10.5, 43.6, 18.6, 35.6, 20.8], "best match first");
assert.deepStrictEqual(ranked.map((r) => r.rank), [0, 1, 2, 3, 4]);

const byKm = sortDrawRoutes(ranked, "distance");
assert.deepStrictEqual(byKm.map((r) => r.route.km), [10.5, 18.6, 20.8, 35.6, 43.6], "shortest first");
assert.deepStrictEqual(byKm.map((r) => r.rank), [0, 2, 4, 3, 1], "a card keeps its best-match rank when sorted by distance");
assert.deepStrictEqual(sortDrawRoutes(byKm, "best").map((r) => r.route.km), [10.5, 43.6, 18.6, 35.6, 20.8], "and back");
assert.deepStrictEqual(ranked.map((r) => r.route.km), [10.5, 43.6, 18.6, 35.6, 20.8], "sorting does not reorder its input");

// delivered out of order: the score decides, not the position
const shuffled = rankDrawRoutes([{ km: 20, score: 0.5 }, { km: 9, score: 0.9 }, { km: 30, score: 0.7 }]);
assert.deepStrictEqual(shuffled.map((r) => r.route.km), [9, 30, 20]);
assert.deepStrictEqual(shuffled.map((r) => r.index), [1, 2, 0], "index is the delivered position");

// equal scores and equal distances fall back to a stable order
const ties = rankDrawRoutes([{ km: 12, score: 0.8 }, { km: 12, score: 0.8 }]);
assert.deepStrictEqual(ties.map((r) => r.index), [0, 1]);
assert.deepStrictEqual(sortDrawRoutes(ties, "distance").map((r) => r.index), [0, 1]);

// a job from before Nov 9: no scores, so the delivered order ("Our pick" first) is the ranking
const old = [{ km: 44.9, label: "pick" }, { km: 20.8, label: "short" }];
assert.ok(!routesScored(old));
assert.deepStrictEqual(rankDrawRoutes(old).map((r) => r.route.label), ["pick", "short"]);
assert.deepStrictEqual(sortDrawRoutes(rankDrawRoutes(old), "distance").map((r) => r.route.label), ["short", "pick"]);
// one route missing its score makes the whole job unscored rather than half-ranked
assert.ok(!routesScored([{ km: 1, score: 0.9 }, { km: 2 }]));
assert.deepStrictEqual(rankDrawRoutes([{ km: 1 }, { km: 2, score: 0.9 }]).map((r) => r.route.km), [1, 2]);

assert.ok(!routesScored([]));
assert.deepStrictEqual(rankDrawRoutes([]), []);

// the star: the best match of 25 km or less (the Nov 11 lighthouse: the whole
// name scored best at 50 km, the picture with its initial was the one to run)
const logo = rankDrawRoutes([
  { km: 50.0, score: 0.9 },
  { km: 45.1, score: 0.85 },
  { km: 23.0, score: 0.75 },
  { km: 21.2, score: 0.81 },
]);
assert.strictEqual(pickIndex(logo), 3, "best match under 25 km");
assert.deepStrictEqual(sortDrawRoutes(logo, "best", pickIndex(logo)).map((r) => r.route.km), [21.2, 50.0, 45.1, 23.0], "the star leads");
assert.deepStrictEqual(sortDrawRoutes(logo, "distance", pickIndex(logo)).map((r) => r.route.km), [21.2, 23.0, 45.1, 50.0]);
assert.strictEqual(pickIndex(ranked), 0, "the best match is short enough: it keeps the star");
assert.strictEqual(pickIndex(rankDrawRoutes([{ km: 40, score: 0.7 }, { km: 30, score: 0.9 }])), 1, "nothing under 25 km: best match");
assert.strictEqual(pickIndex(rankDrawRoutes(old)), null, "older jobs star their own pick");
assert.strictEqual(pickIndex([]), null);

console.log("drawRouteSort.test.ts OK");
