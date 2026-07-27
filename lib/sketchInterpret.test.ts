import assert from "node:assert";
import {
  parsePrimitiveProgram,
  compilePrimitiveProgram,
  strokesToContour,
  guessMatchesSubject,
  MAX_PROGRAM_STROKES,
} from "./sketchInterpret";

// --- parse + validate ---------------------------------------------------------
{
  const ok = parsePrimitiveProgram({
    strokes: [
      {
        elements: [
          { type: "line", points: [[0, 0], [1000, 0], [1000, 1000]] },
          { type: "arc", cx: 500, cy: 500, r: 200, startDeg: 0, endDeg: 360 },
          { type: "bez", p0: [0, 0], c: [500, 800], p1: [1000, 0] },
        ],
      },
    ],
  });
  assert.ok(ok, "valid program parses");
  assert.strictEqual(ok!.strokes.length, 1);
  assert.strictEqual(ok!.strokes[0]!.elements.length, 3);

  assert.strictEqual(parsePrimitiveProgram(null), null);
  assert.strictEqual(parsePrimitiveProgram({ strokes: [] }), null);
  assert.strictEqual(
    parsePrimitiveProgram({ strokes: [{ elements: [{ type: "line", points: [[1, 2]] }] }] }),
    null,
    "a 1-point line is not a stroke",
  );

  // garbage fields are dropped, not crashed on
  const partial = parsePrimitiveProgram({
    strokes: [
      {
        elements: [
          { type: "arc", cx: "NaN", cy: 5, r: 10, startDeg: 0, endDeg: 90 },
          { type: "line", points: [[0, 0], [100, 100]] },
        ],
      },
    ],
  });
  assert.strictEqual(partial!.strokes[0]!.elements.length, 1, "invalid arc dropped");

  // stroke cap enforced
  const many = parsePrimitiveProgram({
    strokes: Array.from({ length: 9 }, () => ({
      elements: [{ type: "line", points: [[0, 0], [10, 10]] }],
    })),
  });
  assert.strictEqual(many!.strokes.length, MAX_PROGRAM_STROKES, "stroke cap");
}

// --- compile ---------------------------------------------------------------------
{
  const program = parsePrimitiveProgram({
    strokes: [
      { elements: [{ type: "arc", cx: 500, cy: 500, r: 400, startDeg: 0, endDeg: 360 }] },
      { elements: [{ type: "line", points: [[-500, 200], [1500, 200]] }] }, // out of range
    ],
  })!;
  const strokes = compilePrimitiveProgram(program);
  assert.strictEqual(strokes.length, 2);
  // circle closes on itself
  const c = strokes[0]!;
  const d = Math.hypot(c[0]![0] - c[c.length - 1]![0], c[0]![1] - c[c.length - 1]![1]);
  assert.ok(d < 2, "arc 0..360 closes");
  // clamped to 0..1000
  for (const p of strokes[1]!) {
    assert.ok(p[0] >= 0 && p[0] <= 1000, "x clamped");
  }
}

// --- strokesToContour ---------------------------------------------------------------
{
  const contour = strokesToContour([
    [[0, 0], [1000, 0]],
    [[0, 1000], [1000, 1000]],
  ]);
  assert.ok(contour.length > 100, "strokes densified for connector detection");
  for (const p of contour) {
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, "normalized 0..1");
  }
  // y-flip: shape-space y=1000 (top) -> normalized y=0
  const lastHalf = contour.slice(Math.floor(contour.length / 2));
  assert.ok(lastHalf.every((p) => p.y < 0.5), "second stroke (y-up 1000) maps to top (y-down ~0)");

  // cap respected
  const big = strokesToContour([Array.from({ length: 400 }, (_, i) => [i * 2.5, 0] as [number, number])], 100);
  assert.ok(big.length <= 110, `cap respected, got ${big.length}`);
}

// --- guessMatchesSubject ---------------------------------------------------------------
{
  assert.ok(guessMatchesSubject("a person at a gas pump", "gas pump"), "core token match");
  assert.ok(guessMatchesSubject("an elephant", "Elephant"), "case-insensitive");
  assert.ok(guessMatchesSubject("running dog", "dogs"), "plural-insensitive");
  assert.ok(!guessMatchesSubject("a martini glass", "a dog"), "no match");
  assert.ok(
    !guessMatchesSubject("a person at a gas pump", "running person"),
    "filler word 'person' alone does not count as recognition",
  );
  assert.ok(!guessMatchesSubject("the logo", "a logo"), "filler-only subjects never match");
}

console.log("sketchInterpret tests passed");
