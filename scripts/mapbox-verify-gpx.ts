/**
 * Mapbox walking gate for a GPX track (same rule as the studio rig): every
 * <=24-waypoint leg must route and the walked distance must stay within
 * 12% of the track. No Anthropic calls.
 *
 * Usage: npx tsx scripts/mapbox-verify-gpx.ts file.gpx [more.gpx ...]
 */
import fs from "node:fs/promises";
import path from "node:path";

type LatLng = [number, number];
const R = 6371000;
const dist = (a: LatLng, b: LatLng) => {
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function verify(chain: LatLng[], token: string) {
  let chainM = 0;
  for (let i = 1; i < chain.length; i++) chainM += dist(chain[i - 1]!, chain[i]!);
  const way: LatLng[] = [chain[0]!];
  let acc = 0;
  for (let i = 1; i < chain.length; i++) {
    acc += dist(chain[i - 1]!, chain[i]!);
    if (acc >= 180 || i === chain.length - 1) {
      way.push(chain[i]!);
      acc = 0;
    }
  }
  let walkM = 0;
  let failedLegs = 0;
  let legs = 0;
  for (let i = 0; i < way.length - 1; i += 23) {
    const seg = way.slice(i, Math.min(way.length, i + 24));
    if (seg.length < 2) break;
    legs++;
    const coords = seg.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
    const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}?geometries=geojson&overview=false&access_token=${token}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        failedLegs++;
        continue;
      }
      const json = (await res.json()) as { code?: string; routes?: { distance: number }[] };
      if (json.code !== "Ok" || !json.routes?.[0]) {
        failedLegs++;
        continue;
      }
      walkM += json.routes[0].distance;
    } catch {
      failedLegs++;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  const walkKm = walkM / 1000;
  const chainKm = chainM / 1000;
  return { ok: failedLegs === 0 && walkKm > 0 && Math.abs(walkKm - chainKm) / chainKm < 0.12, walkKm, chainKm, failedLegs, legs };
}

async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const token = env.match(/^MAPBOX_ACCESS_TOKEN=(.+)$/m)?.[1]?.trim() ?? env.match(/^NEXT_PUBLIC_MAPBOX_TOKEN=(.+)$/m)?.[1]?.trim() ?? "";
  if (!token) throw new Error("no Mapbox token in .env.local");
  for (const f of process.argv.slice(2)) {
    const xml = await fs.readFile(f, "utf8");
    const chain: LatLng[] = [];
    for (const m of xml.matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g)) chain.push([Number(m[1]), Number(m[2])]);
    const v = await verify(chain, token);
    console.log(`${f}: ${v.ok ? "MAPBOX OK" : "MAPBOX FAIL"} — walk ${v.walkKm.toFixed(1)} km vs track ${v.chainKm.toFixed(1)} km, ${v.failedLegs}/${v.legs} legs failed`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
