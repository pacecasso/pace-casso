// where are the connector kilometres? prints every non-ink run of a routed summary in unit space
import fs from "node:fs/promises";
import { orderStrokes, routePlacement, setHugTolerance, setTraceProfile, meters, type Stroke } from "../lib/strokePainter";
import { latLngToUnit } from "../lib/strokeLikeness";
import { loadPackedGraph } from "./finisher-shared";
import type { LatLng } from "../lib/streetGraphTrace";
async function main() {
  setHugTolerance(90);
  setTraceProfile({ trimNubs: true });
  const g = await loadPackedGraph("tmp-painter/nyc-core-walk-graph.json");
  for (const file of process.argv.slice(2)) {
    const s = JSON.parse(await fs.readFile(file, "utf8")) as { strokes: Stroke[]; center: LatLng; scale: number; rot: number; composed?: boolean };
    const laid = s.composed ? s.strokes : orderStrokes(s.strokes);
    const pl = { center: s.center, scale: s.scale, rot: s.rot };
    console.log(`\n${file}: ${laid.length} strokes in order:`);
    laid.forEach((k, i) => console.log(`  ${i} ${k.kind}${k.closed ? " ring" : ""}${k.link ? " link" : ""} ${k.pts.length} pts  start ${k.pts[0]!.map((v) => v.toFixed(2))}  end ${k.pts[k.pts.length - 1]!.map((v) => v.toFixed(2))}`));
    const r = routePlacement(g, laid, s.center, s.scale, s.rot, false);
    if (!r) { console.log("did not route"); continue; }
    console.log(`  routed ${r.km.toFixed(1)} km, ink ${r.inkKm.toFixed(1)}, connectors ${r.connectorKm.toFixed(1)}, visible ${r.visibleConnKm.toFixed(1)}, dropped ${r.dropped}`);
    let i = 0;
    while (i < r.chain.length) {
      if (r.isInk[i]) { i++; continue; }
      const j0 = i;
      let m = 0;
      while (i + 1 < r.chain.length && !r.isInk[i + 1]) { m += meters(r.chain[i]!, r.chain[i + 1]!); i++; }
      if (m > 150) console.log(`  connector ${m.toFixed(0)} m  from ${latLngToUnit(r.chain[j0]!, pl).map((v) => v.toFixed(2))} to ${latLngToUnit(r.chain[i]!, pl).map((v) => v.toFixed(2))}`);
      i++;
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
