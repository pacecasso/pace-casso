/**
 * Prove the edit loop offline, through exactly the code the API route uses:
 * draft -> strokes -> apply an edit -> re-route -> render before and after.
 *   npx tsx scripts/stroke-edit-proof.ts catpic.jpg tmp-edit/cat
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getStreetGraph } from "../lib/streetGraphTrace";
import {
  HUG_TOL_M,
  orderStrokes,
  routePlacement,
  setHugTolerance,
  type PainterGraph,
  type Stroke,
} from "../lib/strokePainter";
import { CENTRAL_PARK, geoDraft, MANHATTAN_GEO_DEFAULTS } from "../lib/geoDraft";
import { fillEnclosed, loadMaskAuto } from "../lib/geoMask";
import { applyStrokeEdits, dropTinyStrokes, strokeFromCanvasPath, type StrokeEdit } from "../lib/strokeEdit";
import { paleRender, sideBySide } from "./finisher-shared";

const [IMG, OUT] = process.argv.slice(2);

function route(g: PainterGraph, strokes: Stroke[], center: [number, number], scale: number, rot: number) {
  const prev = HUG_TOL_M;
  try {
    setHugTolerance(90);
    return routePlacement(g, orderStrokes(strokes), center, scale, rot, false);
  } finally {
    setHugTolerance(prev);
  }
}

async function main() {
  await fs.mkdir(OUT!, { recursive: true });
  const g = (await getStreetGraph()) as unknown as PainterGraph;
  const { mask, w, h } = await loadMaskAuto(IMG!);
  // the line-art fix: without this a 7 px outline is eroded to nothing
  const filled = fillEnclosed(mask, w, h);

  const t0 = Date.now();
  const draft = await geoDraft(g, filled, w, h, {
    ...MANHATTAN_GEO_DEFAULTS,
    avoid: [CENTRAL_PARK],
    sweepBudgetMs: 90_000,
    totalBudgetMs: 140_000,
  });
  if (!draft.ok || !draft.strokes || !draft.center || !draft.scale || draft.rot === undefined) {
    console.log("draft failed", draft.reason);
    return;
  }
  const { strokes, center, scale, rot } = draft;
  console.log(
    `draft in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${strokes.length} strokes, ${draft.km!.toFixed(1)} km, ` +
      `seat ${center} scale ${scale} rot ${rot.toFixed(0)}`,
  );
  await paleRender(draft.chain!, path.join(OUT!, "1-draft.png"));

  // --- The realistic edit sequence. A draft is often ONE closed outline, so
  // "delete a stroke" would delete the whole drawing; the move that matters is
  // cut the ring into arcs, drop an arc, draw a replacement. This is the
  // cut + sequence workflow behind Ralph's approved gas route.
  const edits: StrokeEdit[] = [
    { op: "cut", index: 0, at: [[0, 1], [0, -1]] },
    { op: "drop", index: 1 },
    { op: "add", stroke: strokeFromCanvasPath([[160, 40], [160, 280]], 320) },
  ];
  const edited = dropTinyStrokes(applyStrokeEdits(strokes, edits), scale, 250);
  console.log(`after edits: ${edited.length} strokes (${edited.map((k) => `${k.closed ? "ring" : "arc"}:${k.pts.length}`).join(", ")})`);

  const tEdit = Date.now();
  const r = route(g, edited, center, scale, rot);
  const ms = Date.now() - tEdit;
  if (!r) {
    console.log("re-route failed");
    return;
  }
  console.log(`re-routed in ${ms} ms: ${r.km.toFixed(1)} km, maxGap ${r.maxGap.toFixed(0)} m, dropped ${r.dropped}`);
  if (ms > 5000) console.log("WARNING: too slow to feel like editing");

  await paleRender(r.chain, path.join(OUT!, "2-edited.png"));
  await sideBySide(path.join(OUT!, "1-draft.png"), path.join(OUT!, "2-edited.png"), path.join(OUT!, "before-after.png"));
  console.log(`wrote ${path.join(OUT!, "before-after.png")}`);

  // a round trip through JSON, the way the API will carry them
  const wire = JSON.parse(JSON.stringify({ strokes, center, scale, rot })) as typeof draft;
  const r2 = route(g, dropTinyStrokes(applyStrokeEdits(wire.strokes!, edits), scale, 250), center, scale, rot);
  console.log(
    r2 && r2.chain.length === r.chain.length
      ? "JSON round trip gives the same route"
      : "WARNING: JSON round trip changed the route",
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
