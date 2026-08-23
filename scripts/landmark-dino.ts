/**
 * LANDMARK-AWARE design #1 — a brontosaurus that uses the real Williamsburg
 * Bridge as its long neck (the tiger/lion trick): body traced on Williamsburg
 * (Brooklyn) streets, neck = the actual bridge footpath across the East River,
 * small head in the Lower East Side. Concept-first, landmark-as-body-part.
 *
 * Run: npx tsx scripts/landmark-dino.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { buildGraph, traceContour, renderMap, meters, type LL } from "./trace-contour";

// --- pull the ordered Williamsburg Bridge walk path (Brooklyn -> Manhattan) ---
async function bridgePath(): Promise<LL[]> {
  const d = JSON.parse(await fs.readFile(path.join(process.cwd(), "tmp-gas-spike", "osm-walk-network.json"), "utf8")) as { elements: any[] };
  const nodes = new Map<number, LL>();
  for (const e of d.elements) if (e.type === "node") nodes.set(e.id, [e.lat, e.lon]);
  const parts: LL[][] = [];
  for (const e of d.elements) {
    if (e.type !== "way" || !/Williamsburg Bridge (Footpath|Bike Path)/.test(e.tags?.name ?? "")) continue;
    parts.push(e.nodes.map((n: number) => nodes.get(n)).filter(Boolean));
  }
  // order Brooklyn(east, ~-73.964) -> Manhattan(west, ~-73.986); flip parts as needed, chain by proximity
  let chain = parts.shift()!;
  if (chain[0][1] < chain[chain.length - 1][1]) chain.reverse(); // start at east (Brooklyn)
  while (parts.length) {
    const tail = chain[chain.length - 1];
    let bi = 0, brev = false, bd = Infinity;
    parts.forEach((p, i) => {
      const dh = meters(tail, p[0]), dt = meters(tail, p[p.length - 1]);
      if (dh < bd) { bd = dh; bi = i; brev = false; }
      if (dt < bd) { bd = dt; bi = i; brev = true; }
    });
    const nxt = parts.splice(bi, 1)[0];
    chain = chain.concat(brev ? nxt.reverse() : nxt);
  }
  return chain;
}

// Brontosaurus BODY outline in Williamsburg (closed loop, starts/ends at the
// neck base = Brooklyn bridge landing). Hand-placed lat/lng anchors; the tracer
// snaps them to real streets. Faces west (neck/bridge goes up-left to Manhattan).
const NECK_BASE: LL = [40.7115, -73.9645];
const BODY: LL[] = [
  NECK_BASE,                 // shoulder / neck base (bridge landing)
  [40.7128, -73.9615],       // back rises
  [40.7132, -73.9550],       // back (rounded top)
  [40.7128, -73.9490],       // back toward rump
  [40.7118, -73.9455],       // rump
  [40.7100, -73.9420],       // tail base
  [40.7076, -73.9385],       // tail mid
  [40.7060, -73.9360],       // TAIL TIP (far east)
  [40.7068, -73.9395],       // tail underside back in
  [40.7085, -73.9440],       // under the rump
  [40.7050, -73.9455],       // hind leg (spur south)
  [40.7085, -73.9470],       // back up from hind leg
  [40.7080, -73.9540],       // belly
  [40.7045, -73.9555],       // front leg (spur south)
  [40.7082, -73.9575],       // back up from front leg
  [40.7092, -73.9620],       // chest
  NECK_BASE,                 // close at the neck base
];

// small HEAD loop at the Manhattan bridge landing (LES) — a rounded head w/ jaw
const HEAD_C: LL = [40.7190, -73.9880];
function headLoop(): LL[] {
  const p: LL[] = [];
  for (let i = 0; i <= 20; i++) { const a = (i / 20) * 2 * Math.PI; p.push([HEAD_C[0] + 0.0026 * Math.cos(a), HEAD_C[1] + 0.0032 * Math.sin(a)]); }
  return p;
}

async function main() {
  console.log("building graph (Manhattan + Brooklyn)...");
  const g = await buildGraph();
  const bridge = await bridgePath();
  console.log(`bridge neck: ${bridge.length} pts, ${(bridge.reduce((s, p, i) => i ? s + meters(bridge[i - 1], p) : 0, 0) / 1000).toFixed(1)} km`);

  const body = traceContour(g, BODY, { anchorM: 190, lambda: 11, corridorM: 110 });
  const head = traceContour(g, headLoop(), { anchorM: 120, lambda: 10, corridorM: 90 });
  console.log(`body ${body.length} pts, head ${head.length} pts`);

  // compose continuous route: body loop (ends at neck base, Brooklyn) ->
  // bridge (Brooklyn->Manhattan) -> head loop in LES
  const bridgeMtoB = bridge[0][1] > bridge[bridge.length - 1][1] ? bridge : [...bridge].reverse(); // start Brooklyn (east)
  const route: LL[] = [...body, ...bridgeMtoB, ...head];

  let km = 0; for (let i = 1; i < route.length; i++) km += meters(route[i - 1], route[i]);
  console.log(`FULL ROUTE: ${(km / 1000).toFixed(1)} km, ${route.length} pts`);

  const OUT = path.join(process.cwd(), "tmp-trace", "dino");
  await fs.mkdir(OUT, { recursive: true });
  await renderMap(route, [], path.join(OUT, "map.png"), 1500, 1000);
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso"><trk><name>brontosaurus</name><trkseg>\n${route.map(([la, ln]) => `<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>`;
  await fs.writeFile(path.join(OUT, "dino.gpx"), gpx, "utf8");
  console.log("wrote tmp-trace/dino/map.png");
}
main().catch((e) => { console.error(e); process.exit(1); });
