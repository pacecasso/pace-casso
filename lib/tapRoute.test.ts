import assert from "node:assert";
import {
  EMPTY_TAP_ROUTE,
  addPoint,
  assembleLegs,
  closeLoop,
  distanceMarkers,
  insertPoint,
  isClosedLoop,
  joinLegs,
  legIndexAtAlong,
  legKey,
  lineLengthMeters,
  missingStreetLegs,
  movePoint,
  outAndBack,
  projectOntoLine,
  removeLastPoint,
  removePoint,
  reverseRoute,
  setLegMode,
  type LatLng,
  type LegGeometry,
} from "./tapRoute";

const A: LatLng = [40.75, -73.99];
const B: LatLng = [40.76, -73.99];
const C: LatLng = [40.76, -73.98];
const D: LatLng = [40.75, -73.98];

// add / remove keep one mode per leg
let s = addPoint(EMPTY_TAP_ROUTE, A, "streets");
assert.deepStrictEqual(s, { points: [A], modes: [] });
s = addPoint(s, B, "streets");
s = addPoint(s, C, "straight");
s = addPoint(s, D, "streets");
assert.strictEqual(s.points.length, 4);
assert.deepStrictEqual(s.modes, ["streets", "straight", "streets"]);
assert.strictEqual(addPoint(s, D, "streets"), s, "duplicate tap is a no-op");
assert.deepStrictEqual(removeLastPoint(s).modes, ["streets", "straight"]);

// remove a middle point: neighbours join, incoming mode kept
const r = removePoint(s, 2);
assert.deepStrictEqual(r.points, [A, B, D]);
assert.deepStrictEqual(r.modes, ["streets", "straight"]);
const r0 = removePoint(s, 0);
assert.deepStrictEqual(r0.points, [B, C, D]);
assert.deepStrictEqual(r0.modes, ["straight", "streets"]);

// insert inherits the split leg's mode
const mid: LatLng = [40.76, -73.985];
const ins = insertPoint(s, 1, mid);
assert.deepStrictEqual(ins.points, [A, B, mid, C, D]);
assert.deepStrictEqual(ins.modes, ["streets", "straight", "straight", "streets"]);
assert.strictEqual(insertPoint(s, 9, mid), s);

assert.deepStrictEqual(movePoint(s, 1, mid).points[1], mid);
assert.deepStrictEqual(setLegMode(s, 0, "straight").modes[0], "straight");

// reverse / out-and-back / loop
assert.deepStrictEqual(reverseRoute(s).points, [D, C, B, A]);
assert.deepStrictEqual(reverseRoute(s).modes, ["streets", "straight", "streets"]);
const oab = outAndBack(s);
assert.deepStrictEqual(oab.points, [A, B, C, D, C, B, A]);
assert.strictEqual(oab.modes.length, oab.points.length - 1);
assert.deepStrictEqual(oab.modes.slice(3), ["streets", "straight", "streets"]);
const loop = closeLoop(s, "streets");
assert.ok(isClosedLoop(loop));
assert.strictEqual(closeLoop(loop, "streets"), loop, "already closed");

// assemble: straight legs never pending; street legs pending until cached
const cache = new Map<string, LegGeometry>();
let legs = assembleLegs(s, cache);
assert.deepStrictEqual(legs.map((l) => l.pending), [true, false, true]);
assert.strictEqual(missingStreetLegs(s, cache).length, 2);
cache.set(legKey(A, B, "streets"), {
  coords: [[40.7501, -73.9901], [40.755, -73.99], [40.7599, -73.9899]],
  fallback: false,
});
legs = assembleLegs(s, cache);
assert.strictEqual(legs[0]!.pending, false);
assert.deepStrictEqual(legs[0]!.coords[0], A, "leg pinned to tapped start");
assert.deepStrictEqual(legs[0]!.coords[2], B, "leg pinned to tapped end");
assert.strictEqual(missingStreetLegs(s, cache).length, 1);

// out-and-back reuses no new keys for straight legs, and dedupes street keys
const loopy = { points: [A, B, A, B], modes: ["streets", "streets", "streets"] as const };
assert.strictEqual(
  missingStreetLegs({ points: loopy.points, modes: [...loopy.modes] }, new Map()).length,
  2,
);

// joined line + markers
const line = joinLegs(legs);
assert.deepStrictEqual(line[0], A);
assert.deepStrictEqual(line[line.length - 1], D);
const total = lineLengthMeters(line);
const marks = distanceMarkers(line, 1000);
assert.strictEqual(marks.length, Math.floor(total / 1000));
assert.deepStrictEqual(marks.map((m) => m.n), marks.map((_, i) => i + 1));
// marker 1 sits ~1000 m along
const p1 = projectOntoLine(line, marks[0]!.at)!;
assert.ok(Math.abs(p1.alongM - 1000) < 2, `marker at ${p1.alongM}`);
assert.ok(p1.offM < 0.5);

// projection + leg lookup
const probe: LatLng = [40.765, -73.985]; // north of the B→C leg
const pr = projectOntoLine(line, probe)!;
assert.ok(pr.offM > 400 && pr.offM < 700);
assert.strictEqual(legIndexAtAlong(legs, pr.alongM), 1);
assert.strictEqual(legIndexAtAlong(legs, 0), 0);
assert.strictEqual(legIndexAtAlong(legs, total + 50), 2);

console.log("tapRoute tests passed");
