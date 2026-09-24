/** Re-route a Brooklyn draft through the edit step's logic, with and without an edit. */
import { readFileSync } from "node:fs";
import { getStreetGraph } from "../../lib/streetGraphTrace";
import { orderStrokes, routePlacement, setHugTolerance, HUG_TOL_M, type PainterGraph, type Stroke } from "../../lib/strokePainter";
import { applyStrokeEdits, dropTinyStrokes, type StrokeEdit } from "../../lib/strokeEdit";
import { walkGraphIdFor } from "../../lib/cityPresets";
import { trimClosingWalk } from "../../lib/geoDraft";

async function main() {
  const body = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
    strokes: Stroke[]; center: [number, number]; scale: number; rot: number; cityId: string; edits: StrokeEdit[];
  };
  const g = (await getStreetGraph(walkGraphIdFor(body.cityId))) as unknown as PainterGraph;
  const edited = dropTinyStrokes(applyStrokeEdits(body.strokes, body.edits), body.scale, 250);
  const prev = HUG_TOL_M;
  setHugTolerance(90);
  const t0 = Date.now();
  const r = routePlacement(g, orderStrokes(edited), body.center, body.scale, body.rot, false);
  setHugTolerance(prev);
  if (!r) { console.log(`${process.argv[2]}: UNROUTABLE`); return; }
  const f = trimClosingWalk(r);
  console.log(`${process.argv[2]}: ok km ${f.km.toFixed(1)} strokes ${edited.length} dropped ${f.dropped} in ${Date.now() - t0} ms`);
}
main();
