import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { getStreetGraph, traceContour, place, toUnit } from "../lib/streetGraphTrace";
import { extractNormalizedContourFromLineMask } from "../lib/extractNormalizedContourFromLineMask";
import { buildArtSpec } from "../lib/artSpec";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");

async function main() {
  const BOX = 300;
  const { data, info } = await sharp("strava.png").flatten({ background: "#ffffff" }).resize(BOX, BOX, { fit: "contain", background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(BOX * BOX);
  for (let i = 0; i < BOX * BOX; i++) {
    const r = data[i * info.channels], g = data[i * info.channels + 1], b = data[i * info.channels + 2];
    mask[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b < 210 ? 255 : 0;
  }
  const contour = extractNormalizedContourFromLineMask(mask, 0.22, BOX, BOX, { source: "silhouette-outline" })!;
  const spec = buildArtSpec(contour);
  console.log("strokes:", spec.strokes.map((s) => ({ pts: s.points.length, closed: s.isClosed, h: +(s.bbox.maxY - s.bbox.minY).toFixed(3), w: +(s.bbox.maxX - s.bbox.minX).toFixed(3) })));
  const strokes = spec.strokes.filter((s) => s.points.length >= 6).sort((a, b) => b.visualSalience - a.visualSalience).slice(0, 2);
  strokes.sort((a, b) => a.bbox.minY - b.bbox.minY);
  const [top, bottom] = strokes.map((s) => s.points);
  const both = [...top, ...bottom];
  const unitBoth = toUnit(both);
  const unitTop = unitBoth.slice(0, top.length);
  console.log("unitTop first/last:", unitTop[0], unitTop[unitTop.length - 1]);
  const g: any = await getStreetGraph();
  const target = place(unitTop as any, [40.728, -73.994], 1800, 0);
  console.log("target pts:", target.length, "first:", target[0], "last:", target[target.length - 1]);
  const r = traceContour(g, target, { anchorM: 100, lambda: 12, corridorM: 90, closeLoop: true });
  console.log("chain:", r.chain.length, "coverage:", r.coverage.toFixed(4), "maxGapM:", r.maxGapM, "retrace:", r.hasIntentionalRetrace);
  const r2 = traceContour(g, target, { anchorM: 140, lambda: 12, corridorM: 90, closeLoop: true, preserveRetraces: false });
  console.log("no-retrace variant:", r2.chain.length, "coverage:", r2.coverage.toFixed(4), "maxGapM:", r2.maxGapM);
}

main().catch((e) => { console.error(e); process.exit(1); });
