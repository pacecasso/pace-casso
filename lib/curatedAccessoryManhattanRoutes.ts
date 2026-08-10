import type { MapNativeCandidate } from "./mapNativeDesigner";
import { haversineMeters } from "./haversine";
import type { RouteLineString } from "./routeTypes";

/**
 * Verified accessory/icon routes compiled onto the Manhattan street lattice.
 * Source proofs:
 * - martini: tmp-agent-icon-search-a-20260724/accepted-contact-sheet-label-free.png
 * - glasses: tmp-local-icon-tournament-20260724/glasses-top-blind-sheet.png
 */
export const CURATED_MARTINI_MANHATTAN_COORDS: [number, number][] = [
  [40.7546370, -73.9989420],
  [40.7546920, -73.9990780],
  [40.7545910, -73.9991490],
  [40.7534080, -73.9963180],
  [40.7521990, -73.9934580],
  [40.7510090, -73.9906120],
  [40.7498630, -73.9878920],
  [40.7495630, -73.9879130],
  [40.7491220, -73.9882350],
  [40.7490300, -73.9880170],
  [40.7490950, -73.9880020],
  [40.7490300, -73.9880170],
  [40.7477740, -73.9850380],
  [40.7484540, -73.9845450],
  [40.7477710, -73.9829610],
  [40.7471010, -73.9834430],
  [40.7477740, -73.9850380],
  [40.7471520, -73.9854900],
  [40.7465310, -73.9859430],
  [40.7475460, -73.9883330],
  [40.7467960, -73.9884730],
  [40.7472770, -73.9896170],
  [40.7466660, -73.9900680],
  [40.7460380, -73.9905180],
  [40.7454210, -73.9909680],
  [40.7466180, -73.9938130],
  [40.7460180, -73.9942530],
  [40.7453830, -73.9947090],
  [40.7460180, -73.9942530],
  [40.7466180, -73.9938130],
  [40.7478360, -73.9966340],
  [40.7484350, -73.9961920],
  [40.7490560, -73.9957290],
  [40.7496740, -73.9952960],
  [40.7509070, -73.9981550],
  [40.7515070, -73.9977250],
  [40.7527420, -73.9968170],
  [40.7539190, -73.9996340],
  [40.7539850, -73.9995860],
  [40.7539440, -73.9994780],
  [40.7539850, -73.9995860],
  [40.7545910, -73.9991490],
  [40.7546920, -73.9990780],
  [40.7546370, -73.9989420],
  [40.7546920, -73.9990780],
  [40.7545910, -73.9991490],
  [40.7534080, -73.9963180],
  [40.7527420, -73.9968170],
  [40.7515070, -73.9977250],
  [40.7509070, -73.9981550],
  [40.7496740, -73.9952960],
  [40.7490560, -73.9957290],
  [40.7484350, -73.9961920],
  [40.7478360, -73.9966340],
  [40.7466180, -73.9938130],
  [40.7460180, -73.9942530],
  [40.7453830, -73.9947090],
  [40.7447650, -73.9951590],
  [40.7441070, -73.9956380],
  [40.7434310, -73.9961300],
  [40.7428250, -73.9965700],
  [40.7422340, -73.9970020],
  [40.7416420, -73.9974340],
  [40.7410560, -73.9978620],
  [40.7422580, -74.0006950],
  [40.7416740, -74.0011230],
  [40.7404700, -73.9982870],
  [40.7392720, -73.9954460],
];

