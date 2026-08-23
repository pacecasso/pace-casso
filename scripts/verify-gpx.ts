// Mapbox walking verification for any GPX: 0 failed legs and walk length
// within 12% of the chain, or it is not runnable.
// Usage: npx tsx scripts/verify-gpx.ts <file.gpx>
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: npx tsx scripts/verify-gpx.ts <file.gpx>");
  const gpx = await fs.readFile(file, "utf8");
  const coords: [number, number][] = [...gpx.matchAll(/lat="([-0-9.]+)" lon="([-0-9.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (coords.length < 2) throw new Error("no coords");
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const MAPBOX = env.match(/^NEXT_PUBLIC_MAPBOX_TOKEN=(.+)$/m)?.[1]?.trim() ?? "";
  const R = 6371000;
  const dist = (a: [number, number], b: [number, number]) => {
    const dLat = ((b[0] - a[0]) * Math.PI) / 180, dLng = ((b[1] - a[1]) * Math.PI) / 180;
    const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
    return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2));
  };
  let chainM = 0;
  for (let i = 1; i < coords.length; i++) chainM += dist(coords[i - 1], coords[i]);
  const way: [number, number][] = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += dist(coords[i - 1], coords[i]);
    if (acc >= 180 || i === coords.length - 1) { way.push(coords[i]); acc = 0; }
  }
  let walkM = 0, failedLegs = 0;
  for (let i = 0; i < way.length - 1; i += 23) {
    const seg = way.slice(i, Math.min(way.length, i + 24));
    if (seg.length < 2) break;
    const cs = seg.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
    const res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/walking/${cs}?geometries=geojson&overview=false&access_token=${MAPBOX}`);
    const json: any = res.ok ? await res.json() : null;
    if (!json || json.code !== "Ok" || !json.routes?.[0]) { failedLegs++; continue; }
    walkM += json.routes[0].distance;
    await new Promise((r) => setTimeout(r, 350));
  }
  const delta = (100 * Math.abs(walkM - chainM)) / chainM;
  console.log(`${file}: chain ${(chainM / 1000).toFixed(1)} km, walk ${(walkM / 1000).toFixed(1)} km, failedLegs ${failedLegs}, delta ${delta.toFixed(1)}% → ${failedLegs === 0 && delta < 12 ? "RUNNABLE" : "NOT VERIFIED"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
