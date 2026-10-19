import assert from "node:assert";
import { cleanRoutes } from "./drawJob";

// cleanRoutes: what the worker posts back is trusted only inside the NYC box
const inside: [number, number] = [40.7, -73.95];
const outside: [number, number] = [51.5, -0.12];
const cleaned = cleanRoutes([{ km: 12.3, points: [inside, outside, [40.71, -73.96]] }]);
assert.strictEqual(cleaned.length, 1);
assert.strictEqual(cleaned[0]!.km, 12.3);
assert.strictEqual(cleaned[0]!.points.length, 2, "the London point is dropped");
assert.deepStrictEqual(cleanRoutes("nope"), [], "non-array -> empty");
assert.deepStrictEqual(cleanRoutes([{ km: 1, points: [inside] }]), [], "a one-point route is not a route");
assert.strictEqual(cleanRoutes(Array(5).fill({ km: 1, points: [inside, inside] })).length, 3, "at most three drafts");
const labeled = cleanRoutes([
  { km: 1, points: [inside, inside], label: "pick" },
  { km: 1, points: [inside, inside], label: "short" },
  { km: 1, points: [inside, inside], label: "bogus" },
]);
assert.deepStrictEqual(labeled.map((r) => r.label), ["pick", "short", undefined], "only known labels survive");

console.log("drawJob.test.ts OK");
