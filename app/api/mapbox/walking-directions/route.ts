import { NextResponse } from "next/server";
import { LruJsonCache } from "../../../../lib/mapboxApiCache";
import { parseLatLngArray } from "../../../../lib/mapboxCoordsValidate";
import { getServerMapboxToken } from "../../../../lib/mapboxServerToken";
import { rateLimitAllow } from "../../../../lib/mapboxRateLimit";

export const runtime = "nodejs";

const cache = new LruJsonCache<unknown>(256);

const MAX_COORDS = 25;

function clientKey(req: Request): string {
  const h = req.headers.get("x-forwarded-for");
  if (h) return h.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function cacheKey(
  coords: [number, number][],
  steps: boolean,
  overview: string,
  language: string,
): string {
  const parts: string[] = [
    "dir",
    steps ? "1" : "0",
    overview,
    language,
    String(coords.length),
  ];
  for (let i = 0; i < Math.min(coords.length, 12); i++) {
    const [a, b] = coords[i]!;
    parts.push(String(Math.round(a * 1e5)), String(Math.round(b * 1e5)));
  }
  for (let i = Math.max(0, coords.length - 12); i < coords.length; i++) {
    const [a, b] = coords[i]!;
    parts.push(String(Math.round(a * 1e5)), String(Math.round(b * 1e5)));
  }
  return parts.join(",");
}

export async function POST(req: Request) {
  if (!rateLimitAllow(clientKey(req), 180)) {
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
    steps?: unknown;
    overview?: unknown;
    language?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const coords = parseLatLngArray(body.coordinates, MAX_COORDS);
  if (!coords) {
    return NextResponse.json(
      { error: "coordinates must be [lat,lng][] length 2–25" },
      { status: 400 },
    );
  }

  const steps = Boolean(body.steps);
  const overview =
    typeof body.overview === "string" && body.overview.length
      ? body.overview
      : "full";
  const language =
    typeof body.language === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.language)
      ? body.language
      : "";

  const key = cacheKey(coords, steps, overview, language || "default");
  const hit = cache.get(key);
  if (hit !== undefined) {
    return NextResponse.json(hit);
  }

  const coordString = coords.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = new URL(
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordString}`,
  );
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", overview);
  url.searchParams.set("steps", steps ? "true" : "false");
  url.searchParams.set("alternatives", "false");
  if (language) url.searchParams.set("language", language);
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
