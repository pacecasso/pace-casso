import { mapboxPublicToken, mapboxUseProxy } from "./mapboxAccess";

async function throwIfBad(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  let detail = res.statusText;
  try {
    const j = (await res.json()) as { message?: string; error?: string };
    detail =
      (typeof j.message === "string" && j.message) ||
      (typeof j.error === "string" && j.error) ||
      JSON.stringify(j);
  } catch {
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
  }
  throw new Error(`${label} (${res.status}): ${detail}`);
}

export async function fetchMapboxWalkingDirectionsJson(input: {
  coordinates: [number, number][];
  steps: boolean;
  overview?: string;
  language?: string;
}): Promise<unknown> {
  const overview = input.overview ?? "full";
  if (mapboxUseProxy()) {
    const res = await fetch("/api/mapbox/walking-directions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coordinates: input.coordinates,
        steps: input.steps,
        overview,
        ...(input.language ? { language: input.language } : {}),
      }),
    });
    await throwIfBad(res, "Mapbox directions proxy");
    return res.json();
  }

  const token = mapboxPublicToken();
  if (!token) {
    throw new Error(
      "Mapbox token missing: set NEXT_PUBLIC_MAPBOX_TOKEN or enable NEXT_PUBLIC_MAPBOX_PROXY with MAPBOX_ACCESS_TOKEN on the server.",
    );
  }

  const coordString = input.coordinates
    .map(([lat, lng]) => `${lng},${lat}`)
    .join(";");
  const url = new URL(
    `https://api.mapbox.com/directions/v5/mapbox/walking/${coordString}`,
  );
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", overview);
  url.searchParams.set("steps", input.steps ? "true" : "false");
  url.searchParams.set("alternatives", "false");
  if (input.language)
    url.searchParams.set("language", input.language);
  url.searchParams.set("access_token", token);

  const res = await fetch(url.toString());
  await throwIfBad(res, "Mapbox directions");
  return res.json();
}

export async function fetchMapboxWalkingMatchingJson(input: {
  coordinates: [number, number][];
  tidy?: boolean;
  radiusMeters?: number;
}): Promise<unknown> {
  if (mapboxUseProxy()) {
    const res = await fetch("/api/mapbox/walking-matching", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coordinates: input.coordinates,
        tidy: input.tidy ?? false,
        radiusMeters: input.radiusMeters,
      }),
    });
    await throwIfBad(res, "Mapbox matching proxy");
    return res.json();
  }

  const token = mapboxPublicToken();
  if (!token) {
    throw new Error(
      "Mapbox token missing: set NEXT_PUBLIC_MAPBOX_TOKEN or enable NEXT_PUBLIC_MAPBOX_PROXY with MAPBOX_ACCESS_TOKEN on the server.",
    );
  }

  const coordString = input.coordinates
    .map(([lat, lng]) => `${lng},${lat}`)
    .join(";");
  const radiusM = input.radiusMeters ?? 28;
  const url = new URL(
    `https://api.mapbox.com/matching/v5/mapbox/walking/${coordString}`,
  );
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("steps", "false");
  url.searchParams.set("tidy", input.tidy ? "true" : "false");
  url.searchParams.set(
    "radiuses",
    input.coordinates.map(() => String(radiusM)).join(";"),
  );
  url.searchParams.set("access_token", token);

  const res = await fetch(url.toString());
  await throwIfBad(res, "Mapbox matching");
  return res.json();
}

export async function fetchMapboxReverseGeocodeJson(input: {
  lat: number;
  lng: number;
  limit?: number;
}): Promise<unknown> {
  if (mapboxUseProxy()) {
    const res = await fetch("/api/mapbox/geocode-reverse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: input.lat,
        lng: input.lng,
        ...(input.limit != null ? { limit: input.limit } : {}),
      }),
    });
    await throwIfBad(res, "Mapbox geocode proxy");
    return res.json();
  }

  const token = mapboxPublicToken();
  if (!token) {
    throw new Error(
      "Mapbox token missing: set NEXT_PUBLIC_MAPBOX_TOKEN or enable NEXT_PUBLIC_MAPBOX_PROXY with MAPBOX_ACCESS_TOKEN on the server.",
    );
  }

  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${input.lng},${input.lat}.json`,
  );
  url.searchParams.set("types", "address,street");
  url.searchParams.set("language", "en");
  const lim =
    input.limit != null &&
    Number.isFinite(input.limit) &&
    input.limit >= 1 &&
    input.limit <= 10
      ? Math.floor(input.limit)
      : 10;
  url.searchParams.set("limit", String(lim));
  url.searchParams.set("access_token", token);

  const res = await fetch(url.toString());
  await throwIfBad(res, "Mapbox geocode");
  return res.json();
}
