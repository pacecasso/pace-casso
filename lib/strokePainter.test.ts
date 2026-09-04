import assert from "node:assert";
import { filledMaskFromContour, makePlan, orderStrokes, relayout, localGridInfo, paintOnStreets, type PainterGraph } from "./strokePainter";
import { getStreetGraph } from "./streetGraphTrace";

function rect(mask: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * w + x] = 255;
}

// --- filledMaskFromContour: a closed square outline becomes a filled square
{
  const square = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
    { x: 0.2, y: 0.2 },
  ];
  const { mask, w } = filledMaskFromContour(square, 200);
  assert.strictEqual(mask[100 * w + 100], 255, "center of the square is filled");
  assert.strictEqual(mask[10 * w + 10], 0, "outside stays paper");
  let ink = 0;
  for (const v of mask) if (v) ink++;
  assert.ok(ink > 0.3 * w * w && ink < 0.45 * w * w, `filled area is about 36% of the canvas, got ${ink / (w * w)}`);
}

// --- makePlan: a solid slab yields one outline ring plus hatch rows, no thin strokes
{
  const w = 200;
  const h = 200;
  const mask = new Uint8Array(w * h);
  rect(mask, w, 40, 20, 160, 180);
  const plan = makePlan(mask, w, h, 1500, { pitchM: 160, rows: 3, openM: 60 });
  const outlines = plan.strokes.filter((s) => s.kind === "outline");
  const hatch = plan.strokes.filter((s) => s.kind === "hatch");
  const thin = plan.strokes.filter((s) => s.kind === "thin");
  assert.strictEqual(outlines.length, 1, "one outline ring");
  assert.ok(hatch.length >= 2 && hatch.length <= 4, `a few hatch rows, got ${hatch.length}`);
  assert.strictEqual(thin.length, 0, "no centerlines on a slab");
  assert.ok(outlines[0]!.closed, "outline is closed");
  // hatch rows are horizontal in unit space (they land on cross streets)
  for (const row of hatch) assert.ok(Math.abs(row.pts[0]![1] - row.pts[1]![1]) < 1e-9, "hatch row is horizontal");
}

// --- makePlan: a slab with a thin tail gives a centerline for the tail
{
  const w = 200;
  const h = 200;
  const mask = new Uint8Array(w * h);
  rect(mask, w, 30, 30, 120, 170);
  rect(mask, w, 120, 97, 190, 101); // 4 px tail = ~75 m at this scale -> thin
  const plan = makePlan(mask, w, h, 1500, { pitchM: 160, rows: 3, openM: 60 });
  assert.strictEqual(plan.strokes.filter((s) => s.kind === "outline").length, 1);
  assert.ok(plan.strokes.some((s) => s.kind === "thin"), "tail becomes a thin stroke");
}

// --- relayout: two blobs joined by a thin bar are two bodies with one link
{
  const w = 240;
  const h = 120;
  const mask = new Uint8Array(w * h);
  rect(mask, w, 10, 20, 90, 100);
  rect(mask, w, 150, 20, 230, 100);
  rect(mask, w, 90, 58, 150, 63);
  const keep = relayout(mask, w, h, "keep");
  assert.ok(keep, "relayout finds bodies");
  assert.strictEqual(keep!.bodies, 2);
  assert.strictEqual(keep!.links.length, 1, "the bar is a link");
  assert.strictEqual(keep!.w, w, "keep mode preserves the canvas");
  const stack = relayout(mask, w, h, "stack");
  assert.ok(stack && stack.h > h, "stacked canvas grows taller than the original");
  assert.strictEqual(stack!.links.length, 1, "link redrawn as an arc");
  const single = new Uint8Array(w * h);
  rect(single, w, 10, 20, 90, 100);
  assert.strictEqual(relayout(single, w, h, "stack"), null, "one body: nothing to re-lay");
}

// --- orderStrokes keeps every stroke and draws a body as one unit
{
  const w = 200;
  const h = 200;
  const mask = new Uint8Array(w * h);
  rect(mask, w, 40, 20, 160, 180);
  const plan = makePlan(mask, w, h, 1500, { pitchM: 160, rows: 3, openM: 60 });
  const ordered = orderStrokes(plan.strokes);
  assert.strictEqual(ordered.length, plan.strokes.length);
  assert.strictEqual(ordered[0]!.kind, "outline", "a body starts with its outline");
}

// --- on the real graph: the grid reads as Manhattan's and a heart seats and routes
(async () => {
  const g = (await getStreetGraph()) as unknown as PainterGraph;
  const info = localGridInfo(g, [40.755, -73.985]);
  assert.ok(info, "grid info at Midtown");
  assert.ok(Math.abs(info!.axis - 28) <= 3, `Midtown axis ~28 deg, got ${info!.axis}`);
  assert.ok(info!.uniform > 0.85, `Midtown is a uniform grid, got ${info!.uniform}`);

  const heart: { x: number; y: number }[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * 2 * Math.PI;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    heart.push({ x: 0.5 + x / 36, y: 0.5 - y / 36 });
  }
  const { mask, w, h } = filledMaskFromContour(heart, 240);
  const t0 = Date.now();
  const res = paintOnStreets(g, mask, w, h, {
    scales: [1300],
    latRange: [40.745, 40.76],
    lngRange: [-73.995, -73.975],
    picks: 1,
    timeBudgetMs: 40_000,
  });
  assert.ok(res.legalSeats > 0, "the heart has legal Midtown seats");
  const best = res.candidates[0];
  assert.ok(best, "a routed candidate");
  assert.ok(best!.chain.length > 50, "route has real street geometry");
  assert.ok(best!.dropped === 0, "no strokes dropped");
  assert.ok(best!.maxGap < 400, `no teleports (max gap ${best!.maxGap.toFixed(0)} m)`);
  assert.ok(best!.km > 8 && best!.km < 60, `plausible distance, got ${best!.km.toFixed(1)} km`);
  assert.ok(best!.devM < 60, `stays close to the intended strokes (dev ${best!.devM.toFixed(0)} m)`);
  console.log(`strokePainter tests passed (heart routed in ${Date.now() - t0} ms, ${best!.km.toFixed(1)} km)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
