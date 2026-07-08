import type { LatLng } from "./routeLegByLeg";
import { VERIFIED_INTERSECTION_COORDS } from "./nycIntersectionGeocode";
import { GAS_LOGO_INTERSECTION_QUERIES } from "./nycIntersectionGeocode";

export type GasIntersectionStop = {
  id: string;
  label: string;
  coords: LatLng;
};

/** Ordered pump → hose → person on verified Manhattan intersections. */
export function gasLogoIntersectionStops(): GasIntersectionStop[] {
  return GAS_LOGO_INTERSECTION_QUERIES.map((q) => ({
    id: q.id,
    label: q.label,
    coords: VERIFIED_INTERSECTION_COORDS[q.id]!,
  }));
}

export function gasLogoIntersectionAnchors(): LatLng[] {
  return gasLogoIntersectionStops().map((s) => s.coords);
}
