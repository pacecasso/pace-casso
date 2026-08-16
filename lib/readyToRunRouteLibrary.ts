import {
  CURATED_MANHATTAN_RUNS,
  type CuratedRun,
} from "./curatedManhattanRuns";
import {
  REVERIFIED_CATALOG_IDS,
  VERIFIED_ROUTE_BANK_GALLERY_RUNS,
} from "./verifiedRouteBankGallery";
import {
  CURATED_SNEAKER_MANHATTAN_COORDS,
  curatedSneakerRouteKm,
} from "./curatedSneakerManhattanRoute";
import type { RouteLineString } from "./routeTypes";

const reverifiedIds = new Set<string>(REVERIFIED_CATALOG_IDS);

const tunedSneakerRun: CuratedRun = {
  id: "sneaker",
  title: "PUMA Sneaker",
  icon: "shoe",
  area: "Lower Manhattan - tuned street-native benchmark",
  blurb:
    "A tuned low-top sneaker route with heel, toe panel, long sole, lace comb, and side-panel strokes. Runnable street polyline preserved end to end.",
  distanceKm: Math.round(curatedSneakerRouteKm() * 10) / 10,
  coords: CURATED_SNEAKER_MANHATTAN_COORDS,
};

export const READY_TO_RUN_ROUTE_LIBRARY: CuratedRun[] = [
  tunedSneakerRun,
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
