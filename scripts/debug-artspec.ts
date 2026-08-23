import fs from "node:fs/promises";
import { buildArtSpec } from "../lib/artSpec";

async function main() {
  const file = process.argv[2] ?? "tmp-studio/nike-exact5/exact/contour.json";
  const contour = JSON.parse(await fs.readFile(file, "utf8"));
  const spec = buildArtSpec(contour);
  console.log("strokes:", spec.strokes.length, "composition:", spec.composition);
  for (const s of spec.strokes) {
    let sharpTurns = 0;
    for (let i = 2; i < s.points.length; i++) {
      const ax = s.points[i - 1].x - s.points[i - 2].x, ay = s.points[i - 1].y - s.points[i - 2].y;
      const bx = s.points[i].x - s.points[i - 1].x, by = s.points[i].y - s.points[i - 1].y;
      const cos = (ax * bx + ay * by) / ((Math.hypot(ax, ay) || 1) * (Math.hypot(bx, by) || 1));
      if (cos < 0.55) sharpTurns++;
    }
    console.log(
      "h", (s.bbox.maxY - s.bbox.minY).toFixed(3),
      "w", (s.bbox.maxX - s.bbox.minX).toFixed(3),
      "len", s.pathLength.toFixed(2),
      "pts", s.points.length,
      "closed", s.isClosed,
      "sal", s.visualSalience.toFixed(2),
      "turns", sharpTurns,
    );
  }
  console.log("bboxH", (spec.bbox.maxY - spec.bbox.minY).toFixed(3));
}

main().catch((e) => { console.error(e); process.exit(1); });
