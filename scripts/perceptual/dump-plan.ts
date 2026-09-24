/** Dump lib/blockPlan's strokes for an image so they can be rendered next to the offline rig's. */
import { readFileSync, writeFileSync } from "node:fs";
import { loadMask } from "../../lib/geoMask";
import { blockPlan } from "../../lib/blockPlan";

async function main() {
  const img = process.argv[2]!;
  const m = await loadMask(readFileSync(img), "auto");
  if (!m) throw new Error("no mask");
  const p = blockPlan(m.mask, m.w, m.h, process.env.EXAG ? { exaggerate: Number(process.env.EXAG) } : {});
  let len = 0;
  for (const s of p.strokes) for (let i = 1; i < s.pts.length; i++)
    len += Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]);
  console.log(`${img}: ${p.strokes.length} strokes, lineArt ${p.lineArt}, parts ${p.parts}, lines ${p.centrelines}, unit length ${len.toFixed(2)} (a full cat outline is ~6)`);
  // 224-space, same shape as the offline plan files
  const R = 224;
  writeFileSync("tmp-perceptual/tsplan.json", JSON.stringify({
    strokes: p.strokes.map((s) => s.pts.map(([x, y]) => [(x + 1) / 2 * R, (1 - y) / 2 * R])),
  }));
}
main();
