import {
  CURATED_MANHATTAN_RUNS,
  type CuratedRun,
} from "./curatedManhattanRuns";
import {
  REVERIFIED_CATALOG_IDS,
  VERIFIED_ROUTE_BANK_GALLERY_RUNS,
} from "./verifiedRouteBankGallery";
import type { RouteLineString } from "./routeTypes";

const reverifiedIds = new Set<string>(REVERIFIED_CATALOG_IDS);

export const READY_TO_RUN_ROUTE_LIBRARY: CuratedRun[] = [
  ...CURATED_MANHATTAN_RUNS.filter((run) => reverifiedIds.has(run.id)),
  ...VERIFIED_ROUTE_BANK_GALLERY_RUNS,
];

export function readyRouteToLine(run: CuratedRun): RouteLineString {
  const coords = run.coords.map(([lat, lng]) => [lat, lng] as [number, number]);
  return {
    coordinates: coords,
    distanceMeters: run.distanceKm * 1000,
    blockWaypoints: coords,
    preserveBlockWaypoints: true,
  };
}
