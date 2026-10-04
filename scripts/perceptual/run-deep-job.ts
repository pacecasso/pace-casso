/**
 * Run the deep search the way the JOB runs it (one size per stage, best kept),
 * without Vercel. This is the search that has a real budget instead of the
 * ~130 s a live request can afford.
 *
 *   npx tsx scripts/perceptual/run-deep-job.ts catpic.jpg brooklyn
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getStreetGraph } from "../../lib/streetGraphTrace";
import type { PainterGraph } from "../../lib/strokePainter";
import { geoDraft, BROOKLYN_GEO_DEFAULTS, type GeoDraftResult } from "../../lib/geoDraft";
import { loadMask } from "../../lib/geoMask";
import { walkGraphIdFor } from "../../lib/cityPresets";

const SIZES = (process.env.SIZES ?? "4000,5000,6000,7500,9000").split(",").map(Number);

async function main() {
  const [img, cityId = "brooklyn"] = process.argv.slice(2);
  const masked = await loadMask(readFileSync(img!), "auto");
  if (!masked) throw new Error("no mask");
  const g = (await getStreetGraph(walkGraphIdFor(cityId))) as unknown as PainterGraph;
  let best: { r: GeoDraftResult; scale: number } | null = null;
  for (const scale of SIZES) {
    const t0 = Date.now();
    const r = await geoDraft(g, masked.mask, masked.w, masked.h, {
      ...BROOKLYN_GEO_DEFAULTS,
      scales: [scale],
      blockPlan: true,
      ...(process.env.NO_SEATGRAPH ? {} : { seatsFromGraph: true }),
      ...(process.env.NO_ROTS ? {} : { rotOffsets: [-15, 0, 15] }),
      landFrac: 0.6,
      ...(process.env.NO_PREFILTER ? {} : { prefilterTop: 140 }),
      maxDropFrac: 0.12,
      maxKm: 200,
      sweepBudgetMs: 170_000,
      totalBudgetMs: 250_000,
    });
    console.log(`  ${scale}: ${r.ok ? `km ${r.km?.toFixed(1)} score ${r.score?.toFixed(1)} rot ${r.rot?.toFixed(0)} seats ${r.seatsRouted}` : `no seat (${r.reason})`} [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
    if (r.ok && (r.score ?? 0) > (best?.r.score ?? 0)) best = { r, scale };
  }
  if (!best?.r.chain) { console.log("deep search found nothing"); return; }
  console.log(`BEST: ${best.r.km?.toFixed(1)} km at half-size ${best.scale}, score ${best.r.score?.toFixed(1)}`);
  writeFileSync(`tmp-perceptual/deep-${img!.split(".")[0]}.gpx`,
    `<?xml version="1.0"?><gpx version="1.1" creator="pacecasso"><trk><trkseg>` +
    best.r.chain.map((p) => `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"/>`).join("") +
    `</trkseg></trk></gpx>`);
}
main();
