import { getServerMapboxToken } from "./mapboxServerToken";
import type { LatLng } from "./routeLegByLeg";

export type IntersectionQuery = {
  id: string;
  label: string;
  queries: string[];
};

const DEFAULT_PROXIMITY = "-73.99,40.73";
/** Manhattan island bbox — rejects Hudson River / Brooklyn hits. */
const MANHATTAN_BBOX = "-74.019,40.704,-73.907,40.876";

/** Hand-verified fallbacks when Mapbox geocoder returns wrong place names. */
export const VERIFIED_INTERSECTION_COORDS: Record<string, LatLng> = {
  "bleecker-7av": [40.727865, -73.998443],
  "w10-7av": [40.734241, -73.998512],
  "w10-bway": [40.734241, -73.996912],
  "w9-bway": [40.733312, -73.996934],
  "w9-6av": [40.733312, -73.999891],
  "w9-bway-after": [40.733312, -73.996934],
  "bleecker-bway": [40.727912, -73.995178],
  "bleecker-lag": [40.727912, -73.998954],
  "houston-lag": [40.725283, -73.998954],
  "houston-bowery": [40.725283, -73.991603],
  "e4-bowery": [40.727087, -73.99155],
  "e4-2av": [40.726188, -73.989429],
  // Person head box — shared lat/lng on each side
  "e9-2av": [40.729202, -73.987233],
  "e9-av-a": [40.729202, -73.982654],
  "e7-av-a": [40.726051, -73.982654],
  "e7-2av": [40.726051, -73.98812],
  "e9-2av-close": [40.729202, -73.987233],
  "e8-2av": [40.728604, -73.988978],
  "e5-2av": [40.7268, -73.988978],
  "e5-1av": [40.7268, -73.986623],
  "e5-av-b": [40.7268, -73.982083],
  "e8-av-a": [40.728604, -73.982654],
};

