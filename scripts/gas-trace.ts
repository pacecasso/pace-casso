import fs from "node:fs/promises"; import path from "node:path";
import { buildGraph, traceContour, renderMap, place, meters, type LL } from "./trace-contour";
async function main(){
  const unit = JSON.parse(await fs.readFile(path.join(process.cwd(),"tmp-trace","gas-shape.json"),"utf8")) as LL[];
  const scale = Number(process.argv[2] ?? 3200);
  const center: LL = [Number(process.argv[3] ?? 40.752), Number(process.argv[4] ?? -73.987)];
  const rot = Number(process.argv[5] ?? 0);
  console.log("building graph...");
  const g = await buildGraph();
  const target = place(unit, center, scale, rot);
  const chain = traceContour(g, target, { anchorM: 150, lambda: 12, corridorM: 90 });
  let km=0; for(let i=1;i<chain.length;i++) km+=meters(chain[i-1],chain[i]);
  console.log(`gas: ${chain.length} pts, ${(km/1000).toFixed(1)} km`);
  await renderMap(chain, [], path.join(process.cwd(),"tmp-trace","gas-route.png"), 900, 900);
  console.log("wrote gas-route.png");
}
main().catch(e=>{console.error(e);process.exit(1);});
