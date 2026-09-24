/** Which stroke fails to route at a given size, and why. */
import { readFileSync } from "node:fs";
import { getStreetGraph } from "../../lib/streetGraphTrace";
import { orderStrokes, routePlacement, type PainterGraph } from "../../lib/strokePainter";
import { blockPlan } from "../../lib/blockPlan";
import { loadMask } from "../../lib/geoMask";

async function main() {
  const img = process.argv[2]!;
  const scale = Number(process.argv[3] ?? 6000);
  const m = await loadMask(readFileSync(img), "auto");
  if (!m) throw new Error("no mask");
  const plan = blockPlan(m.mask, m.w, m.h, {});
  console.log(`plan: ${plan.strokes.length} strokes`, plan.strokes.map((s) => `${s.kind}/${s.pts.length}pts`).join(" "));
  const g = (await getStreetGraph("nyc-core")) as unknown as PainterGraph;
  const seats: [number, number][] = [[40.655, -73.956], [40.67, -73.94], [40.64, -73.96], [40.70, -73.93]];
  for (const c of seats) {
    for (const rot of [-17, 0, 9]) {
      const all = routePlacement(g, orderStrokes([...plan.strokes]), c, scale, rot, true);
      const solo = plan.strokes.map((s, i) => {
        const r = routePlacement(g, orderStrokes([s]), c, scale, rot, true);
        return `${i}:${r ? `${r.km.toFixed(1)}km` : "FAIL"}`;
      });
      console.log(`@${c} rot${rot}: together ${all ? `${all.km.toFixed(1)} km dropped ${all.dropped}` : "NULL"} | alone ${solo.join(" ")}`);
    }
  }
}
main();
