import assert from "node:assert/strict";
import {
  buildSketchReviewOptions,
  cleanSketchPoints,
  deleteSketchPoint,
  insertSketchPoint,
  moveSketchPoint,
  simplifySketchPreservingComponents,
  simplifySketchToMaxPoints,
  smoothSketchPath,
  splitSketchComponents,
} from "./sketchReview";

const noisyLine = Array.from({ length: 80 }, (_, i) => ({
  x: i / 79,
  y: 0.5 + Math.sin(i / 4) * 0.05,
}));

const cleaned = cleanSketchPoints([
  { x: -1, y: 2 },
  { x: 0.001, y: 0.999 },
  { x: 0.5, y: 0.5 },
]);
assert.deepEqual(
  cleaned[0],
  { x: 0, y: 1 },
  "cleaning should clamp imported sketch points into the normalized canvas",
);
assert.equal(
  cleaned.length,
  2,
  "cleaning should drop nearly duplicate points so the editor starts sane",
);

const simplified = simplifySketchToMaxPoints(noisyLine, 16);
assert(
  simplified.length <= 16,
  "sketch simplification should create a compact editable path",
);
assert.deepEqual(
  simplified[0],
  noisyLine[0],
  "simplification should preserve the first point",
);
assert.deepEqual(
  simplified[simplified.length - 1],
  noisyLine[noisyLine.length - 1],
  "simplification should preserve the final point",
);

const smoothed = smoothSketchPath(
  [
    { x: 0, y: 0 },
    { x: 0.5, y: 1 },
    { x: 1, y: 0 },
  ],
  1,
);
assert(smoothed[1]!.y < 1, "smoothing should soften sharp single-point spikes");

const options = buildSketchReviewOptions(noisyLine);
assert.equal(options.length, 4, "review should offer multiple sketch choices");
assert(
  options.every((option) => option.points.length >= 2),
  "every sketch choice must be routable as a line",
);
assert(
  options[0]!.points.length >= options[options.length - 1]!.points.length,
  "later sketch choices should be more simplified than the first option",
);

const moved = moveSketchPoint(noisyLine, 4, { x: 2, y: -1 });
assert.deepEqual(
  moved[4],
  { x: 1, y: 0 },
  "dragged sketch points should stay inside the normalized drawing area",
);

const inserted = insertSketchPoint(
  [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ],
  null,
);
assert.deepEqual(
  inserted.points,
  [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 1, y: 0 },
  ],
  "insert should add a midpoint on the longest segment",
);
assert.equal(inserted.selectedIndex, 1);

const deleted = deleteSketchPoint(inserted.points, inserted.selectedIndex);
assert.deepEqual(
  deleted.points,
  [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ],
  "delete should remove the selected point without changing the remaining path",
);

// --- component-aware simplification (multi-component logo uploads) --------
// Two dense circles far apart, joined by one long pen-jump connector — the
// shape of a traced logo (symbol + letter). The old global budget collapsed
// both into a few segments; component-aware simplification must keep BOTH
// pieces recognizable and never spend one piece's budget on the other.
{
  const circle = (cx: number, cy: number, r: number): { x: number; y: number }[] =>
    Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * 2 * Math.PI;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
  const twoShapes = [...circle(0.2, 0.2, 0.14), ...circle(0.75, 0.75, 0.14)];

  const components = splitSketchComponents(twoShapes);
  assert.equal(components.length, 2, "pen jump should split into 2 components");

  const simplified = simplifySketchPreservingComponents(twoShapes, 40);
  const simplifiedComponents = splitSketchComponents(simplified);
  assert.equal(
    simplifiedComponents.length,
    2,
    "simplification must preserve both components",
  );
  for (const comp of simplifiedComponents) {
    assert.ok(
      comp.length >= 6,
      `each component keeps at least 6 points, got ${comp.length}`,
    );
  }

  // A single shape must fall through to the plain simplifier unchanged.
  const one = simplifySketchPreservingComponents(circle(0.5, 0.5, 0.3), 20);
  assert.ok(one.length <= 20, "single component honors the global budget");

  // Review options for multi-component art scale their budgets up: the
  // "readable" variant must keep far more than the single-shape 72 cap
  // would after collapsing (i.e. both circles survive).
  const options = buildSketchReviewOptions(twoShapes);
  const readable = options.find((o) => o.id === "readable")!;
  assert.equal(
    splitSketchComponents(readable.points).length,
    2,
    "readable variant keeps both components",
  );
}

