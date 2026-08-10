import type { MapNativeCandidate } from "./mapNativeDesigner";
import { haversineMeters } from "./haversine";
import type { RouteLineString } from "./routeTypes";

/**
 * Verified trophy route compiled onto the Manhattan street lattice.
 * Source proof: tmp-local-icon-tournament-2-20260724/trophy-classic-flatiron-s1-flip-blind.png.
 */
export const CURATED_TROPHY_MANHATTAN_COORDS: [number, number][] = [
  [40.7477740, -73.9850380],
  [40.7490300, -73.9880170],
  [40.7490950, -73.9880020],
  [40.7490300, -73.9880170],
  [40.7491220, -73.9882350],
  [40.7495630, -73.9879130],
  [40.7498630, -73.9878920],
  [40.7510090, -73.9906120],
  [40.7503420, -73.9910990],
  [40.7510090, -73.9906120],
  [40.7521990, -73.9934580],
  [40.7515320, -73.9939430],
  [40.7527420, -73.9968170],
  [40.7534080, -73.9963180],
  [40.7527420, -73.9968170],
  [40.7515070, -73.9977250],
  [40.7509070, -73.9981550],
  [40.7502750, -73.9986120],
  [40.7490560, -73.9957290],
  [40.7484350, -73.9961920],
  [40.7478360, -73.9966340],
  [40.7472170, -73.9970850],
  [40.7460180, -73.9942530],
  [40.7466180, -73.9938130],
  [40.7454210, -73.9909680],
  [40.7460380, -73.9905180],
  [40.7466660, -73.9900680],
  [40.7460480, -73.9886100],
  [40.7467960, -73.9884730],
  [40.7475460, -73.9883330],
  [40.7465310, -73.9859430],
  [40.7471520, -73.9854900],
  [40.7477740, -73.9850380],
  [40.7484540, -73.9845450],
  [40.7477740, -73.9850380],
  [40.7471520, -73.9854900],
  [40.7465310, -73.9859430],
  [40.7475460, -73.9883330],
  [40.7465310, -73.9859430],
  [40.7471520, -73.9854900],
  [40.7464820, -73.9838910],
  [40.7458590, -73.9843460],
  [40.7452500, -73.9847940],
  [40.7446310, -73.9852430],
  [40.7453010, -73.9868460],
  [40.7460480, -73.9886100],
  [40.7466660, -73.9900680],
  [40.7478630, -73.9929050],
  [40.7490560, -73.9957290],
  [40.7502750, -73.9986120],
  [40.7514580, -74.0014180],
  [40.7520750, -74.0009800],
  [40.7526900, -74.0005300],
  [40.7539190, -73.9996340],
  [40.7526900, -74.0005300],
  [40.7515070, -73.9977250],
  [40.7502940, -73.9948450],
  [40.7496740, -73.9952960],
  [40.7490560, -73.9957290],
  [40.7484350, -73.9961920],
  [40.7472360, -73.9933620],
  [40.7466180, -73.9938130],
  [40.7460180, -73.9942530],
  [40.7453830, -73.9947090],
  [40.7447650, -73.9951590],
  [40.7441070, -73.9956380],
  [40.7429100, -73.9927980],
  [40.7441070, -73.9956380],
  [40.7453050, -73.9984720],
  [40.7441070, -73.9956380],
  [40.7434310, -73.9961300],
  [40.7422330, -73.9932920],
  [40.7416290, -73.9937320],
  [40.7428250, -73.9965700],
  [40.7440250, -73.9994130],
];

export const CURATED_TROPHY_DESIGN_INTENT =
  "Verified trophy Manhattan v1: street-lattice trophy cup with broad bowl, side handles, central stem, and stepped base.";

function routeKm(coords: [number, number][]): number {
  let meters = 0;
  for (let i = 1; i < coords.length; i++) {
    meters += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return meters / 1000;
}

function placementFrom(coords: [number, number][]) {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const [lat, lng] of coords) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  }
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

export function curatedTrophyRouteKm(): number {
  return routeKm(CURATED_TROPHY_MANHATTAN_COORDS);
}

export function curatedTrophyManhattanMapNativeCandidate(): MapNativeCandidate {
  return {
    placement: placementFrom(CURATED_TROPHY_MANHATTAN_COORDS),
    anchors: CURATED_TROPHY_MANHATTAN_COORDS,
    km: curatedTrophyRouteKm(),
    designIntent: CURATED_TROPHY_DESIGN_INTENT,
    kind: "street-design",
    routeMode: "direct-grid",
  };
}

export function curatedTrophyRouteLine(): RouteLineString {
  return {
    coordinates: CURATED_TROPHY_MANHATTAN_COORDS,
    distanceMeters: curatedTrophyRouteKm() * 1000,
    blockWaypoints: CURATED_TROPHY_MANHATTAN_COORDS,
  };
}
