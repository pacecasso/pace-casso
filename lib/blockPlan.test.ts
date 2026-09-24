import assert from "node:assert";
import { blockPlan, cellRings, filledMask, maskComponents, erodeMask, dilateMask } from "./blockPlan";

const ON = 255;
const W = 120;
const H = 120;

function blank(): Uint8Array {
  return new Uint8Array(W * H);
}
function rect(m: Uint8Array, x0: number, y0: number, x1: number, y1: number, v = ON): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * W + x] = v;
}
function ringOutline(m: Uint8Array, x0: number, y0: number, x1: number, y1: number, t: number): void {
  rect(m, x0, y0, x1, y0 + t);
  rect(m, x0, y1 - t, x1, y1);
  rect(m, x0, y0, x0 + t, y1);
  rect(m, x1 - t, y0, x1, y1);
}

// --- rings walk cell grids into rectilinear loops
{
  const cells = new Uint8Array(4 * 4);
  for (let y = 1; y <= 2; y++) for (let x = 1; x <= 2; x++) cells[y * 4 + x] = 1;
  const rings = cellRings(cells, 4, 4);
  assert.equal(rings.length, 1, "one square gives one ring");
  assert.equal(rings[0]!.length, 4, "a square keeps exactly four corners");
}

// --- a solid blob becomes a blocky outline, no centre lines
{
  const m = blank();
  rect(m, 30, 30, 90, 90);
  const plan = blockPlan(m, W, H, { cols: 12, aspect: 1 });
  assert.equal(plan.lineArt, false, "a solid square is not line art");
  assert.ok(plan.parts >= 1, "the square is one mass part");
  assert.ok(plan.strokes.some((s) => s.kind === "outline"), "mass is drawn as an outline");
  // a blocky outline may round outward by up to one cell past the ink's box
  assert.ok(plan.strokes.every((s) => s.pts.every(([x, y]) => Math.abs(x) <= 1.2 && Math.abs(y) <= 1.2)),
    "unit space matches makePlan (within a cell of the ink box)");
}

// --- an outline DRAWING is detected and drawn as centre lines, never blockified
{
  const m = blank();
  ringOutline(m, 25, 25, 95, 95, 1);
  const plan = blockPlan(m, W, H, { cols: 14, aspect: 1 });
  assert.equal(plan.lineArt, true, "a thin outline drawing is line art");
  assert.ok(plan.strokes.length > 0 && plan.strokes.every((s) => s.kind === "thin"),
    "line art is all centre lines");
}

// --- a thin GAP splits one shape into two parts (the Stones tongue case)
{
  const m = blank();
  rect(m, 20, 20, 100, 100);
  rect(m, 20, 58, 100, 60, 0); // a 3 px gap across the middle
  const plan = blockPlan(m, W, H, { cols: 16, aspect: 1 });
  assert.ok(plan.parts >= 2, `a hairline gap must separate the parts, got ${plan.parts}`);
}

// --- thin ink inside a shape survives as its own centre line (the gas hose)
{
  const m = blank();
  rect(m, 20, 20, 60, 100); // body
  rect(m, 60, 56, 105, 56); // a 1 px tail: thinner than one block cell
  const plan = blockPlan(m, W, H, { cols: 16, aspect: 1 });
  assert.ok(plan.strokes.some((s) => s.kind === "thin"), "the thin tail is kept as a centre line");
  assert.ok(plan.strokes.some((s) => s.kind === "outline"), "the body is still a mass outline");
}

// --- morphology helpers
{
  const m = blank();
  rect(m, 50, 50, 70, 70);
  const eroded = erodeMask(m, W, H, 2);
  const dilated = dilateMask(m, W, H, 2);
  const count = (x: Uint8Array) => x.reduce((a, v) => a + (v === ON ? 1 : 0), 0);
  assert.ok(count(eroded) < count(m) && count(m) < count(dilated), "erode shrinks, dilate grows");
  assert.equal(maskComponents(m, W, H).length, 1, "one square is one component");
}

// --- fill marks enclosed holes as inside
{
  const m = blank();
  ringOutline(m, 30, 30, 90, 90, 2);
  const f = filledMask(m, W, H);
  assert.equal(f[60 * W + 60], ON, "the hole inside a ring counts as inside");
  assert.equal(f[5 * W + 5], 0, "outside stays outside");
}

// --- empty input is handled
{
  const plan = blockPlan(blank(), W, H, {});
  assert.deepEqual(plan.strokes, [], "an empty mask plans nothing");
}

console.log("blockPlan tests passed");
