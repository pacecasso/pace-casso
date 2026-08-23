import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

function loadLocalEnv() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] ||= value;
  }
  if (!process.env.NEXT_PUBLIC_MAPBOX_TOKEN && process.env.MAPBOX_ACCESS_TOKEN) {
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN;
  }
  process.env.NEXT_PUBLIC_MAPBOX_PROXY = "0";
}

loadLocalEnv();

const jiti = createJiti(import.meta.url);
const { streetWordmarkCandidates } = jiti("../lib/mapNativeDesigner.ts");
const { CITY_PRESETS } = jiti("../lib/cityPresets.ts");
const { snapWalkingRoute } = jiti("../lib/snapWalkingRoute.ts");
const { routeShapeMatchPercent } = jiti("../lib/autoFindTop5.ts");
const { routeQualityScore } = jiti("../lib/routeQuality.ts");

function family(candidate) {
  return candidate.designIntent.match(/\(([^)]+)\)/)?.[1] ?? "?";
}

const words = [
  ["RALPH", 9],
  ["LAUREN", 9],
  ["MAX", 7],
];

const report = [];
for (const [word, targetKm] of words) {
  const candidates = streetWordmarkCandidates(
    word,
    CITY_PRESETS.manhattan,
    targetKm,
  )
    .filter((candidate) => candidate.routeMode === "direct-grid")
    .slice(0, 8);
  const rows = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const route = await snapWalkingRoute(candidate.anchors, {
        anchorSource: "image",
        startVariantCount: 2,
      });
      const snappedKm = (route.distanceMeters ?? 0) / 1000;
      const ratio = snappedKm / Math.max(candidate.km, 0.1);
      const match = routeShapeMatchPercent(candidate.anchors, route.coordinates);
      const clean = routeQualityScore(route.coordinates);
      rows.push({
        idx: i + 1,
        family: family(candidate),
        rawKm: Number(candidate.km.toFixed(1)),
        snappedKm: Number(snappedKm.toFixed(1)),
        ratio: Number(ratio.toFixed(2)),
        match,
        clean,
        readyToRun:
          ratio >= 0.75 && ratio <= 1.6 && match >= 55 && clean >= 20,
      });
    } catch (error) {
      rows.push({
        idx: i + 1,
        family: family(candidate),
        rawKm: Number(candidate.km.toFixed(1)),
        error: error instanceof Error ? error.message : String(error),
        readyToRun: false,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  report.push({ word, rows });
}

console.log(JSON.stringify(report, null, 2));
