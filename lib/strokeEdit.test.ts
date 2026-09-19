/**
 * npx tsx lib/strokeEdit.test.ts
 *
 * The operations behind the edit step: drop, add, replace, cut, sequence, plus
 * the two guards (tiny strokes never reach the router; a finger path becomes a
 * clean unit-space stroke). These are the moves that produced the gas and
 * unicorn routes Ralph approved.
 */
import assert from "node:assert";
import {
  applyStrokeEdits,
  cloneStrokeList,
  cutStroke,
  dropTinyStrokes,
  nearestVertex,
  strokeFromCanvasPath,
  strokeLength,
  type StrokeEdit,
} from "./strokeEdit";
import type { Stroke, UnitPt } from "./strokePainter";

const ring = (cx: number, cy: number, r: number, n = 12): Stroke => {
  const pts: UnitPt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts.push([pts[0]![0], pts[0]![1]]);
  return { kind: "outline", closed: true, pts, group: 0 };
};
const line = (x0: number, y0: number, x1: number, y1: number, n = 6): Stroke => {
  const pts: UnitPt[] = [];
  for (let i = 0; i <= n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  return { kind: "thin", closed: false, pts };
};

// ---------------------------------------------------------------------------
// the edits never mutate what they were given
// ---------------------------------------------------------------------------
{
  const original = [ring(0, 0, 0.5), line(-0.5, -0.5, 0.5, -0.5)];
  const snapshot = JSON.stringify(original);
  applyStrokeEdits(original, [{ op: "drop", index: 0 }, { op: "add", stroke: line(0, 0, 0.2, 0.2) }]);
  assert.equal(JSON.stringify(original), snapshot, "applyStrokeEdits does not mutate its input");

  const copy = cloneStrokeList(original);
  copy[0]!.pts[0] = [9, 9];
  assert.notDeepEqual(original[0]!.pts[0], [9, 9], "cloneStrokeList makes a deep copy");
}

// ---------------------------------------------------------------------------
// drop / add / replace
// ---------------------------------------------------------------------------
{
  const s = [ring(0, 0, 0.5), line(-0.5, -0.5, 0.5, -0.5), line(0, 0, 0, 0.5)];

  assert.equal(applyStrokeEdits(s, [{ op: "drop", index: 1 }]).length, 2, "drop removes one stroke");
  assert.equal(
    applyStrokeEdits(s, [{ op: "drop", index: 1 }])[1]!.pts[0]![1],
    0,
    "drop removes the RIGHT stroke",
  );
  assert.equal(applyStrokeEdits(s, [{ op: "drop", index: 99 }]).length, 3, "an out-of-range drop is ignored");
  assert.equal(applyStrokeEdits(s, [{ op: "drop", index: -1 }]).length, 3, "a negative drop is ignored");

  // the gas edit: drop one, add two
  const gasLike: StrokeEdit[] = [
    { op: "drop", index: 2 },
    { op: "add", stroke: line(-0.2, 0.1, 0.2, 0.1) },
    { op: "add", stroke: ring(0.3, 0.3, 0.1) },
  ];
  assert.equal(applyStrokeEdits(s, gasLike).length, 4, "drop 1 + add 2 leaves four strokes");

  // indices refer to the list as it is when that edit runs
  const seq = applyStrokeEdits(s, [{ op: "drop", index: 0 }, { op: "drop", index: 0 }]);
  assert.equal(seq.length, 1, "two drops at index 0 remove two different strokes");
  assert.equal(seq[0]!.pts[0]![1], 0, "the remaining stroke is the third one");

  const degenerate = applyStrokeEdits(s, [{ op: "add", stroke: { kind: "thin", closed: false, pts: [[0, 0]] } }]);
  assert.equal(degenerate.length, 3, "a one-point stroke is not added");

  const replaced = applyStrokeEdits(s, [{ op: "replace", index: 0, stroke: line(1, 1, 0, 0) }]);
  assert.equal(replaced.length, 3, "replace keeps the count");
  assert.equal(replaced[0]!.closed, false, "replace swaps the stroke");
}

// ---------------------------------------------------------------------------
// cut
// ---------------------------------------------------------------------------
{
  const r = ring(0, 0, 1, 12);
  const pieces = cutStroke(r, [[1, 0], [-1, 0]]);
  assert.equal(pieces.length, 2, "cutting a ring at two points gives two arcs");
  for (const p of pieces) assert.equal(p.closed, false, "an arc is open");
  // between them the arcs cover the ring, with the two cut vertices shared
  const total = pieces.reduce((a, p) => a + p.pts.length, 0);
  assert.equal(total, r.pts.length - 1 + 2, "the two arcs together cover the ring, sharing the cut points");

  // both cuts at the same vertex is not a cut
  assert.equal(cutStroke(r, [[1, 0], [1, 0]])!.length, 1, "cutting at one point leaves the ring whole");

  // a cut that would leave a two-point stub gives back just the real arc
  const stubbed = cutStroke(ring(0, 0, 1, 12), [[1, 0], [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]]);
  assert.ok(stubbed.length >= 1, "a near-adjacent cut still returns something drawable");
  for (const p of stubbed) assert.ok(p.pts.length >= 3, "no two-point stubs are produced");

  // an open stroke splits in two at the given point
  const openPieces = cutStroke(line(-1, 0, 1, 0, 8), [[0, 0], [0, 0]]);
  assert.equal(openPieces.length, 2, "an open stroke cuts into two");
  assert.ok(openPieces[0]!.pts.length >= 2 && openPieces[1]!.pts.length >= 2, "both halves are drawable");

  // cutting at an endpoint cannot make an empty piece
  assert.equal(cutStroke(line(-1, 0, 1, 0, 8), [[-1, 0], [-1, 0]])!.length, 1, "cutting at an endpoint is a no-op");

  // too few points to cut
  assert.equal(cutStroke({ kind: "thin", closed: false, pts: [[0, 0], [1, 1]] }, [[0, 0], [1, 1]]).length, 1, "a two-point stroke is not cut");

  // via applyStrokeEdits the pieces land in place of the original
  const list = [line(-1, -1, 1, -1), ring(0, 0, 1, 12)];
  const afterCut = applyStrokeEdits(list, [{ op: "cut", index: 1, at: [[1, 0], [-1, 0]] }]);
  assert.equal(afterCut.length, 3, "cut replaces one stroke with its pieces");
  assert.equal(afterCut[0]!.closed, false, "the untouched stroke keeps its place first");
}

// ---------------------------------------------------------------------------
// sequence
// ---------------------------------------------------------------------------
{
  const s = [line(0, 0, 1, 0), line(0, 1, 1, 1), line(0, 2, 1, 2)];
  const reordered = applyStrokeEdits(s, [{ op: "sequence", order: [2, 0, 1] }]);
  assert.equal(reordered.length, 3, "sequence keeps every stroke");
  assert.equal(reordered[0]!.pts[0]![1], 2, "sequence puts the requested stroke first");
  assert.equal(reordered[2]!.pts[0]![1], 1, "and the rest follow the order");

  // a partial order keeps the forgotten strokes rather than dropping them
  const partial = applyStrokeEdits(s, [{ op: "sequence", order: [2] }]);
  assert.equal(partial.length, 3, "a partial order drops nothing");
  assert.equal(partial[0]!.pts[0]![1], 2, "the named stroke comes first");

  // repeats and out-of-range entries are ignored, not duplicated
  const messy = applyStrokeEdits(s, [{ op: "sequence", order: [1, 1, 99, -3, 0] }]);
  assert.equal(messy.length, 3, "a messy order still yields each stroke once");
  const ys = messy.map((k) => k.pts[0]![1]).sort();
  assert.deepEqual(ys, [0, 1, 2], "every stroke survives exactly once");
}

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------
{
  assert.equal(nearestVertex([[0, 0], [1, 0], [2, 0]], [1.9, 0.2]), 2, "nearestVertex finds the closest point");

  const long = line(-1, 0, 1, 0);
  const tiny = line(0, 0, 0.01, 0);
  assert.ok(Math.abs(strokeLength(long) - 2) < 1e-9, "an open stroke measures its length");
  assert.ok(Math.abs(strokeLength(ring(0, 0, 1, 360)) - 2 * Math.PI) < 0.01, "a ring measures its perimeter");

  // at 1500 m per unit, a 0.01-unit tap is 15 m - well under a block
  const kept = dropTinyStrokes([long, tiny], 1500, 250);
  assert.equal(kept.length, 1, "a stray tap never reaches the router");
  assert.equal(kept[0]!.pts.length, long.pts.length, "the real stroke is the one kept");
  assert.equal(dropTinyStrokes([long, tiny], 1500, 0).length, 2, "a zero threshold keeps everything");
}

{
  // a finger path in canvas pixels becomes a unit-space stroke
  const s = strokeFromCanvasPath([[0, 0], [320, 0], [320, 320], [0, 320]], 320);
  assert.equal(s.closed, false, "an open path stays open");
  assert.deepEqual(s.pts[0], [-1, 1], "the top-left pixel maps to the top-left of unit space");
  assert.deepEqual(s.pts[1], [1, 1], "x increases to the right");
  assert.deepEqual(s.pts[2], [1, -1], "y is flipped: canvas down is unit-space down");

  // jitter on one spot collapses
  const jittery = strokeFromCanvasPath(
    [[10, 10], [10, 10], [11, 10], [10, 11], [300, 300]],
    320,
  );
  assert.ok(jittery.pts.length <= 3, `finger jitter is thinned (got ${jittery.pts.length} points)`);

  const closed = strokeFromCanvasPath([[0, 0], [320, 0], [320, 320]], 320, { closed: true });
  assert.equal(closed.closed, true, "a closed path is marked closed");
  assert.deepEqual(closed.pts[closed.pts.length - 1], closed.pts[0], "a closed path returns to its start");

  const grouped = strokeFromCanvasPath([[0, 0], [320, 320]], 320, { kind: "outline", group: 2 });
  assert.equal(grouped.kind, "outline", "kind is carried through");
  assert.equal(grouped.group, 2, "group is carried through");
  assert.equal(strokeFromCanvasPath([[0, 0], [320, 320]], 320).group, undefined, "no group unless asked");
}

console.log("strokeEdit tests passed");
