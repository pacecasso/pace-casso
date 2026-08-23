/**
 * Automated Cameron — SHAPE DEFORMATION, not just placement. Instead of moving
 * a rigid unicorn around, this drags the silhouette's own control points,
 * thousands of times, so each feature (legs, horn, tail, head) snaps cleanly
 * onto real streets — the thing Cameron does by hand, done in minutes.
 *
 * Objective for the inner loop is the feature-weighted street-fit (coarseScore)
 * at a FIXED good placement: lowering it locally = adapting the shape to the
 * streets without changing the overall gestalt. Periodic full trace + render.
 *
 * Run: npx tsx scripts/deform-unicorn.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { buildGraph, traceContour, renderMap, meters, place, coarseScore, cbezExport as cbez, type LL } from "./trace-contour";

// v5 unicorn as editable segments (A = polyline pts, B = cubic bezier ctrl pts)
type Seg = { t: "A" | "B"; pts: LL[] };
const BASE: Seg[] = [
  { t: "A", pts: [[0.66, 1.50]] },
  { t: "A", pts: [[0.52, 1.22], [0.66, 1.12], [0.48, 0.90], [0.62, 0.82], [0.45, 0.62], [0.44, 0.52]] },
  { t: "A", pts: [[0.52, 0.58], [0.60, 0.74], [0.66, 0.50]] },
  { t: "B", pts: [[0.66, 0.50], [0.78, 0.42], [0.83, 0.28], [0.83, 0.15]] },
  { t: "A", pts: [[0.86, 0.02], [0.73, -0.02]] },
  { t: "B", pts: [[0.73, -0.02], [0.64, 0.03], [0.58, 0.07], [0.54, 0.13]] },
  { t: "B", pts: [[0.54, 0.13], [0.52, -0.02], [0.52, -0.12], [0.52, -0.24]] },
  { t: "A", pts: [[0.52, -0.92], [0.42, -0.92], [0.42, -0.22]] },
  { t: "A", pts: [[0.30, -0.22], [0.30, -0.92], [0.20, -0.92], [0.20, -0.18]] },
  { t: "B", pts: [[0.20, -0.18], [0.02, -0.26], [-0.18, -0.24], [-0.34, -0.18]] },
  { t: "A", pts: [[-0.34, -0.92], [-0.44, -0.92], [-0.44, -0.18]] },
  { t: "A", pts: [[-0.56, -0.18], [-0.56, -0.92], [-0.66, -0.92], [-0.66, -0.04]] },
  { t: "B", pts: [[-0.66, -0.04], [-0.78, 0.04], [-0.84, 0.08], [-0.90, 0.12]] },
  { t: "B", pts: [[-0.90, 0.12], [-1.08, -0.10], [-1.02, -0.52], [-0.84, -0.36]] },
  { t: "B", pts: [[-0.84, -0.36], [-0.96, -0.04], [-0.84, 0.20], [-0.72, 0.26]] },
  { t: "A", pts: [[-0.58, 0.32], [-0.48, 0.52], [-0.40, 0.32], [-0.28, 0.54], [-0.20, 0.34], [-0.06, 0.56], [0.02, 0.36], [0.16, 0.58], [0.24, 0.38], [0.36, 0.54], [0.42, 0.44], [0.44, 0.52]] },
];
const clone = (s: Seg[]): Seg[] => s.map((g) => ({ t: g.t, pts: g.pts.map((p) => [p[0], p[1]] as LL) }));
function build(segs: Seg[]): LL[] {
  const res: LL[] = [];
  for (const g of segs) {
    if (g.t === "A") res.push(...g.pts);
    else res.push(...cbez(g.pts[0], g.pts[1], g.pts[2], g.pts[3], 16));
  }
  return res;
}

const PLACE = { lat: 40.7272, lng: -73.9901, scale: 1613, rot: -10 };
const scoreOf = (g: any, segs: Seg[]) => coarseScore(g, place(build(segs), [PLACE.lat, PLACE.lng], PLACE.scale, PLACE.rot)).score;

async function main() {
  console.log("building graph...");
  const g = await buildGraph();
  let cur = clone(BASE);
  let cs = scoreOf(g, cur);
  const start = cs;
  // flatten a list of (segIdx, ptIdx) that are safe to move (all of them)
  const handles: [number, number][] = [];
  cur.forEach((seg, si) => seg.pts.forEach((_, pi) => handles.push([si, pi])));
  let step = 0.05; // in silhouette units (~ scaled by PLACE.scale meters)
  let sinceImprove = 0;
  const ITERS = 6000;
  for (let it = 0; it < ITERS; it++) {
    const [si, pi] = handles[(Math.random() * handles.length) | 0];
    const trial = clone(cur);
    // small drag; clamp so it can't wander more than ~0.22 from its BASE anchor
    const nx = trial[si].pts[pi][0] + (Math.random() - 0.5) * 2 * step;
    const ny = trial[si].pts[pi][1] + (Math.random() - 0.5) * 2 * step;
    if (Math.abs(nx - BASE[si].pts[pi][0]) > 0.22 || Math.abs(ny - BASE[si].pts[pi][1]) > 0.22) continue;
    trial[si].pts[pi] = [nx, ny];
    const s = scoreOf(g, trial);
    if (s < cs) { cs = s; cur = trial; sinceImprove = 0; }
    else if (++sinceImprove >= 60) { step *= 0.85; sinceImprove = 0; if (step < 0.006) break; }
  }
  console.log(`deform: coarseScore ${start.toFixed(1)} -> ${cs.toFixed(1)} over ${ITERS} drags`);

  const OUT = path.join(process.cwd(), "tmp-trace", "deform");
  await fs.mkdir(OUT, { recursive: true });
  for (const [name, segs] of [["before", BASE], ["after", cur]] as const) {
    const target = place(build(segs), [PLACE.lat, PLACE.lng], PLACE.scale, PLACE.rot);
    const chain = traceContour(g, target, { anchorM: 180, lambda: 13, corridorM: 85 });
    let km = 0; for (let j = 1; j < chain.length; j++) km += meters(chain[j - 1], chain[j]);
    await renderMap(chain, [], path.join(OUT, `${name}.png`), 1000, 820);
    console.log(`  ${name}: ${km.toFixed(1)}km`);
  }
  await fs.writeFile(path.join(OUT, "deformed-segs.json"), JSON.stringify(cur));
  console.log("done -> tmp-trace/deform/before.png, after.png");
}
main().catch((e) => { console.error(e); process.exit(1); });
