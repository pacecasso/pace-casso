import { simplifyLatLng } from "../lib/douglasPeucker";

export type LatLng = [number, number]; // [lat, lng]

type SimplifyOptions = {
  maxPoints?: number;
  minPoints?: number;
  toleranceMeters?: number;
};

export function simplifyRoute(
  coords: LatLng[],
  options: SimplifyOptions = {},
): LatLng[] {
  const maxPoints = options.maxPoints ?? 60;
  const minPoints = options.minPoints ?? 20;
  const toleranceMeters = options.toleranceMeters ?? 25;

  if (coords.length <= maxPoints) {
    return coords;
  }

  let simplified = simplifyLatLng(coords, toleranceMeters) as LatLng[];

  if (simplified.length > maxPoints) {
    const step = Math.ceil(simplified.length / maxPoints);
    const reduced: LatLng[] = [];
    for (let i = 0; i < simplified.length; i += step) {
      reduced.push(simplified[i]!);
    }
    if (reduced[reduced.length - 1] !== simplified[simplified.length - 1]) {
      reduced.push(simplified[simplified.length - 1]!);
    }
    simplified = reduced;
  }

  if (simplified.length < minPoints) {
    return coords;
  }

  return simplified;
}

