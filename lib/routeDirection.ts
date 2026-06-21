import { haversineMeters } from "./haversine";

export type LatLng = [number, number];

const LOOP_CLOSE_THRESHOLD_M = 90;
const DUPLICATE_CLOSE_THRESHOLD_M = 0.5;

export type RouteLegOverride = {
  coords: LatLng[];
  isSpur: boolean;
};

export function reverseRouteDirection<T extends RouteLegOverride>(
  waypoints: LatLng[],
  legOverrides: (T | null)[],
): {
  waypoints: LatLng[];
  legOverrides: (T | null)[];
} {
  const legCount = Math.max(0, waypoints.length - 1);
  return {
    waypoints: [...waypoints].reverse(),
    legOverrides: legOverrides
      .slice(0, legCount)
      .reverse()
      .map((ov) =>
        ov
          ? {
              ...ov,
              coords: [...ov.coords].reverse(),
            }
          : null,
      ) as (T | null)[],
  };
}

export function rotateClosedRouteStart(
  waypoints: LatLng[],
  startIndex: number,
): LatLng[] {
  if (waypoints.length < 2) return waypoints.slice();
  const first = waypoints[0]!;
  const last = waypoints[waypoints.length - 1]!;
  const closeGapM = haversineMeters(first, last);
  const isClosed = closeGapM <= LOOP_CLOSE_THRESHOLD_M;
  const uniqueRing =
    isClosed && closeGapM <= DUPLICATE_CLOSE_THRESHOLD_M
      ? waypoints.slice(0, -1)
      : waypoints.slice();
  if (uniqueRing.length < 2) return waypoints.slice();

  const maxStart = uniqueRing.length - 1;
  const k = Math.max(0, Math.min(maxStart, Math.floor(startIndex)));
  const rotated = [...uniqueRing.slice(k), ...uniqueRing.slice(0, k)];
  if (!isClosed) return rotated;
  return [...rotated, rotated[0]!];
}
