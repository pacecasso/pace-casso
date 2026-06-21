import { haversineMeters } from "./haversine";
import type { RouteLineString } from "./routeTypes";

type Waypoint = [number, number];

export type RouteSpurCleanupResult = {
  route: RouteLineString;
  removedCount: number;
};

function finiteWaypoint(p: Waypoint | undefined): p is Waypoint {
  return (
    Array.isArray(p) &&
    typeof p[0] === "number" &&
    Number.isFinite(p[0]) &&
    typeof p[1] === "number" &&
    Number.isFinite(p[1])
  );
}

function routeDistanceMeters(coords: Waypoint[]): number {
  let meters = 0;
  for (let i = 1; i < coords.length; i++) {
    meters += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return meters;
}

function removeLocalSpurs(
  coords: Waypoint[],
  options: {
    maxSpurMeters: number;
    maxReturnMeters: number;
    minSavingsMeters: number;
    minSavingsRatio: number;
    maxInteriorPoints: number;
  },
): { coords: Waypoint[]; removedCount: number } {
  if (coords.length < 4) return { coords: coords.slice(), removedCount: 0 };
  const out = coords.slice();
  let removedCount = 0;
  let changed = true;

  while (changed) {
    changed = false;
    for (let start = 0; start < out.length - 2; start++) {
      let pathLen = 0;
      const maxEnd = Math.min(
        out.length - 1,
        start + options.maxInteriorPoints + 1,
      );
      for (let end = start + 2; end <= maxEnd; end++) {
        pathLen +=
          end === start + 2
            ? haversineMeters(out[start]!, out[start + 1]!) +
              haversineMeters(out[start + 1]!, out[end]!)
            : haversineMeters(out[end - 1]!, out[end]!);
        if (pathLen > options.maxSpurMeters) break;

        const direct = haversineMeters(out[start]!, out[end]!);
        const savings = pathLen - direct;
        if (direct > options.maxReturnMeters) continue;
        if (savings < options.minSavingsMeters) continue;
        if (direct / pathLen > options.minSavingsRatio) continue;

        const deleteCount = end - start - 1;
        out.splice(start + 1, deleteCount);
        removedCount += deleteCount;
        changed = true;
        break;
      }
      if (changed) break;
    }
  }

  return { coords: out, removedCount };
}

export function cleanupRouteSpurs(
  route: RouteLineString,
  options: {
    maxSpurMeters?: number;
    maxReturnMeters?: number;
    minSavingsMeters?: number;
    minSavingsRatio?: number;
  } = {},
): RouteSpurCleanupResult {
  const coords = (route.coordinates ?? []).filter(finiteWaypoint);
  if (coords.length < 4) {
    return { route, removedCount: 0 };
  }

  const cleaned = removeLocalSpurs(coords, {
    maxSpurMeters: options.maxSpurMeters ?? 520,
    maxReturnMeters: options.maxReturnMeters ?? 130,
    minSavingsMeters: options.minSavingsMeters ?? 65,
    minSavingsRatio: options.minSavingsRatio ?? 0.62,
    maxInteriorPoints: 3,
  });

  if (cleaned.removedCount === 0 || cleaned.coords.length < 2) {
    return { route, removedCount: 0 };
  }

  const cleanedRoute: RouteLineString = {
    ...route,
    coordinates: cleaned.coords,
    distanceMeters: routeDistanceMeters(cleaned.coords),
    blockWaypoints: undefined,
    preserveBlockWaypoints: false,
  };
  return { route: cleanedRoute, removedCount: cleaned.removedCount };
}
