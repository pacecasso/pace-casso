// Controlled experiment: does stronger straightness pressure (bendWeight /
// lambda) in the corridor A* raise blind-judge legibility on PROVEN designs
// at their PROVEN placements? Placement is pinned to the keeper's winning
// center/scale/rotation so the tracer settings are the only variable.
//
// Usage: npx tsx scripts/deliberateness-experiment.ts
import fs from "node:fs/promises";
import path from "node:path";
import { traceShapeOnStreets, type NormalizedPoint } from "../lib/streetGraphTrace";
import { renderMap } from "./trace-contour";

const CASES = [
  { name: "smiley", design: "tmp-studio/smiley/round-1/design.json", center: [40.728, -73.994] as [number, number], scaleM: 1300, rotDeg: -15 },
  { name: "giraffe", design: "tmp-studio/giraffe2/round-7/design.json", center: [40.74, -73.988] as [number, number], scaleM: 2400, rotDeg: 0 },
];

const SETTINGS = [
  { tag: "a120", anchorM: 120 },
  { tag: "a240", anchorM: 240 },
  { tag: "a400", anchorM: 400 },
];

const OUT = "tmp-studio/deliberateness";

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  for (const cs of CASES) {
    const design = JSON.parse(await fs.readFile(cs.design, "utf8"));
    const contour: NormalizedPoint[] = design.polyline.map(([x, y]: [number, number]) => ({ x, y }));
    for (const st of SETTINGS) {
      const cands = await traceShapeOnStreets(contour, {
        topK: 1,
        anchorM: (st as any).anchorM,
        closeLoop: design.closed,
        scales: [cs.scaleM],
        rots: [cs.rotDeg],
        placementsPerScale: 2,
        centerStepDeg: 0.004,
        bounds: {
          latMin: cs.center[0] - 0.008, latMax: cs.center[0] + 0.008,
          lngMin: cs.center[1] - 0.008, lngMax: cs.center[1] + 0.008,
        },
        
      });
      if (!cands.length) {
        console.log(`${cs.name} ${st.tag}: NO candidate survived gates`);
        continue;
      }
      const c = cands[0];
      const png = path.join(OUT, `${cs.name}-${st.tag}.png`);
      await renderMap(c.chain as any, [], png, 1200, 1000);
      console.log(`${cs.name} ${st.tag}: km=${c.km.toFixed(1)} vis=${c.visualScore.toFixed(1)} clean=${c.visualCleanliness.toFixed(1)} econ=${c.pathEconomy.toFixed(2)} → ${png}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
