/** Why does every placement fail for a multi-part logo? Route a few seats by hand. */
import { readFileSync } from "node:fs";
import { getStreetGraph } from "../../lib/streetGraphTrace";
import { orderStrokes, routePlacement, type PainterGraph } from "../../lib/strokePainter";
import { blockPlan } from "../../lib/blockPlan";
import { makePlan } from "../../lib/strokePainter";
import { fillEnclosed, loadMask } from "../../lib/geoMask";

async function main() {
  const img = process.argv[2]!;
  const scale = Number(process.argv[3] ?? 4000);
  const m = await loadMask(readFileSync(img), "auto");
  if (!m) throw new Error("no mask");
  const mask = fillEnclosed(m.mask, m.w, m.h);
  const g = (await getStreetGraph("nyc-core")) as unknown as PainterGraph;
  const raw = m.mask;
  const bp = blockPlan(raw, m.w, m.h, {});   // RAW mask: holes are part of the logo
  const op = makePlan(mask, m.w, m.h, scale, { pitchM: 160, rows: 0, openM: 60 }, []);
  const bpFilled = blockPlan(mask, m.w, m.h, {});
  console.log(`block plan RAW: ${bp.strokes.length} strokes (parts ${bp.parts}, lines ${bp.centrelines}, lineArt ${bp.lineArt})`);
  console.log(`block plan FILLED: ${bpFilled.strokes.length} strokes (parts ${bpFilled.parts})`);
  console.log(`old plan:   ${op.strokes.length} strokes`);
  const seats: [number, number][] = [[40.68, -73.94], [40.66, -73.95], [40.70, -73.92], [40.63, -73.96]];
  for (const [name, strokes] of [["block", bp.strokes], ["old", op.strokes]] as const) {
    for (const c of seats) {
      for (const rot of [0, 10]) {
        const r = routePlacement(g, orderStrokes([...strokes]), c, scale, rot, true);
        console.log(`${name} @${c[0]},${c[1]} rot${rot}: ` +
          (r ? `km ${r.km.toFixed(1)} dropped ${r.dropped}/${r.strokes} gap ${r.maxGap.toFixed(0)}` : "NULL"));
      }
    }
  }
}
main();
