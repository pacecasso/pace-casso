import assert from "node:assert";
import { cleanLineArt, cleanRoutes, MAX_LINE_ART_B64 } from "./drawJob";

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

// cleanLineArt: only a PNG data URL under the size cap is kept
assert.strictEqual(cleanLineArt("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
assert.strictEqual(cleanLineArt("data:text/html;base64,PHNjcmlwdD4="), null, "not a PNG");
assert.strictEqual(cleanLineArt(42), null, "not a string");
assert.strictEqual(cleanLineArt("data:image/png;base64," + "A".repeat(MAX_LINE_ART_B64)), null, "too big");

console.log("drawJob.test.ts OK");
