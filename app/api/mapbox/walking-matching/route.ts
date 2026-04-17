import { NextResponse } from "next/server";
import { LruJsonCache } from "../../../../lib/mapboxApiCache";
import { parseLatLngArray } from "../../../../lib/mapboxCoordsValidate";
import { getServerMapboxToken } from "../../../../lib/mapboxServerToken";
import { rateLimitAllow } from "../../../../lib/mapboxRateLimit";

export const runtime = "nodejs";

const cache = new LruJsonCache<unknown>(128);

/** Mapbox Matching API max coordinates (walking profile). */
const MAX_MATCH_COORDS = 100;

function clientKey(req: Request): string {
  const h = req.headers.get("x-forwarded-for");
  if (h) return h.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function cacheKey(coords: [number, number][], tidy: boolean, radiusM: number) {
  const parts: string[] = [
    "match",
    tidy ? "1" : "0",
    String(radiusM),
    String(coords.length),
  ];
  for (let i = 0; i < coords.length; i++) {
    const [a, b] = coords[i]!;
    parts.push(String(Math.round(a * 1e5)), String(Math.round(b * 1e5)));
  }
  return parts.join(",");
}

export async function POST(req: Request) {
  if (!rateLimitAllow(clientKey(req), 90)) {
    return NextResponse.json({ error: "Rate limit" }, { status: 429 });
  }

  const token = getServerMapboxToken();
  if (!token) {
    return NextResponse.json(
      { error: "Mapbox token not configured on server" },
      { status: 503 },
    );
  }

  let body: {
    coordinates?: unknown;
    tidy?: unknown;
    radiusMeters?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const coords = parseLatLngArray(body.coordinates, MAX_MATCH_COORDS);
  if (!coords) {
    return NextResponse.json(
      { error: `coordinates must be [lat,lng][] length 2–${MAX_MATCH_COORDS}` },
      { status: 400 },
    );
  }

  const tidy = body.tidy === true;
  const radiusM =
    typeof body.radiusMeters === "number" &&
    Number.isFinite(body.radiusMeters) &&
    body.radiusMeters > 0 &&
    body.radiusMeters <= 50
      ? Math.round(body.radiusMeters)
      : 28;

  const key = cacheKey(coords, tidy, radiusM);
  const hit = cache.get(key);
  if (hit !== undefined) {
    return NextResponse.json(hit);
  }

  const coordString = coords.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = new URL(
    `https://api.mapbox.com/matching/v5/mapbox/walking/${coordString}`,
  );
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("steps", "false");
  url.searchParams.set("tidy", tidy ? "true" : "false");
  url.searchParams.set("radiuses", coords.map(() => String(radiusM)).join(";"));
  url.searchParams.set("access_token", token);

  const res = await fetch(url.toString());
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return NextResponse.json(
      { error: "Mapbox returned non-JSON", status: res.status },
      { status: 502 },
    );
  }

  if (!res.ok) {
    return NextResponse.json(data, { status: res.status });
  }

  cache.set(key, data);
  return NextResponse.json(data);
}
