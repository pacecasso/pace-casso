/**
 * Deep optimizer — the "use the AI's iteration advantage" pass Ralph asked for.
 * Cameron drags points for hours by hand; this does the automated equivalent at
 * scale: a dense placement grid → multi-start hill-climbing on
 * (lat, lng, scale, rotation), hundreds of steps each, minimizing the
 * feature-weighted trace-fit score, then traces + renders the winners for the
 * vision judge to rank. Take-your-time, not shit-it-out.
 *
 * Run: npx tsx scripts/optimize-design.ts <shape> [starts] [iters]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { buildGraph, traceContour, renderMap, meters, place, coarseScore, getShape, traceOpts, type LL } from "./trace-contour";

type Placement = { lat: number; lng: number; scale: number; rot: number };
const scoreOf = (g: any, unit: LL[], p: Placement) => coarseScore(g, place(unit, [p.lat, p.lng], p.scale, p.rot)).score;

// Greedy hill-climb with shrinking step sizes (coordinate perturbation).
function hillclimb(g: any, unit: LL[], start: Placement, iters: number): { p: Placement; s: number } {
  let best = { ...start };
  let bs = scoreOf(g, unit, best);
  let sp = 0.0035, ss = 350, sr = 10; // pos(deg), scale(m), rot(deg)
  let sinceImprove = 0;
  for (let it = 0; it < iters; it++) {
    const cand: Placement = {
      lat: best.lat + (Math.random() - 0.5) * 2 * sp,
      lng: best.lng + (Math.random() - 0.5) * 2 * sp,
      scale: Math.max(900, best.scale + (Math.random() - 0.5) * 2 * ss),
      rot: best.rot + (Math.random() - 0.5) * 2 * sr,
    };
    const s = scoreOf(g, unit, cand);
    if (s < bs) { bs = s; best = cand; sinceImprove = 0; }
    else if (++sinceImprove >= 25) { sp *= 0.82; ss *= 0.82; sr *= 0.82; sinceImprove = 0; }
  }
  return { p: best, s: bs };
}

async function main() {
  const shape = process.argv[2] ?? "unicorn";
  const STARTS = Number(process.argv[3] ?? 10);
  const ITERS = Number(process.argv[4] ?? 500);
  const unit = getShape(shape)();
  if (!unit) throw new Error(`unknown shape ${shape}`);
  if (shape === "uniline") traceOpts.trim = false; // keep the thin spur legs
  console.log(`building graph...`);
  const g = await buildGraph();

  // 1) dense coarse grid → seed placements (fine position + many scales/rots)
  console.log(`coarse grid sweep...`);
  const seeds: { p: Placement; s: number }[] = [];
  for (let lat = 40.712; lat <= 40.800; lat += 0.005)
    for (let lng = -74.010; lng <= -73.935; lng += 0.005)
      for (const scale of [1600, 2100, 2700, 3300])
        for (const rot of [0, 12, -12, 24, -24, 36, -36]) {
          const p = { lat, lng, scale, rot };
          const { score, miss } = coarseScore(g, place(unit, [lat, lng], scale, rot));
          if (miss <= 10) seeds.push({ p, s: score });
        }
  seeds.sort((a, b) => a.s - b.s);
  // spread the starts out so they don't all climb the same hill
  const starts: { p: Placement; s: number }[] = [];
  for (const c of seeds) {
    if (starts.length >= STARTS) break;
    if (starts.some((o) => meters([o.p.lat, o.p.lng], [c.p.lat, c.p.lng]) < 700 && Math.abs(o.p.scale - c.p.scale) < 500)) continue;
    starts.push(c);
  }
  console.log(`${seeds.length} seeds; hill-climbing ${starts.length} starts x ${ITERS} iters...`);

  // 2) hill-climb each start
  const climbed = starts.map((st, i) => {
    const r = hillclimb(g, unit, st.p, ITERS);
    console.log(`  start ${i}: ${st.s.toFixed(1)} -> ${r.s.toFixed(1)} @${r.p.lat.toFixed(4)},${r.p.lng.toFixed(4)} sc=${r.p.scale.toFixed(0)} rot=${r.p.rot.toFixed(0)}`);
    return r;
  });
  climbed.sort((a, b) => a.s - b.s);

  // 3) trace + render the top few (de-duped) for the judge
  const OUT = path.join(process.cwd(), "tmp-trace", `opt-${shape}`);
  await fs.mkdir(OUT, { recursive: true });
  const picks: typeof climbed = [];
  for (const c of climbed) {
    if (picks.length >= 8) break;
    if (picks.some((o) => meters([o.p.lat, o.p.lng], [c.p.lat, c.p.lng]) < 500 && Math.abs(o.p.rot - c.p.rot) < 15)) continue;
    picks.push(c);
  }
  for (let i = 0; i < picks.length; i++) {
    const pk = picks[i];
    const target = place(unit, [pk.p.lat, pk.p.lng], pk.p.scale, pk.p.rot);
    const chain = traceContour(g, target, { anchorM: 180, lambda: 13, corridorM: 85 });
    let km = 0; for (let j = 1; j < chain.length; j++) km += meters(chain[j - 1], chain[j]);
    await renderMap(chain, [], path.join(OUT, `cand${i}.png`), 1000, 820);
    console.log(`  cand${i}: score=${pk.s.toFixed(1)} ${km.toFixed(1)}km @${pk.p.lat.toFixed(4)},${pk.p.lng.toFixed(4)} sc=${pk.p.scale.toFixed(0)} rot=${pk.p.rot.toFixed(0)}`);
    // save placement for repro/refine
    await fs.writeFile(path.join(OUT, `cand${i}.json`), JSON.stringify(pk.p));
  }
  console.log(`done -> tmp-trace/opt-${shape}/cand{0..${picks.length - 1}}.png`);
}
main().catch((e) => { console.error(e); process.exit(1); });
