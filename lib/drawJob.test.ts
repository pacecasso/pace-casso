import assert from "node:assert";
import { cleanLineArt, cleanLineArts, cleanRoutes, MAX_LINE_ART_B64, MAX_LINE_ARTS } from "./drawJob";

// cleanRoutes: what the worker posts back is trusted only inside the NYC box
const inside: [number, number] = [40.7, -73.95];
const outside: [number, number] = [51.5, -0.12];
const cleaned = cleanRoutes([{ km: 12.3, points: [inside, outside, [40.71, -73.96]] }]);
assert.strictEqual(cleaned.length, 1);
assert.strictEqual(cleaned[0]!.km, 12.3);
assert.strictEqual(cleaned[0]!.points.length, 2, "the London point is dropped");
assert.deepStrictEqual(cleanRoutes("nope"), [], "non-array -> empty");
assert.deepStrictEqual(cleanRoutes([{ km: 1, points: [inside] }]), [], "a one-point route is not a route");
assert.strictEqual(cleanRoutes(Array(8).fill({ km: 1, points: [inside, inside] })).length, 5, "at most five versions");
const labeled = cleanRoutes([
  { km: 1, points: [inside, inside], label: "pick" },
  { km: 1, points: [inside, inside], label: "short" },
  { km: 1, points: [inside, inside], label: "bogus" },
  { km: 1, points: [inside, inside], label: "mark" },
]);
assert.deepStrictEqual(labeled.map((r) => r.label), ["pick", "short", undefined, "mark"], "only known labels survive");
// the match score the page sorts by: a finite number kept inside 0..1, anything else dropped
const scored = cleanRoutes([
  { km: 1, points: [inside, inside], score: 0.8524 },
  { km: 1, points: [inside, inside], score: 7 },
  { km: 1, points: [inside, inside], score: -0.2 },
  { km: 1, points: [inside, inside], score: "0.9" },
  { km: 1, points: [inside, inside], score: Number.NaN },
]);
assert.deepStrictEqual(scored.map((r) => r.score), [0.852, 1, 0, undefined, undefined]);
assert.ok(!("score" in cleaned[0]!), "a job from the old engine has no score");

// cleanLineArt: only a PNG data URL under the size cap is kept
assert.strictEqual(cleanLineArt("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
assert.strictEqual(cleanLineArt("data:text/html;base64,PHNjcmlwdD4="), null, "not a PNG");
assert.strictEqual(cleanLineArt(42), null, "not a string");
assert.strictEqual(cleanLineArt("data:image/png;base64," + "A".repeat(MAX_LINE_ART_B64)), null, "too big");

// cleanLineArts: the drawings to choose from, the one shown first at the front
const png = (s: string) => `data:image/png;base64,${s}`;
assert.deepStrictEqual(cleanLineArts(png("AAAA"), [png("AAAA"), png("BBBB")]), [png("AAAA"), png("BBBB")], "the first is not repeated");
assert.deepStrictEqual(cleanLineArts(png("AAAA"), undefined), [png("AAAA")], "an older worker posts no list");
assert.deepStrictEqual(cleanLineArts(png("AAAA"), [42, "data:text/html;base64,PHNjcmlwdD4=", png("BBBB")]), [png("AAAA"), png("BBBB")], "bad entries are dropped");
assert.deepStrictEqual(cleanLineArts(null, [png("BBBB")]), [], "no first drawing, no choices");
assert.strictEqual(cleanLineArts(png("A"), ["B", "C", "D", "E", "F"].map(png)).length, MAX_LINE_ARTS, "capped");

console.log("drawJob.test.ts OK");
