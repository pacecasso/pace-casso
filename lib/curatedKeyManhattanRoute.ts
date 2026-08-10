import type { MapNativeCandidate } from "./mapNativeDesigner";
import { haversineMeters } from "./haversine";
import type { RouteLineString } from "./routeTypes";

/**
 * Verified key route compiled onto the Manhattan street lattice.
 * Source proof: tmp-key-lattice-proof-20260724/double-tooth-chelsea.gpx.
 */
export const CURATED_KEY_MANHATTAN_COORDS: [number, number][] = [
  [40.7452310, -74.0059600],
  [40.7458170, -74.0055340],
  [40.7464100, -74.0050980],
  [40.7470230, -74.0046530],
  [40.7477030, -74.0041640],
  [40.7483550, -74.0036840],
  [40.7489740, -74.0032360],
  [40.7496110, -74.0027750],
  [40.7502290, -74.0023140],
  [40.7508280, -74.0018820],
  [40.7496970, -73.9991780],
  [40.7496590, -73.9990650],
  [40.7496000, -73.9991070],
  [40.7495500, -73.9989860],
  [40.7496000, -73.9991070],
  [40.7496590, -73.9990650],
  [40.7493380, -73.9973650],
  [40.7484350, -73.9961920],
  [40.7472360, -73.9933620],
  [40.7466180, -73.9938130],
  [40.7460180, -73.9942530],
  [40.7453830, -73.9947090],
  [40.7447650, -73.9951590],
  [40.7441070, -73.9956380],
  [40.7434310, -73.9961300],
  [40.7428250, -73.9965700],
  [40.7422340, -73.9970020],
  [40.7416420, -73.9974340],
  [40.7428470, -74.0002680],
  [40.7440560, -74.0031550],
  [40.7452310, -74.0059600],
  [40.7458170, -74.0055340],
  [40.7446390, -74.0027320],
  [40.7452350, -74.0022970],
  [40.7458550, -74.0018590],
  [40.7465210, -74.0013500],
  [40.7471710, -74.0008680],
  [40.7477910, -74.0004220],
  [40.7484300, -73.9999570],
  [40.7488510, -74.0009740],
  [40.7484300, -73.9999570],
  [40.7472170, -73.9970850],
  [40.7465800, -73.9975500],
  [40.7459650, -73.9979900],
  [40.7453050, -73.9984720],
  [40.7446300, -73.9989690],
  [40.7458550, -74.0018590],
  [40.7446300, -73.9989690],
  [40.7453050, -73.9984720],
  [40.7441070, -73.9956380],
  [40.7447650, -73.9951590],
  [40.7435680, -73.9923180],
  [40.7423230, -73.9893530],
  [40.7423750, -73.9893480],
  [40.7423230, -73.9893530],
  [40.7422710, -73.9893560],
  [40.7423230, -73.9893530],
  [40.7422190, -73.9891070],
  [40.7415510, -73.9895970],
  [40.7413640, -73.9891380],
  [40.7408810, -73.9879850],
  [40.7415450, -73.9875060],
  [40.7408740, -73.9859400],
  [40.7402150, -73.9864100],
  [40.7408740, -73.9859400],
  [40.7415050, -73.9854970],
  [40.7421240, -73.9850460],
  [40.7420710, -73.9849180],
  [40.7414160, -73.9833670],
  [40.7408010, -73.9838160],
  [40.7401770, -73.9842670],
  [40.7395140, -73.9847520],
  [40.7401770, -73.9842670],
  [40.7395000, -73.9826690],
  [40.7388380, -73.9831490],
  [40.7381710, -73.9836360],
  [40.7375570, -73.9840840],
  [40.7379280, -73.9849580],
  [40.7382280, -73.9856740],
  [40.7379280, -73.9849580],
  [40.7373280, -73.9853900],
  [40.7376390, -73.9861200],
  [40.7370550, -73.9865430],
  [40.7376390, -73.9861200],
  [40.7379460, -73.9868470],
  [40.7383030, -73.9876930],
  [40.7377160, -73.9881180],
  [40.7377530, -73.9882050],
  [40.7383380, -73.9877780],
  [40.7389340, -73.9873430],
  [40.7395450, -73.9869000],
  [40.7402150, -73.9864100],
  [40.7408740, -73.9859400],
];

export const CURATED_KEY_DESIGN_INTENT =
  "Verified key Manhattan v1: street-lattice key with square bow, inner hole, long shaft, and two stepped teeth.";

export function curatedKeyRouteKm(): number {
  let meters = 0;
  const coords = CURATED_KEY_MANHATTAN_COORDS;
  for (let i = 1; i < coords.length; i++) meters += haversineMeters(coords[i - 1]!, coords[i]!);
  return meters / 1000;
}

export function curatedKeyManhattanMapNativeCandidate(): MapNativeCandidate {
  const anchors = CURATED_KEY_MANHATTAN_COORDS;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of anchors) { minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng); }
  return {
    placement: { center: [(minLat + maxLat) / 2, (minLng + maxLng) / 2], rotationDeg: 29, scale: 1 },
    anchors,
    km: curatedKeyRouteKm(),
    designIntent: CURATED_KEY_DESIGN_INTENT,
    kind: "street-design",
    routeMode: "direct-grid",
  };
}

export function curatedKeyRouteLine(): RouteLineString {
  const coords = CURATED_KEY_MANHATTAN_COORDS;
  return { coordinates: coords, distanceMeters: curatedKeyRouteKm() * 1000, blockWaypoints: coords };
}
