import { haversineMeters } from "./haversine";
import { meanBidirectionalErrorMeters } from "./shapeMatchScore";
import type { RouteLineString } from "./routeTypes";

type LatLng = [number, number];

function polylineLengthMeters(coords: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return total;
}

function finiteLatLng(v: unknown): v is LatLng {
  return (
    Array.isArray(v) &&
    typeof v[0] === "number" &&
    Number.isFinite(v[0]) &&
    v[0] >= -90 &&
    v[0] <= 90 &&
    typeof v[1] === "number" &&
    Number.isFinite(v[1]) &&
    v[1] >= -180 &&
    v[1] <= 180
  );
}

function routeCoords(route: RouteLineString | null | undefined): LatLng[] {
  return (route?.coordinates ?? []).filter(finiteLatLng);
}

export function preferredSnappedRouteFitsAnchor(
  anchorLatLngs: LatLng[],
  route: RouteLineString | null | undefined,
): boolean {
  if (anchorLatLngs.length < 2 || !anchorLatLngs.every(finiteLatLng)) {
    return false;
  }
  const coords = routeCoords(route);
  if (coords.length < 2) return false;

  const anchorLengthM = polylineLengthMeters(anchorLatLngs);
  const routeLengthM =
    typeof route?.distanceMeters === "number" &&
    Number.isFinite(route.distanceMeters) &&
    route.distanceMeters > 0
      ? route.distanceMeters
      : polylineLengthMeters(coords);
  if (anchorLengthM <= 0 || routeLengthM <= 0) return false;

  const lengthRatio = routeLengthM / anchorLengthM;
  if (lengthRatio < 0.35 || lengthRatio > 2.6) return false;

  const meanErrorM = meanBidirectionalErrorMeters(anchorLatLngs, coords);
  if (meanErrorM == null || !Number.isFinite(meanErrorM)) return false;

  const allowedErrorM = Math.max(450, anchorLengthM * 0.32);
  return meanErrorM <= allowedErrorM;
}
