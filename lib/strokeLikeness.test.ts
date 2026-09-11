import assert from "node:assert";
import { buildTarget, coverageMap, distanceTransform, latLngToUnit, likenessAgainst, maskFrame, strokeLikeness, type Placement } from "./strokeLikeness";
import { place, type LatLng } from "./streetGraphTrace";

// a 320x320 mask with a filled square [80,240] and a thin bar to its right
const W = 320;
const H = 320;
function squareMask(): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 80; y <= 240; y++) for (let x = 80; x <= 240; x++) m[y * W + x] = 255;
  return m;
}

// --- distance transform: exact Euclidean on a small grid
{
  const n = 8;
  const set = new Uint8Array(n * n);
  set[3 * n + 3] = 1;
  const d = distanceTransform(set, n);
  assert.strictEqual(d[3 * n + 3], 0);
  assert.strictEqual(d[3 * n + 6], 3);
  assert.ok(Math.abs(d[0]! - Math.hypot(3, 3)) < 1e-5);
}

// --- projection round-trip with place()
{
  const pl: Placement = { center: [40.73, -73.99], scale: 1300, rot: -28 };
  const unit: [number, number][] = [[0.3, -0.7], [-1, 1], [0, 0]];
  const back = place(unit, pl.center, pl.scale, pl.rot).map((p) => latLngToUnit(p, pl));
  for (let i = 0; i < unit.length; i++) {
    assert.ok(Math.abs(back[i]![0] - unit[i]![0]) < 1e-6, `x ${i}`);
    assert.ok(Math.abs(back[i]![1] - unit[i]![1]) < 1e-6, `y ${i}`);
  }
}

// --- frame matches makePlan's bbox convention
{
  const f = maskFrame(squareMask(), W, H);
  assert.strictEqual(f.cx, 160);
  assert.strictEqual(f.cy, 160);
  assert.strictEqual(f.span, 160);
}

// --- a route exactly on the square's boundary scores near 100
const pl: Placement = { center: [40.73, -73.99], scale: 1300, rot: -28 };
const ring: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
const onRing = place(ring, pl.center, pl.scale, pl.rot);
const perfect = strokeLikeness(squareMask(), W, H, onRing, pl);
assert.ok(perfect.recall > 0.97, `recall ${perfect.recall}`);
assert.ok(perfect.precision > 0.97, `precision ${perfect.precision}`);
assert.ok(perfect.score > 97, `score ${perfect.score}`);

// --- the same ring shifted by more than the tolerance loses most credit
const t = buildTarget(squareMask(), W, H);
const shifted = place(ring.map(([x, y]) => [x + 0.25, y] as [number, number]), pl.center, pl.scale, pl.rot); // 325 m sideways
const sh = likenessAgainst(t, shifted, pl);
assert.ok(sh.score < perfect.score - 30, `shifted ${sh.score} vs ${perfect.score}`);

// --- a long stray tail hurts precision but not recall
const tail: [number, number][] = [...ring, [-1, -1.05], [-1, -1.25], [1, -1.25], [1, -1.05]];
const withTail = likenessAgainst(t, place(tail, pl.center, pl.scale, pl.rot), pl);
assert.ok(withTail.recall > 0.97);
assert.ok(withTail.precision < perfect.precision - 0.1, `precision ${withTail.precision}`);

// --- rows inside the filled square: half credit by default (clutter to an outline drawing), neutral for hatch styles
const hatched: [number, number][] = [...ring, [-1, -0.5], [1, -0.5], [1, 0], [-1, 0], [-1, 0.5], [1, 0.5]];
const withHatch = likenessAgainst(t, place(hatched, pl.center, pl.scale, pl.rot), pl);
assert.ok(withHatch.precision < perfect.precision - 0.1 && withHatch.precision > 0.6, `interior precision ${withHatch.precision}`);
assert.ok(withHatch.precision > withTail.precision, `interior ${withHatch.precision} should beat a stray tail ${withTail.precision}`);
const hatchStyle = likenessAgainst(t, place(hatched, pl.center, pl.scale, pl.rot), pl, { interiorCredit: 1 });
assert.ok(hatchStyle.precision > 0.9, `hatch-style precision ${hatchStyle.precision}`);

// --- half the square missing halves the recall
const half: [number, number][] = [[-1, -1], [1, -1], [1, 1]];
const h2 = likenessAgainst(t, place(half, pl.center, pl.scale, pl.rot), pl);
assert.ok(h2.recall > 0.4 && h2.recall < 0.6, `half recall ${h2.recall}`);

// --- a figure-eight over the same boundary crosses itself and scores lower than the clean ring
const eight: [number, number][] = [[-1, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
const e8 = likenessAgainst(t, place(eight, pl.center, pl.scale, pl.rot), pl);
assert.strictEqual(e8.crossings, 1, `crossings ${e8.crossings}`);
assert.strictEqual(perfect.crossings, 0);
const e8Raw = likenessAgainst(t, place(eight, pl.center, pl.scale, pl.rot), pl, { crossingWeight: 0 });
assert.ok(e8.score < e8Raw.score - 5, `${e8.score} vs ${e8Raw.score}`);

// --- empty route and empty mask do not throw
assert.strictEqual(likenessAgainst(t, [], pl).score, 0);
assert.strictEqual(strokeLikeness(new Uint8Array(W * H), W, H, onRing, pl).score, 0);

// --- placement-invariant: the same drawing under a different seat scores the same
const pl2: Placement = { center: [40.68, -73.95], scale: 2000, rot: 12 };
const p2 = strokeLikeness(squareMask(), W, H, place(ring, pl2.center, pl2.scale, pl2.rot), pl2);
assert.ok(Math.abs(p2.score - perfect.score) < 2, `${p2.score} vs ${perfect.score}`);

console.log("strokeLikeness: ok", { perfect: perfect.score.toFixed(1), shifted: sh.score.toFixed(1), tail: withTail.score.toFixed(1) });

// --- coverage map: the missing half is exactly the uncredited boundary
{
  const cov = coverageMap(t, place(half, pl.center, pl.scale, pl.rot), pl);
  let hit = 0, miss = 0;
  for (let i = 0; i < cov.length; i++) if (t.boundary[i]) cov[i]! > 0.5 ? hit++ : miss++;
  assert.ok(hit > 0 && miss > 0 && Math.abs(hit - miss) / (hit + miss) < 0.25, `hit ${hit} miss ${miss}`);
}
