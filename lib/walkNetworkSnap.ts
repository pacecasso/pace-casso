import { fetchMapboxWalkingDirectionsJson } from "./mapboxClient";
import type { LatLng } from "./routeLegByLeg";

/** Snap a point to the Mapbox walk network via a short probe leg. */
export async function snapAnchorToWalkNetwork(anchor: LatLng): Promise<LatLng> {
  const dLat = 0.00022;
  const probes: LatLng[] = [
    [anchor[0] + dLat, anchor[1]],
    [anchor[0] - dLat, anchor[1]],
    [anchor[0], anchor[1] + 0.00028],
    [anchor[0], anchor[1] - 0.00028],
  ];
  for (const probe of probes) {
    try {
      const data = (await fetchMapboxWalkingDirectionsJson({
        coordinates: [anchor, probe],
        steps: false,
        overview: "full",
      })) as {
        waypoints?: { location?: [number, number] }[];
        routes?: { geometry?: { coordinates?: [number, number][] } }[];
      };
      const loc = data.waypoints?.[0]?.location;
      if (loc) {
        return [Number(loc[1].toFixed(6)), Number(loc[0].toFixed(6))];
      }
      const c = data.routes?.[0]?.geometry?.coordinates?.[0];
      if (c) return [Number(c[1].toFixed(6)), Number(c[0].toFixed(6))];
    } catch {
      /* try next probe */
    }
  }
  return anchor;
}

export async function snapAnchorsToWalkNetwork(
  anchors: LatLng[],
  delayMs = 0,
): Promise<LatLng[]> {
  const out: LatLng[] = [];
  for (const a of anchors) {
    out.push(await snapAnchorToWalkNetwork(a));
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}