// --- corner-dense lockups whose letters FUSE into one component -----------
// The N-PHASE2 regression (July 21): a traced "swoosh + JUST DO IT" whose
// pen hops between ADJACENT letters are shorter than the connector
// threshold, so component counting sees ~2 pieces instead of ~10 and the
// old component-scaled budget (72-84 points) mushed every letter. Corner
// density is the signal that survives fusion: outline letters are corner
// factories. The readable variant must keep every letter corner.
{
  const step = 0.004;
  // A dense outline "letter" shaped like a plus sign: 12 sharp corners.
  const plusLetter = (cx: number, cy: number, s: number): { x: number; y: number }[] => {
    const corners: [number, number][] = [
      [-1, -3], [1, -3], [1, -1], [3, -1], [3, 1], [1, 1],
      [1, 3], [-1, 3], [-1, 1], [-3, 1], [-3, -1], [-1, -1],
    ];
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= corners.length; i++) {
      const [ax, ay] = corners[i % corners.length]!;
      const [bx, by] = corners[(i + 1) % corners.length]!;
      const segLen = Math.hypot(bx - ax, by - ay) * s;
      const n = Math.max(1, Math.round(segLen / step));
      for (let k = 0; k < n; k++) {
        pts.push({
          x: cx + (ax + ((bx - ax) * k) / n) * s,
          y: cy + (ay + ((by - ay) * k) / n) * s,
        });
      }
    }
    return pts;
  };
  const letters: { x: number; y: number }[] = [];
  const cornerTruth: { x: number; y: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const cx = 0.08 + i * 0.115;
    const cy = 0.7;
    letters.push(...plusLetter(cx, cy, 0.014));
    for (const [ax, ay] of [
      [-1, -3], [1, -3], [1, -1], [3, -1], [3, 1], [1, 1],
      [1, 3], [-1, 3], [-1, 1], [-3, 1], [-3, -1], [-1, -1],
    ] as [number, number][]) {
      cornerTruth.push({ x: cx + ax * 0.014, y: cy + ay * 0.014 });
    }
  }

  const fusedComponents = splitSketchComponents(cleanSketchPoints(letters));
  assert.ok(
    fusedComponents.length <= 3,
    `precondition: adjacent-letter hops must fuse (got ${fusedComponents.length} components)`,
  );

  const options = buildSketchReviewOptions(letters);
  const readable = options.find((o) => o.id === "readable")!;
  assert.ok(
    readable.points.length >= 120,
    `letter-dense trace needs a large readable budget, got ${readable.points.length}`,
  );
  let kept = 0;
  for (const c of cornerTruth) {
    if (readable.points.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < 0.012)) kept++;
  }
  assert.ok(
    kept >= cornerTruth.length * 0.9,
    `readable must keep the letter corners: ${kept}/${cornerTruth.length}`,
  );
}

// --- spike tips: 1-point components between two connectors ---------------
// The swoosh tail simplifies to heel -> TIP -> heel: one far point between
// two connector-length segments. splitSketchComponents used to discard
// 1-point components, silently amputating the tail from every variant.
{
  const ring = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * 2 * Math.PI;
    return { x: 0.2 + 0.08 * Math.cos(a), y: 0.4 + 0.08 * Math.sin(a) };
  });
  const withTip = [...ring.slice(0, 12), { x: 0.86, y: 0.25 }, ...ring.slice(12)];
  const comps = splitSketchComponents(withTip);
  const tipComp = comps.find(
    (c) => c.length === 1 && Math.hypot(c[0]!.x - 0.86, c[0]!.y - 0.25) < 0.01,
  );
  assert.ok(tipComp, "the spike tip must survive as its own component");
  const readable = buildSketchReviewOptions(withTip).find((o) => o.id === "readable")!;
  assert.ok(
    readable.points.some((p) => Math.hypot(p.x - 0.86, p.y - 0.25) < 0.01),
    "readable variant keeps the spike tip",
  );
}

console.log("sketchReview tests ok");
