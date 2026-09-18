import assert from "node:assert";
import { CENTRAL_PARK, combinedScore, featureCoverage, geoDraft, insidePolygon, makeRng, normRot, propose, rdp, trimClosingWalk, uprightRots, MANHATTAN_GEO_DEFAULTS, type State } from "./geoDraft";
import { HUG_TOL_M, TRACE, meters, type PainterGraph, type Routed } from "./strokePainter";
import { place, type LatLng } from "./streetGraphTrace";

// --- rotation helpers
assert.strictEqual(normRot(190), -170);
assert.strictEqual(normRot(-200), 160);
assert.deepStrictEqual(uprightRots(0, 40), [0]);
// Manhattan's grid leans ~29°: only the near-upright orientations survive
assert.deepStrictEqual(uprightRots(-29, 40), [-29]);
assert.deepStrictEqual(uprightRots(60, 40), [-30]);

// --- Central Park test polygon: Bethesda Terrace is inside, Times Square is not
assert.ok(insidePolygon([40.7741, -73.9713], CENTRAL_PARK));
assert.ok(!insidePolygon([40.758, -73.9855], CENTRAL_PARK));

// --- rdp keeps endpoints and drops collinear points
assert.deepStrictEqual(rdp([[0, 0], [0.5, 0.001], [1, 0]], 0.01), [[0, 0], [1, 0]]);
assert.strictEqual(rdp([[0, 0], [0.5, 0.5], [1, 0]], 0.01).length, 3);

// --- the rng is deterministic
{
  const a = makeRng(7), b = makeRng(7);
  for (let i = 0; i < 5; i++) assert.strictEqual(a(), b());
}

// --- edits keep closed rings closed and never mutate the input
{
  const st: State = {
    strokes: [{ kind: "outline", closed: true, pts: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]] }],
    center: [40.73, -73.99],
    scale: 1300,
    rot: -29,
  };
  const before = JSON.stringify(st);
  const rnd = makeRng(3);
  for (let i = 0; i < 200; i++) {
    const { next } = propose(st, 110 / 1300, rnd, true);
    for (const s of next.strokes) if (s.closed) assert.deepStrictEqual(s.pts[0], s.pts[s.pts.length - 1]);
  }
  assert.strictEqual(JSON.stringify(st), before);
}

// --- a drawing that ends far from its start loses the walk back; ink is kept
{
  const chain: LatLng[] = [[40.7, -74], [40.705, -74], [40.71, -74], [40.705, -74.0005], [40.7005, -74.0005]];
  const r = { chain, isInk: [true, true, true, false, false], km: 2.2 } as unknown as Routed;
  const t = trimClosingWalk(r);
  assert.strictEqual(t.chain.length, 3);
  assert.ok(Math.abs(t.km - meters(chain[0]!, chain[2]!) / 1000) < 1e-9);
  // an outline whose ink ends ~150 m from its start keeps the walk that closes it
  const loop: LatLng[] = [[40.7, -74], [40.705, -74], [40.705, -74.005], [40.7, -74.002], [40.7, -74.001], [40.7, -74]];
  const closed = { chain: loop, isInk: [true, true, true, true, false, false], km: 2 } as unknown as Routed;
  assert.strictEqual(trimClosingWalk(closed), closed);
  const allInk = { chain, isInk: chain.map(() => true), km: 1 } as unknown as Routed;
  assert.strictEqual(trimClosingWalk(allInk), allInk);
}

// --- feature coverage: a route through a feature covers it, a route elsewhere does not
{
  const pl = { center: [40.73, -73.99] as LatLng, scale: 1300, rot: -29 };
  const eye = [[-0.5, 0.5], [-0.4, 0.5], [-0.3, 0.5]] as [number, number][];
  const spout = [[0, 0.9], [0, 1]] as [number, number][];
  const through = place([[-0.6, 0.5], [-0.2, 0.5], [0, 0.85], [0, 1.05]], pl.center, pl.scale, pl.rot);
  const both = featureCoverage([eye, spout], through, pl, 0.09);
  assert.ok(both.mean > 0.99 && both.min > 0.99, JSON.stringify(both));
  const missSpout = featureCoverage([eye, spout], place([[-0.6, 0.5], [-0.2, 0.5]], pl.center, pl.scale, pl.rot), pl, 0.09);
  assert.strictEqual(missSpout.min, 0);
  assert.ok(Math.abs(missSpout.mean - 0.5) < 1e-9);
  assert.deepStrictEqual(featureCoverage([], through, pl, 0.09), { mean: 1, min: 1 });
  // losing a feature costs more than half the score
  assert.ok(combinedScore(90, missSpout) < 45 && combinedScore(90, both) > 89);
}

// --- end to end on a synthetic north-up street grid: a filled square finds a seat, scores high, leaves the painter knobs alone
async function endToEnd() {
  const CELL = 0.003, STEP = 0.0009; // ~100 m blocks
  const lat0 = 40.72, lng0 = -74.0, N = 60;
  const coord: LatLng[] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) coord.push([lat0 + i * STEP, lng0 + j * STEP * 1.3]);
  const adj: { to: number; w: number }[][] = coord.map(() => []);
  const link = (a: number, b: number) => {
    const w = meters(coord[a]!, coord[b]!);
    adj[a]!.push({ to: b, w });
    adj[b]!.push({ to: a, w });
  };
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      if (j + 1 < N) link(i * N + j, i * N + j + 1);
      if (i + 1 < N) link(i * N + j, (i + 1) * N + j);
    }
  const grid = new Map<string, number[]>();
  coord.forEach((p, id) => {
    const k = `${Math.round(p[0] / CELL)}:${Math.round(p[1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(id);
  });
  const g: PainterGraph = { coord, adj, grid };
  const W = 320;
  const mask = new Uint8Array(W * W);
  for (let y = 60; y < 260; y++) for (let x = 60; x < 260; x++) mask[y * W + x] = 255;
  const hugBefore = HUG_TOL_M, trimBefore = TRACE.trimNubs;
  const res = await geoDraft(g, mask, W, W, {
    ...MANHATTAN_GEO_DEFAULTS,
    bbox: [40.74, -73.98, 40.755, -73.965],
    scales: [800],
    stepM: 600,
    iters: 30,
    sweepBudgetMs: 20_000,
    totalBudgetMs: 40_000,
  });
  assert.ok(res.ok, `expected a seat, got ${res.reason}`);
  assert.ok((res.chain?.length ?? 0) > 10);
  assert.ok((res.score ?? 0) > 50, `square should match well, got ${res.score}`);
  assert.ok(Math.abs(res.rot ?? 99) <= 40);
  assert.strictEqual(HUG_TOL_M, hugBefore);
  assert.strictEqual(TRACE.trimNubs, trimBefore);

  // an empty mask has nothing to draw
  const empty = await geoDraft(g, new Uint8Array(W * W), W, W, { ...MANHATTAN_GEO_DEFAULTS, scales: [800], sweepBudgetMs: 1000, totalBudgetMs: 2000 });
  assert.strictEqual(empty.ok, false);
}

endToEnd()
  .then(() => console.log("geoDraft tests passed"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
