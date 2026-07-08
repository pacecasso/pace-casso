import { gasPumpPersonStructureScore, routeShapeMatchPercent } from "./autoFindTop5";
import {
  gasLogoSparseGrid,
  MANHATTAN_STREET_BEARING_DEG,
} from "./gasLogoGridTemplate";
import { gasLogoIntersectionAnchors } from "./gasLogoIntersections";
import {
  assertAxisAlignedAnchors,
  decomposeToAxisAnchors,
  mergeCollinearOutline,
  removeAdjacentBacktracks,
} from "./gridRouteUtils";
import {
  projectGridToLatLngDual,
  routeLengthKm,
  type LatLng,
} from "./gridRouteProjection";
import { haversineMeters } from "./haversine";
import { isOnManhattanWalkable } from "./manhattanWalkableEnvelope";
import { routeLegByLegResilient } from "./routeLegByLeg";
import { routeQualityScore } from "./routeQuality";
import { snapAnchorsToWalkNetwork } from "./walkNetworkSnap";

export type GasLogoPlacement = {
  center: LatLng;
  streetMeters: number;
  avenueMeters: number;
  streetBearingDeg?: number;
};

export type GasLogoRouteBuildOptions = {
  maxLegMeters?: number;
  snapDelayMs?: number;
  /** Reject if any consecutive geometry points exceed this (catches block chords). */
  maxHopMeters?: number;
};

export type GasLogoRouteResult = {
  ok: true;
  source: "named-intersections" | "grid-placement";
  anchors: LatLng[];
  coordinates: LatLng[];
  km: number;
  maxHopMeters: number;
  rejectedLegs: number;
  structureScore: number;
  shapeMatch: number;
  qualityScore: number;
  placement: { center: LatLng; rotationDeg: number; scale: number };
};

export type GasLogoRouteFailure = {
  ok: false;
  reason: string;
};

export function maxHopMeters(coords: LatLng[]): number {
  let max = 0;
  for (let i = 1; i < coords.length; i++) {
    max = Math.max(max, haversineMeters(coords[i - 1]!, coords[i]!));
  }
  return max;
}

function placementFromAnchors(anchors: LatLng[]): {
  center: LatLng;
  rotationDeg: number;
  scale: number;
} {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of anchors) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  return {
    center: [(minLat + maxLat) / 2, (minLng + maxLng) / 2],
    rotationDeg: MANHATTAN_STREET_BEARING_DEG,
    scale: 1,
  };
}

async function routeFromAxisAnchors(
  axis: LatLng[],
  options: GasLogoRouteBuildOptions,
  meta: { source: GasLogoRouteResult["source"]; placement: GasLogoRouteResult["placement"] },
): Promise<GasLogoRouteResult | GasLogoRouteFailure> {
  if (!assertAxisAlignedAnchors(axis)) {
    return { ok: false, reason: "anchors not axis-aligned" };
  }
  if (axis.some(([lat, lng]) => !isOnManhattanWalkable(lat, lng))) {
    return { ok: false, reason: "anchor off Manhattan walkable envelope" };
  }

  const maxLeg = options.maxLegMeters ?? 1200;
  let routed;
  try {
    routed = await routeLegByLegResilient(axis, {
      maxLegMeters: maxLeg,
      validatePoint: ([lat, lng]) => isOnManhattanWalkable(lat, lng),
    });
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  if (routed.rejectedLegs > 0) {
    return { ok: false, reason: `rejected legs: ${routed.rejectedLegs}` };
  }

  const cleaned = removeAdjacentBacktracks(routed.coordinates, 15);
  if (cleaned.some(([lat, lng]) => !isOnManhattanWalkable(lat, lng))) {
    return { ok: false, reason: "route left walkable envelope" };
  }

  const hop = maxHopMeters(cleaned);
  const maxHop = options.maxHopMeters ?? 320;
  if (hop > maxHop) {
    return { ok: false, reason: `max hop ${hop.toFixed(0)}m > ${maxHop}m` };
  }

  const km = routeLengthKm(cleaned);
  if (km < 6 || km > 22) {
    return { ok: false, reason: `distance ${km.toFixed(1)} km out of range` };
  }

  const structure = gasPumpPersonStructureScore(cleaned, meta.placement);
  const shapeMatch = routeShapeMatchPercent(axis, cleaned);
  const quality = routeQualityScore(cleaned);

  if (structure < 45) {
    return { ok: false, reason: `structure ${structure} too low` };
  }
  if (shapeMatch < 35) {
    return { ok: false, reason: `shape match ${shapeMatch}% too low` };
  }

  return {
    ok: true,
    source: meta.source,
    anchors: axis,
    coordinates: cleaned,
    km,
    maxHopMeters: hop,
    rejectedLegs: routed.rejectedLegs,
    structureScore: structure,
    shapeMatch,
    qualityScore: quality,
    placement: meta.placement,
  };
}

/** Build from verified / geocoded named intersections (pump → hose → person). */
export async function buildGasLogoFromNamedIntersections(
  anchors: LatLng[],
  options: GasLogoRouteBuildOptions = {},
): Promise<GasLogoRouteResult | GasLogoRouteFailure> {
  const axis = decomposeToAxisAnchors(anchors);
  return routeFromAxisAnchors(axis, options, {
    source: "named-intersections",
    placement: placementFromAnchors(axis),
  });
}

/** Build from catalog baked into gasLogoIntersections.ts */
export async function buildGasLogoFromCatalog(
  options: GasLogoRouteBuildOptions = {},
): Promise<GasLogoRouteResult | GasLogoRouteFailure> {
  return buildGasLogoFromNamedIntersections(gasLogoIntersectionAnchors(), options);
}

/** Grid template → turn corners → walk-network snap → leg-by-leg route. */
export async function buildGasLogoFromGridPlacement(
  placement: GasLogoPlacement,
  options: GasLogoRouteBuildOptions = {},
): Promise<GasLogoRouteResult | GasLogoRouteFailure> {
  const bearing = placement.streetBearingDeg ?? MANHATTAN_STREET_BEARING_DEG;
  const expanded = projectGridToLatLngDual({
    center: placement.center,
    streetMeters: placement.streetMeters,
    avenueMeters: placement.avenueMeters,
    streetBearingDeg: bearing,
    grid: gasLogoSparseGrid(),
    expand: true,
  });
  const turns = mergeCollinearOutline(expanded);
  if (turns.length < 8) {
    return { ok: false, reason: "too few turn corners" };
  }

  const snapped = await snapAnchorsToWalkNetwork(turns, options.snapDelayMs ?? 40);
  const axis = decomposeToAxisAnchors(snapped);
  const metaPlacement = placementFromAnchors(axis);

  return routeFromAxisAnchors(axis, options, {
    source: "grid-placement",
    placement: metaPlacement,
  });
}

export const GAS_LOGO_SEARCH_CENTERS: LatLng[] = [
  [40.728, -73.991],
  [40.730, -73.989],
  [40.726, -73.994],
  [40.732, -73.986],
  [40.725, -73.988],
];

export const GAS_LOGO_STREET_METERS = [78, 88, 98];
export const GAS_LOGO_AVENUE_METERS = [255, 275, 295];
