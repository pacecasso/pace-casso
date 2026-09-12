// calibration: score existing gas states with the free likeness score; time routePlacement
import fs from "node:fs/promises";
import { orderStrokes, routePlacement, setHugTolerance, setTraceProfile, type Stroke } from "../lib/strokePainter";
import { buildTarget, countCrossings, likenessAgainst } from "../lib/strokeLikeness";
import { loadMask, loadPackedGraph } from "./finisher-shared";
import type { LatLng } from "../lib/streetGraphTrace";

const ROOT = process.cwd();
async function main() {
  setHugTolerance(90);
  setTraceProfile({ trimNubs: true });
  const { mask, w, h } = await loadMask(`${ROOT}/gas.png`, "blue");
  const t = buildTarget(mask, w, h);
  console.log("target cells", t.targetCells);
  let t0 = Date.now();
  const g = await loadPackedGraph(`${ROOT}/tmp-painter/nyc-core-walk-graph.json`);
  console.log("graph load ms", Date.now() - t0);
  const states = ["gas-geo-fresh", "gas-geo-fresh-compose"];
  for (const name of states) {
    const s = JSON.parse(await fs.readFile(`${ROOT}/tmp-finisher/${name}/summary.json`, "utf8")) as { strokes: Stroke[]; center: LatLng; scale: number; rot: number; final?: number[]; start?: number[]; composed?: boolean };
    t0 = Date.now();
    const r = routePlacement(g, s.composed ? s.strokes : orderStrokes(s.strokes), s.center, s.scale, s.rot, false);
    const ms = Date.now() - t0;
    if (!r) { console.log(name, "did not route"); continue; }
    t0 = Date.now();
    const lk = likenessAgainst(t, r.chain, { center: s.center, scale: s.scale, rot: s.rot });
    const scoreMs = Date.now() - t0;
    const judge = s.final ? (s.final.reduce((a, b) => a + b, 0) / s.final.length).toFixed(2) : "-";
    console.log(`${name}: geo ${lk.score.toFixed(1)} (recall ${lk.recall.toFixed(2)} precision ${lk.precision.toFixed(2)}) | crossings ${countCrossings(r.chain, { center: s.center, scale: s.scale, rot: s.rot })} | ink ${r.inkKm.toFixed(1)} conn ${r.connectorKm.toFixed(1)} vis ${r.visibleConnKm.toFixed(1)} | judge ${judge} | ${r.km.toFixed(1)} km | route ${ms} ms, score ${scoreMs} ms`);
  }
  // a deliberately wrong seat: same drawing dropped in Central Park / a random spot
  const s = JSON.parse(await fs.readFile(`${ROOT}/tmp-finisher/gas-fin/summary.json`, "utf8")) as { strokes: Stroke[]; scale: number; rot: number };
  for (const c of [[40.78, -73.965], [40.65, -73.95], [40.7, -73.8]] as LatLng[]) {
    const r = routePlacement(g, orderStrokes(s.strokes), c, s.scale, s.rot, false);
    if (!r) { console.log("seat", c, "did not route"); continue; }
    const lk = likenessAgainst(t, r.chain, { center: c, scale: s.scale, rot: s.rot });
    console.log(`seat ${c}: geo ${lk.score.toFixed(1)} (r ${lk.recall.toFixed(2)} p ${lk.precision.toFixed(2)}) dropped ${r.dropped} gap ${r.maxGap.toFixed(0)} | ${r.km.toFixed(1)} km`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
