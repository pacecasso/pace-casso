/**
 * Run the SITE's draft engine (lib/geoDraft) on a local image, with the old
 * plan step or the new block plan, and print what it produced. This is the
 * A/B that decides whether the new plan step ships.
 *
 *   npx tsx scripts/perceptual/site-draft.ts catpic.jpg brooklyn block 4000,6000,9000
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getStreetGraph } from "../../lib/streetGraphTrace";
import type { PainterGraph } from "../../lib/strokePainter";
import { geoDraft, BROOKLYN_GEO_DEFAULTS } from "../../lib/geoDraft";
import { fillEnclosed, loadMask } from "../../lib/geoMask";

async function main() {
  const [img, city = "brooklyn", planner = "block", scalesArg = "4000,6000,9000"] = process.argv.slice(2);
  void city;
  const masked = await loadMask(readFileSync(img!), "auto");
  if (!masked) throw new Error("no mask");
  // blockPlan draws line art as centre lines, so it must see the RAW mask:
  // filling enclosed holes merges Chanel's two C's into one unroutable blob
  const mask = planner === "block" ? masked.mask : fillEnclosed(masked.mask, masked.w, masked.h);
  const g = (await getStreetGraph("nyc-core")) as unknown as PainterGraph;
  const scales = scalesArg.split(",").map(Number);
  const t0 = Date.now();
  const r = await geoDraft(g, mask, masked.w, masked.h, {
    ...BROOKLYN_GEO_DEFAULTS,
    scales,
    sweepBudgetMs: 90_000,
    totalBudgetMs: 140_000,
    ...(planner === "block" ? { blockPlan: true } : {}),
    // multi-part logos always lose a stroke somewhere; rejecting the whole
    // placement for one drop is why Chanel and gas never seat at all
    ...(process.env.RELAX ? { maxDropped: Number(process.env.RELAX), maxGapFrac: 0.16, connectorFrac: 2 } : {}),
  });
  if (r.ok && r.chain) {
    const out = `tmp-perceptual/site-${img!.split(".")[0]}-${planner}.gpx`;
    writeFileSync(out, `<?xml version="1.0"?><gpx version="1.1" creator="pacecasso"><trk><trkseg>` +
      r.chain.map((p) => `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"/>`).join("") +
      `</trkseg></trk></gpx>`);
  }
  const seat = (globalThis as Record<string, unknown>).__seat;
  if (seat) console.log("seat reasons:", seat);
  console.log(`${img} [${city}] planner=${planner} ->`,
    r.ok ? `km ${r.km?.toFixed(1)} score ${r.score?.toFixed(1)} scale ${r.scale} rot ${r.rot?.toFixed(0)} strokes ${r.strokes?.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`
         : `FAILED (${r.reason}) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
main();
