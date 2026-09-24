/**
 * Re-route an exported draft with the SITE's own router (strokePainter), the
 * same call app/api/stroke-route makes. Proves a draft built offline can be
 * edited in the browser: same strokes, same placement, same streets.
 *
 *   npx tsx scripts/perceptual/reroute-site.ts tmp-perceptual/site-heart.json
 */
import { readFileSync } from "node:fs";
import { getStreetGraph } from "../../lib/streetGraphTrace";
import { orderStrokes, routePlacement, type PainterGraph, type Stroke } from "../../lib/strokePainter";

async function main() {
  const file = process.argv[2]!;
  const d = JSON.parse(readFileSync(file, "utf8")) as {
    strokes: Stroke[]; center: [number, number]; scale: number; rot: number;
  };
  const g = (await getStreetGraph("nyc-core")) as unknown as PainterGraph;
  const ordered = orderStrokes(d.strokes);
  const t0 = Date.now();
  const routed = routePlacement(g, ordered, d.center, d.scale, d.rot, true);
  if (!routed) {
    console.log("no route");
    return;
  }
  const km = routed.km ?? 0;
  console.log(`${file}: ${km.toFixed(1)} km, ${routed.chain.length} points, dropped ${routed.dropped}, ${Date.now() - t0} ms`);
}
main();
