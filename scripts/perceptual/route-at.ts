/** Route a plan at an exact seat and write the GPX, to see what that seat looks like. */
import { readFileSync, writeFileSync } from "node:fs";
import { getStreetGraph } from "../../lib/streetGraphTrace";
import { orderStrokes, routePlacement, type PainterGraph } from "../../lib/strokePainter";
import { blockPlan } from "../../lib/blockPlan";
import { loadMask } from "../../lib/geoMask";

async function main() {
  const [img, latS, lngS, scaleS, rotS, out] = process.argv.slice(2);
  const m = await loadMask(readFileSync(img!), "auto");
  if (!m) throw new Error("no mask");
  const plan = blockPlan(m.mask, m.w, m.h, {});
  const g = (await getStreetGraph("nyc-core")) as unknown as PainterGraph;
  const r = routePlacement(g, orderStrokes(plan.strokes), [Number(latS), Number(lngS)], Number(scaleS), Number(rotS), true);
  if (!r) { console.log("NULL"); return; }
  console.log(`${r.km.toFixed(1)} km, dropped ${r.dropped}, strokes ${r.strokes}`);
  writeFileSync(out!, `<?xml version="1.0"?><gpx version="1.1" creator="pacecasso"><trk><trkseg>` +
    r.chain.map((p) => `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"/>`).join("") + `</trkseg></trk></gpx>`);
}
main();