export async function geocodeIntersection(
  query: IntersectionQuery,
  proximity = DEFAULT_PROXIMITY,
): Promise<LatLng | null> {
  const verified = VERIFIED_INTERSECTION_COORDS[query.id];
  if (verified) return verified;

  const token = getServerMapboxToken();
  if (!token) return null;
  for (const q of query.queries) {
    const url = new URL(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`,
    );
    url.searchParams.set("access_token", token);
    url.searchParams.set("limit", "1");
    url.searchParams.set("proximity", proximity);
    url.searchParams.set("bbox", MANHATTAN_BBOX);
    url.searchParams.set("country", "US");
    url.searchParams.set("types", "address,poi");
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = (await res.json()) as {
      features?: { center?: [number, number]; place_name?: string }[];
    };
    const f = data.features?.[0];
    if (!f?.center) continue;
    const [lng, lat] = f.center;
    return [Number(lat.toFixed(6)), Number(lng.toFixed(6))];
  }
  return null;
}

export async function geocodeIntersectionChain(
  stops: IntersectionQuery[],
  delayMs = 120,
): Promise<{ id: string; label: string; coords: LatLng | null }[]> {
  const out: { id: string; label: string; coords: LatLng | null }[] = [];
  for (const stop of stops) {
    const coords = await geocodeIntersection(stop);
    out.push({ id: stop.id, label: stop.label, coords });
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}

/** GAS logo — West Village pump through East Village person. */
export const GAS_LOGO_INTERSECTION_QUERIES: IntersectionQuery[] = [
  {
    id: "bleecker-7av",
    label: "Bleecker St & 7th Ave S",
    queries: [
      "Bleecker Street and 7th Avenue South, New York, NY",
      "7th Avenue South and Bleecker Street, Manhattan",
    ],
  },
  {
    id: "w10-7av",
    label: "W 10th St & 7th Ave S",
    queries: [
      "West 10th Street and 7th Avenue South, New York, NY",
      "7th Avenue South and West 10th Street, Manhattan",
    ],
  },
  {
    id: "w10-bway",
    label: "W 10th St & Broadway",
    queries: [
      "West 10th Street and Broadway, New York, NY",
      "Broadway and West 10th Street, Manhattan",
    ],
  },
  {
    id: "w9-bway",
    label: "W 9th St & Broadway",
    queries: [
      "West 9th Street and Broadway, New York, NY",
      "Broadway and West 9th Street, Manhattan",
    ],
  },
  {
    id: "w9-6av",
    label: "W 9th St & 6th Ave",
    queries: [
      "West 9th Street and 6th Avenue, New York, NY",
      "6th Avenue and West 9th Street, Manhattan",
    ],
  },
  {
    id: "w9-bway-after",
    label: "W 9th St & Broadway (pump exit)",
    queries: ["West 9th Street and Broadway, New York, NY"],
  },
  {
    id: "bleecker-bway",
    label: "Bleecker St & Broadway",
    queries: [
      "Bleecker Street and Broadway, New York, NY",
      "Broadway and Bleecker Street, Manhattan",
    ],
  },
  {
    id: "bleecker-lag",
    label: "Bleecker St & LaGuardia Pl",
    queries: [
      "Bleecker Street and LaGuardia Place, New York, NY",
      "LaGuardia Place and Bleecker Street, Manhattan",
    ],
  },
  {
    id: "houston-lag",
    label: "Houston St & LaGuardia Pl",
    queries: ["Houston Street and LaGuardia Place, New York, NY"],
  },
  {
    id: "houston-bowery",
    label: "Houston St & Bowery",
    queries: ["Houston Street and Bowery, New York, NY"],
  },
  {
    id: "e4-bowery",
    label: "E 4th St & Bowery",
    queries: [
      "East 4th Street and Bowery, New York, NY",
      "Bowery and East 4th Street, Manhattan",
    ],
  },
  {
    id: "e4-2av",
    label: "E 4th St & 2nd Ave",
    queries: [
      "East 4th Street and 2nd Avenue, New York, NY",
      "2nd Avenue and East 4th Street, Manhattan",
    ],
  },
  {
    id: "e9-2av",
    label: "E 9th St & 2nd Ave",
    queries: [
      "East 9th Street and 2nd Avenue, New York, NY",
      "2nd Avenue and East 9th Street, Manhattan",
    ],
  },
  {
    id: "e9-av-a",
    label: "E 9th St & Avenue A",
    queries: [
      "East 9th Street and Avenue A, New York, NY",
      "Avenue A and East 9th Street, Manhattan",
    ],
  },
  {
    id: "e7-av-a",
    label: "E 7th St & Avenue A",
    queries: [
      "East 7th Street and Avenue A, New York, NY",
      "Avenue A and East 7th Street, Manhattan",
    ],
  },
  {
    id: "e7-2av",
    label: "E 7th St & 2nd Ave",
    queries: [
      "East 7th Street and 2nd Avenue, New York, NY",
      "2nd Avenue and East 7th Street, Manhattan",
    ],
  },
  {
    id: "e9-2av-close",
    label: "E 9th St & 2nd Ave (head close)",
    queries: ["East 9th Street and 2nd Avenue, New York, NY"],
  },
  {
    id: "e8-2av",
    label: "E 8th St & 2nd Ave",
    queries: [
      "East 8th Street and 2nd Avenue, New York, NY",
      "2nd Avenue and East 8th Street, Manhattan",
    ],
  },
  {
    id: "e5-2av",
    label: "E 5th St & 2nd Ave",
    queries: [
      "East 5th Street and 2nd Avenue, New York, NY",
      "2nd Avenue and East 5th Street, Manhattan",
    ],
  },
  {
    id: "e5-1av",
    label: "E 5th St & 1st Ave",
    queries: [
      "East 5th Street and 1st Avenue, New York, NY",
      "1st Avenue and East 5th Street, Manhattan",
    ],
  },
  {
    id: "e5-av-b",
    label: "E 5th St & Avenue B",
    queries: [
      "East 5th Street and Avenue B, New York, NY",
      "Avenue B and East 5th Street, Manhattan",
    ],
  },
  {
    id: "e8-av-a",
    label: "E 8th St & Avenue A",
    queries: [
      "East 8th Street and Avenue A, New York, NY",
      "Avenue A and East 8th Street, Manhattan",
    ],
  },
];
