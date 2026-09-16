/**
 * Run the site's geo draft (lib/geoDraft, production Manhattan graph) on a
 * local image and render it — the offline twin of /api/geo-draft. Zero
 * model calls, zero Mapbox calls.
 *   npx tsx scripts/geo-draft-local.ts logo.png [--out=dir] [--budget=240]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getStreetGraph } from "../lib/streetGraphTrace";
import type { PainterGraph } from "../lib/strokePainter";
import { geoDraft, MANHATTAN_GEO_DEFAULTS } from "../lib/geoDraft";
import { loadMask } from "../lib/geoMask";
import { paleRender, sideBySide, writeGpx } from "./finisher-shared";

const argv = process.argv.slice(2);
const IMG = argv.find((a) => !a.startsWith("--"));
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
if (!IMG) throw new Error("usage: npx tsx scripts/geo-draft-local.ts <image> [--out=dir] [--budget=seconds]");
const OUT = opt("out", path.join("tmp-finisher", path.basename(IMG).replace(/\.[^.]+$/, "") + "-site"));
const budget = Number(opt("budget", "240")) * 1000;

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const t0 = Date.now();
  const g = (await getStreetGraph()) as unknown as PainterGraph;
  const { mask, w, h } = await loadMask(IMG!, "auto");
  console.log(`graph + mask ${Date.now() - t0} ms`);
  const res = await geoDraft(g, mask, w, h, {
    ...MANHATTAN_GEO_DEFAULTS,
    sweepBudgetMs: Math.round(budget * 0.6),
    totalBudgetMs: budget,
    onProgress: (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`),
  });
  const { chain, ...rest } = res;
  console.log(JSON.stringify(rest));
  if (!res.ok || !chain) return;
  await paleRender(chain, path.join(OUT, "best.png"));
  await sideBySide(IMG!, path.join(OUT, "best.png"), path.join(OUT, "best-compare.png"));
  await fs.writeFile(path.join(OUT, "best.gpx"), writeGpx(chain, "geo-draft", "PaceCasso geo draft"));
  console.log(`wrote ${path.join(OUT, "best-compare.png")}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
