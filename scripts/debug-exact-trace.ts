// Debug why an exact-mode contour yields zero trace candidates.
import fs from "node:fs/promises";
import { traceShapeOnStreets } from "../lib/streetGraphTrace";

async function main() {
  const file = process.argv[2] ?? "tmp-studio/nike-exact3/exact/contour.json";
  const contour = JSON.parse(await fs.readFile(file, "utf8"));
  console.log("points:", contour.length);
  const c = await traceShapeOnStreets(contour, {
    topK: 4,
    anchorM: 80,
    closeLoop: false,
    scales: [2000, 3200],
    placementsPerScale: 2,
    rots: [0, 12, -12],
  });
  console.log("candidates:", c.length);
  for (const cand of c) console.log(cand.km.toFixed(1), "km vis", cand.visualScore.toFixed(0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
