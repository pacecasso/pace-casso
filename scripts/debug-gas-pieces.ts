// Trace each gas piece separately at one placement to find which one
// drops legs under the strict gates.
import fs from "node:fs/promises";
import { getStreetGraph, traceContour, place, toUnit, type NormalizedPoint, type LatLng } from "../lib/streetGraphTrace";

async function main() {
  const pieces: NormalizedPoint[][] = JSON.parse(await fs.readFile("tmp-studio/gas-blue/pieces.json", "utf8"));
  const all = pieces.flat();
  const unitAll = toUnit(all);
  // shared frame: slice unitAll back into pieces
  const unitPieces: [number, number][][] = [];
  let off = 0;
  for (const p of pieces) {
    unitPieces.push(unitAll.slice(off, off + p.length) as [number, number][]);
    off += p.length;
  }
  const g: any = await getStreetGraph();
  const names = ["pump", "hose", "figure"];
  for (const center of [[40.728, -73.994], [40.74, -73.988], [40.752, -73.978]] as LatLng[]) {
    for (const scale of [2000, 2600]) {
      const parts: string[] = [];
      for (let i = 0; i < unitPieces.length; i++) {
        const target = place(unitPieces[i] as any, center, scale, 0);
        const closed = Math.hypot(
          (target[0][0] - target[target.length - 1][0]) * 111320,
          (target[0][1] - target[target.length - 1][1]) * 85000,
        ) < 40;
        const r = traceContour(g, target, { anchorM: 110, lambda: 12, corridorM: 90, closeLoop: closed });
        parts.push(`${names[i] ?? "piece" + i}: cov=${r.coverage.toFixed(3)} gap=${r.maxGapM.toFixed(0)}`);
      }
      console.log(`center=${center} scale=${scale} → ${parts.join(" | ")}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
