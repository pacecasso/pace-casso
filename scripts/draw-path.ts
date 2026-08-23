/**
 * Draw an OPEN route from hand-placed waypoints along real features, tracing
 * each leg on real streets (corridor A*), rendered thin/clean like Strava.
 * For the street-artist "use the map" designs (Broadway bolt, the Key, etc.).
 *
 * Run: npx tsx scripts/draw-path.ts <name>
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildGraph, corridorPath, nearestNode, meters, type LL } from "./trace-contour";

// Designs as ordered lat/lng waypoints on real NYC features.
const DESIGNS: Record<string, LL[]> = {
  // LIGHTNING BOLT = Broadway's diagonal, Columbus Circle -> Bowling Green,
  // jogging at the squares, with arrowhead flicks at the ends.
  bolt: [
    [40.7690, -73.9808],   // arrowhead flick (NE of Columbus Circle)
    [40.7681, -73.9819],   // Columbus Circle
    [40.7639, -73.9840],   // Broadway & 55th
    [40.7590, -73.9858],   // Times Square (Bway & 46th)
    [40.7529, -73.9874],   // Bway & 38th
    [40.7505, -73.9880],   // Herald Square (Bway & 34th)
    [40.7448, -73.9887],   // Bway & 28th
    [40.7411, -73.9897],   // Madison Sq / Flatiron (Bway & 23rd)
    [40.7356, -73.9910],   // Union Square (Bway & 14th)
    [40.7294, -73.9915],   // Astor Pl (Bway & 8th)
    [40.7250, -73.9962],   // Bway & Houston
    [40.7192, -74.0009],   // Bway & Canal
    [40.7141, -74.0060],   // Bway & Chambers (City Hall)
    [40.7075, -74.0121],   // Bway & Bowling Green
    [40.7040, -74.0135],   // arrowhead flick (Battery)
  ],
  // KEY TO THE CITY = Columbus Circle (real roundabout) as the round head,
  // 7th Ave/Broadway down as the shaft, notches at the end as the teeth.
  key: [
    [40.7681, -73.9827],   // circle W (tight ~65m ring on the roundabout)
    [40.7676, -73.9823],
    [40.7674, -73.9819],   // S
    [40.7676, -73.9815],
    [40.7681, -73.9811],   // E
    [40.7686, -73.9815],
    [40.7688, -73.9819],   // N
    [40.7686, -73.9823],
    [40.7681, -73.9827],   // close circle
    [40.7620, -73.9846],   // shaft down 7th Ave / Broadway
    [40.7540, -73.9877],
    [40.7470, -73.9905],
    [40.7430, -73.9922],   // shaft end
    [40.7430, -73.9942],   // tooth 1 out
    [40.7418, -73.9942],   // tooth 1 down
    [40.7418, -73.9922],   // back to shaft
    [40.7404, -73.9922],   // down shaft
    [40.7404, -73.9940],   // tooth 2 out
    [40.7392, -73.9940],   // tooth 2 tip
  ],
};

async function main() {
  const name = process.argv[2] ?? "bolt";
  const wp = DESIGNS[name];
  if (!wp) throw new Error(`unknown design ${name}`);
  console.log("building graph...");
  const g = await buildGraph();
  // trace each leg on streets, hugging the straight waypoint line
  const chain: LL[] = [];
  for (let i = 1; i < wp.length; i++) {
    const na = nearestNode(g, wp[i - 1]), nb = nearestNode(g, wp[i]);
    if (na < 0 || nb < 0 || na === nb) continue;
    const dense = [wp[i - 1], wp[i]];
    let p = corridorPath(g, na, nb, dense, 8, 220) || corridorPath(g, na, nb, dense, 0, 1e7);
    if (!p) continue;
    for (const id of p) chain.push(g.coord.get(id)!);
  }
  const pts: LL[] = [];
  for (const p of chain) if (!pts.length || meters(pts[pts.length - 1], p) > 5) pts.push(p);
  let km = 0; for (let i = 1; i < pts.length; i++) km += meters(pts[i - 1], pts[i]);
  console.log(`${name}: ${pts.length} pts, ${(km / 1000).toFixed(1)} km`);

  // thin Strava render
  const TILE = 256, w = 760, h = 1000;
  const lonX = (lo: number, z: number) => ((lo + 180) / 360) * TILE * 2 ** z;
  const latY = (la: number, z: number) => { const r = la * Math.PI / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z; };
  let zoom = 13; for (let z = 16; z >= 11; z--) { const xs = pts.map(p => lonX(p[1], z)), ys = pts.map(p => latY(p[0], z)); if (Math.max(...xs) - Math.min(...xs) <= w * 0.82 && Math.max(...ys) - Math.min(...ys) <= h * 0.82) { zoom = z; break; } }
  const xs = pts.map(p => lonX(p[1], zoom)), ys = pts.map(p => latY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: sharp.OverlayOptions[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
    const r = await fetch(`https://a.basemaps.cartocdn.com/light_all/${zoom}/${tx}/${ty}@2x.png`, { headers: { "User-Agent": "pace-casso dev" } });
    if (!r.ok) continue;
    tiles.push({ input: await sharp(Buffer.from(await r.arrayBuffer())).resize(TILE, TILE).toBuffer(), left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"} ${(lonX(p[1], zoom) - vx).toFixed(1)} ${(latY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
  const ov = Buffer.from(`<svg width="${w}" height="${h}"><path d="${d}" fill="none" stroke="#fc5200" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eaeaea" } }).composite([...tiles, { input: ov, left: 0, top: 0 }]).png().toFile(path.join(process.cwd(), "tmp-trace", `${name}.png`));
  console.log(`wrote tmp-trace/${name}.png`);
}
main().catch((e) => { console.error(e); process.exit(1); });
