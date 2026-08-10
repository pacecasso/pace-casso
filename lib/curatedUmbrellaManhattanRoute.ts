import type { MapNativeCandidate } from "./mapNativeDesigner";
import { haversineMeters } from "./haversine";
import type { RouteLineString } from "./routeTypes";

/**
 * Verified umbrella route compiled onto the Manhattan street lattice.
 * Source proof: tmp-local-icon-tournament-2-20260724/best-blind-sheet.png.
 */
export const CURATED_UMBRELLA_MANHATTAN_COORDS: [number, number][] = [
  [40.7594380, -73.9851370],
  [40.7601130, -73.9848200],
  [40.7600190, -73.9847890],
  [40.7601130, -73.9848200],
  [40.7598410, -73.9841740],
  [40.7604630, -73.9837060],
  [40.7610950, -73.9832500],
  [40.7617190, -73.9828070],
  [40.7623480, -73.9823470],
  [40.7618650, -73.9811970],
  [40.7612820, -73.9816280],
  [40.7618650, -73.9811970],
  [40.7611560, -73.9795130],
  [40.7617740, -73.9790630],
  [40.7604080, -73.9758440],
  [40.7610470, -73.9753810],
  [40.7603710, -73.9737660],
  [40.7597320, -73.9742310],
  [40.7590980, -73.9727040],
  [40.7590250, -73.9725320],
  [40.7584110, -73.9729810],
  [40.7577570, -73.9714430],
  [40.7571290, -73.9719040],
  [40.7564580, -73.9703200],
  [40.7558330, -73.9707760],
  [40.7552040, -73.9712360],
  [40.7545780, -73.9716940],
  [40.7539540, -73.9721490],
  [40.7546130, -73.9737340],
  [40.7552510, -73.9732670],
  [40.7559030, -73.9748080],
  [40.7565260, -73.9743560],
  [40.7565990, -73.9745280],
  [40.7559780, -73.9749830],
  [40.7553470, -73.9754420],
  [40.7556020, -73.9760650],
  [40.7559870, -73.9769640],
  [40.7566590, -73.9785570],
  [40.7560370, -73.9790230],
  [40.7554130, -73.9794890],
  [40.7547830, -73.9799430],
  [40.7541650, -73.9803920],
  [40.7534810, -73.9808790],
  [40.7528880, -73.9813260],
  [40.7528560, -73.9812440],
  [40.7528880, -73.9813260],
  [40.7528160, -73.9813800],
  [40.7527650, -73.9814180],
  [40.7527230, -73.9813320],
  [40.7527650, -73.9814180],
  [40.7522690, -73.9817770],
  [40.7522050, -73.9818240],
  [40.7522690, -73.9817770],
  [40.7522360, -73.9816940],
  [40.7522690, -73.9817770],
  [40.7522050, -73.9818240],
  [40.7515350, -73.9802220],
  [40.7521400, -73.9797790],
  [40.7528120, -73.9792870],
  [40.7534810, -73.9808790],
  [40.7528880, -73.9813260],
  [40.7528560, -73.9812440],
  [40.7528880, -73.9813260],
  [40.7528160, -73.9813800],
  [40.7527650, -73.9814180],
  [40.7527230, -73.9813320],
  [40.7527650, -73.9814180],
  [40.7522690, -73.9817770],
  [40.7522360, -73.9816940],
  [40.7522690, -73.9817770],
  [40.7527650, -73.9814180],
  [40.7528160, -73.9813800],
  [40.7528880, -73.9813260],
  [40.7528560, -73.9812440],
  [40.7528880, -73.9813260],
  [40.7534810, -73.9808790],
  [40.7541650, -73.9803920],
  [40.7547830, -73.9799430],
  [40.7554130, -73.9794890],
  [40.7560370, -73.9790230],
  [40.7566590, -73.9785570],
  [40.7572830, -73.9781110],
  [40.7578320, -73.9794060],
  [40.7586450, -73.9813410],
  [40.7580160, -73.9817970],
  [40.7586450, -73.9813410],
  [40.7592740, -73.9808830],
  [40.7586450, -73.9813410],
  [40.7580160, -73.9817970],
  [40.7592230, -73.9846190],
  [40.7593910, -73.9850230],
  [40.7594950, -73.9849850],
  [40.7593910, -73.9850230],
  [40.7594380, -73.9851370],
];

export const CURATED_UMBRELLA_DESIGN_INTENT =
  "Verified umbrella Manhattan v1: street-lattice umbrella with arched canopy, scalloped lower edge, central shaft, and handle.";

function routeKm(coords: [number, number][]): number {
  let meters = 0;
  for (let i = 1; i < coords.length; i++) meters += haversineMeters(coords[i - 1]!, coords[i]!);
  return meters / 1000;
}
function placementFrom(coords: [number, number][]) {
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const [lat, lng] of coords) { south = Math.min(south, lat); north = Math.max(north, lat); west = Math.min(west, lng); east = Math.max(east, lng); }
  return {
    south,
    west,
    north,
    east,
    center: [(south + north) / 2, (west + east) / 2] as [number, number],
    rotationDeg: 29,
    scale: 1,
  };
}
export function curatedUmbrellaRouteKm(): number { return routeKm(CURATED_UMBRELLA_MANHATTAN_COORDS); }
export function curatedUmbrellaManhattanMapNativeCandidate(): MapNativeCandidate {
  return { placement: placementFrom(CURATED_UMBRELLA_MANHATTAN_COORDS), anchors: CURATED_UMBRELLA_MANHATTAN_COORDS, km: curatedUmbrellaRouteKm(), designIntent: CURATED_UMBRELLA_DESIGN_INTENT, kind: "street-design", routeMode: "direct-grid" };
}
export function curatedUmbrellaRouteLine(): RouteLineString {
  return { coordinates: CURATED_UMBRELLA_MANHATTAN_COORDS, distanceMeters: curatedUmbrellaRouteKm() * 1000, blockWaypoints: CURATED_UMBRELLA_MANHATTAN_COORDS };
}
