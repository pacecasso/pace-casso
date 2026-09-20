/**
 * The size lever: run a drawing on the FULL NYC walk graph (Manhattan +
 * Brooklyn + Queens, 500k nodes, ~26 x 23 km) at sizes Manhattan cannot hold.
 *
 * The wall measured on Sep 18-19 is a ratio, not a constant: a feature has to
 * be a couple of blocks across to be drawable, and squeezing a whole drawing
 * into Manhattan's 3.5 km width makes ordinary features (an eyebrow, a cat's
 * ear) smaller than one block. The site has only ever used the Manhattan
 * graph. This asks what happens when the drawing is four or five times bigger.
 *
 *   npx tsx scripts/big-graph-test.ts sadlogo.png tmp-big/sad
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { LatLng } from "../lib/streetGraphTrace";
import { meters, type PainterGraph } from "../lib/strokePainter";
import { geoDraft, MANHATTAN_GEO_DEFAULTS } from "../lib/geoDraft";
import { setTraceProfile } from "../lib/strokePainter";
import { fillEnclosed, loadMask, loadMaskAuto } from "../lib/geoMask";
import { paleRender, sideBySide, writeGpx } from "./finisher-shared";

const require_ = createRequire(path.join(process.cwd(), "package.json"));
void require_;

/** the packed graph format used by the offline finisher rigs */
async function loadPackedGraph(file: string): Promise<PainterGraph> {
  const data = JSON.parse(await fs.readFile(file, "utf8")) as {
    scale: number;
    lat: number[];
    lng: number[];
    edges: number[];
  };
  const n = data.lat.length;
  const coord: LatLng[] = new Array(n);
  for (let i = 0; i < n; i++) coord[i] = [data.lat[i]! / data.scale, data.lng[i]! / data.scale];
  const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < data.edges.length; e += 2) {
    const a = data.edges[e]!;
    const b = data.edges[e + 1]!;
    const w = meters(coord[a]!, coord[b]!);
    adj[a]!.push({ to: b, w });
    adj[b]!.push({ to: a, w });
  }
  // Spatial index, keyed exactly the way the painter looks it up: CELL 0.003
  // and Math.round (not floor - flooring shifts every cell by half and the
  // lookups silently miss).
  const CELL = 0.003;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(coord[i]![0] / CELL)}:${Math.round(coord[i]![1] / CELL)}`;
    let arr = grid.get(k);
    if (!arr) grid.set(k, (arr = []));
    arr.push(i);
  }
  return { coord, adj, grid };
}

async function main() {
  const [IMG, OUT] = process.argv.slice(2);
  await fs.mkdir(OUT!, { recursive: true });

  const t0 = Date.now();
  const g = await loadPackedGraph(path.join("tmp-painter", process.env.GRAPH ?? "nyc-core-walk-graph.json"));
  console.log(`graph loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // optional explicit mask mode - "edges" keeps the boundaries INSIDE a solid
  // logo (lips, teeth, tongue), which every luminance mode collapses into one
  // blob and which loadMaskAuto never even tries
  const MODE = process.argv[7] ?? "auto";
  const { mask, w, h } = MODE === "auto" ? await loadMaskAuto(IMG!) : await loadMask(IMG!, MODE);
  // an edges mask is already thin outlines of regions; filling it would undo it
  const filled = MODE === "edges" ? mask : fillEnclosed(mask, w, h);

  // Half-sizes in metres: 2500 = a 5 km drawing, 4000 = an 8 km drawing.
  // Manhattan tops out around 1700 (a 3.4 km drawing). Bigger than this and
  // the corners land in water - NYC is islands, and a drawing that spans the
  // East River cannot be walked.
  const SCALES = (process.argv[4] ?? "2500,3200,4000").split(",").map(Number);
  const t1 = Date.now();
  if (process.env.CONNFRAC) setTraceProfile({ connectorFrac: Number(process.env.CONNFRAC) });
  const res = await geoDraft(g, filled, w, h, {
    ...MANHATTAN_GEO_DEFAULTS,
    // Brooklyn + Queens: one contiguous landmass, ~20 km across, no river to
    // cross. Manhattan is only 3.5 km wide, which is the whole problem.
    bbox: (process.argv[5] ?? "40.58,-74.03,40.74,-73.78").split(",").map(Number) as [number, number, number, number],
    scales: SCALES,
    stepM: 2500,
    maxKm: 160,
    maxRot: 40,
    // keep small defining parts - eyebrows, pupils - instead of culling them
    // for being small next to the mouth
    minRelMass: Number(process.argv[6] ?? 0.12),
    // the flat 400 m gap reject scales with the drawing now: 0.16 reproduces it
    // at half-size 2500 and stops punishing bigger drawings for being bigger
    maxGapFrac: Number(process.env.GAPFRAC ?? 0),
    maxDropped: Number(process.env.MAXDROP ?? 0),
    crossingWeight: process.env.CROSSW === undefined ? undefined : Number(process.env.CROSSW),
    // how close a thin detail stroke may come to the outline before it is
    // dropped for "would draw on the same streets". Ralph, Sep 20: drawing on
    // the same streets is fine if the art is better.
    hugM: Number(process.env.HUG ?? MANHATTAN_GEO_DEFAULTS.hugM),
    top: 3,
    iters: 600,
    sweepBudgetMs: Number(process.env.SWEEPMS ?? 240_000),
    totalBudgetMs: Number(process.env.TOTALMS ?? 420_000),
    onProgress: (s: string, pct?: number) =>
      console.log(`[${((Date.now() - t1) / 1000).toFixed(0)}s ${pct?.toFixed(0) ?? "?"}%] ${s}`),
  });

  const { chain, strokes, ...rest } = res;
  void strokes;
  console.log("RESULT " + JSON.stringify(rest));
  if (process.env.SEATDEBUG) console.log("SEATDEBUG " + JSON.stringify((globalThis as Record<string, unknown>).__seat));
  if (!res.ok || !chain) {
    console.log("no route on the big graph");
    return;
  }
  await paleRender(chain, path.join(OUT!, "best.png"));
  await sideBySide(IMG!, path.join(OUT!, "best.png"), path.join(OUT!, "compare.png"));
  await fs.writeFile(path.join(OUT!, "best.gpx"), writeGpx(chain, "big-graph", "PaceCasso big graph"));
  console.log(`wrote ${path.join(OUT!, "compare.png")}  (${res.km!.toFixed(1)} km)`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
