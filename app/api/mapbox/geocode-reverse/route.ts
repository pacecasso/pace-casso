import { NextResponse } from "next/server";
import { LruJsonCache } from "../../../../lib/mapboxApiCache";
import { isValidLatLng } from "../../../../lib/mapboxCoordsValidate";
import { getServerMapboxToken } from "../../../../lib/mapboxServerToken";
import { rateLimitAllow } from "../../../../lib/mapboxRateLimit";

export const runtime = "nodejs";

const cache = new LruJsonCache<unknown>(512);

function clientKey(req: Request): string {
  const h = req.headers.get("x-forwarded-for");
  if (h) return h.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(req: Request) {
  if (!rateLimitAllow(clientKey(req), 200)) {
    return NextResponse.json({ error: "Rate limit" }, { status: 429 });
  }

  const token = getServerMapboxToken();
  if (!token) {
    return NextResponse.json(
      { error: "Mapbox token not configured on server" },
      { status: 503 },
    );
  }

  let body: { lat?: unknown; lng?: unknown; limit?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!isValidLatLng([lat, lng])) {
    return NextResponse.json({ error: "Invalid lat/lng" }, { status: 400 });
  }

  const limRaw = Number(body.limit);
  const limit =
    Number.isFinite(limRaw) && limRaw >= 1 && limRaw <= 10
      ? Math.floor(limRaw)
      : 10;

  const key = `rg:${Math.round(lat * 1e6)}:${Math.round(lng * 1e6)}:${limit}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return NextResponse.json(hit);
  }

  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`,
  );
  url.searchParams.set("types", "address,street");
  url.searchParams.set("language", "en");
  url.searchParams.set("limit", String(limit));
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
