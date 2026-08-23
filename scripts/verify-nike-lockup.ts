// Render + blind-judge + Mapbox-verify the curated Nike block lockup route
// codex left in the tree (lib/curatedNikeBlockLockupManhattanRoute.ts).
import fs from "node:fs/promises";
import path from "node:path";
import { CURATED_NIKE_BLOCK_LOCKUP_MANHATTAN_COORDS, curatedNikeBlockLockupRouteKm } from "../lib/curatedNikeBlockLockupManhattanRoute";
import { renderMap } from "./trace-contour";

const OUT = "tmp-studio/nike-lockup";

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const coords = CURATED_NIKE_BLOCK_LOCKUP_MANHATTAN_COORDS as [number, number][];
  console.log("points:", coords.length, "km:", curatedNikeBlockLockupRouteKm().toFixed(1));
  const png = path.join(OUT, "route.png");
  await renderMap(coords as any, [], png, 1400, 1150);
  console.log("render:", png);
  const pts = coords.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`).join("\n");
  await fs.writeFile(path.join(OUT, "route.gpx"), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>Nike block lockup</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`);
  if (process.argv.includes("--render-only")) return;

  // Mapbox walking verify, ≤24-waypoint legs, waypoints ~180 m apart.
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const MAPBOX = env.match(/^NEXT_PUBLIC_MAPBOX_TOKEN=(.+)$/m)?.[1]?.trim() ?? "";
  const R = 6371000;
  const dist = (a: [number, number], b: [number, number]) => {
    const dLat = ((b[0] - a[0]) * Math.PI) / 180;
    const dLng = ((b[1] - a[1]) * Math.PI) / 180;
    const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  let chainM = 0;
  for (let i = 1; i < coords.length; i++) chainM += dist(coords[i - 1], coords[i]);
  const way: [number, number][] = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += dist(coords[i - 1], coords[i]);
    if (acc >= 180 || i === coords.length - 1) {
      way.push(coords[i]);
      acc = 0;
    }
  }
  let walkM = 0, failedLegs = 0;
  for (let i = 0; i < way.length - 1; i += 23) {
    const seg = way.slice(i, Math.min(way.length, i + 24));
    if (seg.length < 2) break;
    const cs = seg.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
    const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/walking/${cs}?geometries=geojson&overview=false&access_token=${MAPBOX}`);
    if (!res.ok) { failedLegs++; continue; }
    const json: any = await res.json();
    if (json.code !== "Ok" || !json.routes?.[0]) { failedLegs++; continue; }
    walkM += json.routes[0].distance;
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log(`chain ${(chainM / 1000).toFixed(1)} km, mapbox walk ${(walkM / 1000).toFixed(1)} km, failedLegs ${failedLegs}, delta ${(100 * Math.abs(walkM - chainM) / chainM).toFixed(1)}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