export const CURATED_GLASSES_MANHATTAN_COORDS: [number, number][] = [
  [40.7464100, -74.0050980],
  [40.7470230, -74.0046530],
  [40.7477030, -74.0041640],
  [40.7483550, -74.0036840],
  [40.7489740, -74.0032360],
  [40.7496110, -74.0027750],
  [40.7488510, -74.0009740],
  [40.7484300, -73.9999570],
  [40.7472170, -73.9970850],
  [40.7460180, -73.9942530],
  [40.7453830, -73.9947090],
  [40.7447650, -73.9951590],
  [40.7441070, -73.9956380],
  [40.7434310, -73.9961300],
  [40.7428250, -73.9965700],
  [40.7440250, -73.9994130],
  [40.7452350, -74.0022970],
  [40.7464100, -74.0050980],
  [40.7452350, -74.0022970],
  [40.7458550, -74.0018590],
  [40.7446300, -73.9989690],
  [40.7453050, -73.9984720],
  [40.7441070, -73.9956380],
  [40.7429100, -73.9927980],
  [40.7435680, -73.9923180],
  [40.7429100, -73.9927980],
  [40.7422330, -73.9932920],
  [40.7416290, -73.9937320],
  [40.7402770, -73.9905250],
  [40.7398720, -73.9895640],
  [40.7399200, -73.9895510],
  [40.7399680, -73.9896640],
  [40.7399200, -73.9895510],
  [40.7398720, -73.9895640],
  [40.7389340, -73.9873430],
  [40.7388980, -73.9872590],
  [40.7395080, -73.9868120],
  [40.7401690, -73.9863030],
  [40.7408260, -73.9858270],
  [40.7414520, -73.9853700],
  [40.7420710, -73.9849180],
  [40.7421240, -73.9850460],
  [40.7427710, -73.9865980],
  [40.7434570, -73.9881910],
  [40.7438170, -73.9890280],
  [40.7448190, -73.9914090],
  [40.7441860, -73.9918710],
  [40.7435680, -73.9923180],
  [40.7429100, -73.9927980],
  [40.7422330, -73.9932920],
  [40.7416290, -73.9937320],
  [40.7422330, -73.9932920],
  [40.7408860, -73.9900830],
  [40.7406190, -73.9894420],
  [40.7406760, -73.9894220],
  [40.7407170, -73.9895260],
  [40.7406760, -73.9894220],
  [40.7406180, -73.9892450],
  [40.7406760, -73.9894220],
  [40.7413640, -73.9891380],
  [40.7408810, -73.9879850],
  [40.7402150, -73.9864100],
  [40.7401690, -73.9863030],
  [40.7408260, -73.9858270],
  [40.7401770, -73.9842670],
  [40.7408010, -73.9838160],
  [40.7401250, -73.9822170],
  [40.7407510, -73.9817650],
  [40.7397950, -73.9795310],
  [40.7391810, -73.9799750],
  [40.7401250, -73.9822170],
  [40.7408010, -73.9838160],
  [40.7401770, -73.9842670],
  [40.7408260, -73.9858270],
  [40.7401690, -73.9863030],
  [40.7402150, -73.9864100],
  [40.7408810, -73.9879850],
  [40.7413640, -73.9891380],
  [40.7415510, -73.9895970],
  [40.7422190, -73.9891070],
  [40.7423230, -73.9893530],
  [40.7422710, -73.9893560],
  [40.7423230, -73.9893530],
  [40.7435680, -73.9923180],
  [40.7429100, -73.9927980],
  [40.7441070, -73.9956380],
  [40.7453050, -73.9984720],
  [40.7465210, -74.0013500],
  [40.7477030, -74.0041640],
  [40.7483550, -74.0036840],
  [40.7489740, -74.0032360],
  [40.7501780, -74.0060710],
  [40.7508080, -74.0056220],
  [40.7501780, -74.0060710],
  [40.7489740, -74.0032360],
  [40.7483550, -74.0036840],
  [40.7477030, -74.0041640],
];

export const CURATED_MARTINI_DESIGN_INTENT =
  "Experimental martini Manhattan research route: street-lattice cocktail glass attempt with rim, bowl, stem, and base. Not promoted because label-free north-up proof did not pass blind review.";

export const CURATED_GLASSES_DESIGN_INTENT =
  "Experimental glasses Manhattan research route: street-lattice eyeglasses with two rectangular lenses, bridge, inner lens strokes, and side temple arms. Not promoted until it passes blind review.";

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
function candidateFrom(coords: [number, number][], intent: string): MapNativeCandidate {
  return { placement: placementFrom(coords), anchors: coords, km: routeKm(coords), designIntent: intent, kind: "street-design", routeMode: "direct-grid" };
}
function routeLine(coords: [number, number][]): RouteLineString { return { coordinates: coords, distanceMeters: routeKm(coords) * 1000, blockWaypoints: coords }; }
export function curatedMartiniRouteKm(): number { return routeKm(CURATED_MARTINI_MANHATTAN_COORDS); }
export function curatedGlassesRouteKm(): number { return routeKm(CURATED_GLASSES_MANHATTAN_COORDS); }
export function curatedMartiniManhattanMapNativeCandidate(): MapNativeCandidate { return candidateFrom(CURATED_MARTINI_MANHATTAN_COORDS, CURATED_MARTINI_DESIGN_INTENT); }
export function curatedGlassesManhattanMapNativeCandidate(): MapNativeCandidate { return candidateFrom(CURATED_GLASSES_MANHATTAN_COORDS, CURATED_GLASSES_DESIGN_INTENT); }
export function curatedMartiniRouteLine(): RouteLineString { return routeLine(CURATED_MARTINI_MANHATTAN_COORDS); }
export function curatedGlassesRouteLine(): RouteLineString { return routeLine(CURATED_GLASSES_MANHATTAN_COORDS); }

