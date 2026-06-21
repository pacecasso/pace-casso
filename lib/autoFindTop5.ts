/**
 * Top-5 auto-placement: wide candidate generation → sanity cull → diverse
 * subsample → parallel snap → single composite vision call to Claude →
 * ranked top-5 picks.
 *
 * Runs client-side (Canvas + fetch). Falls back gracefully to diverse snapped
 * candidates if the image or the vision call is unavailable.
 */

import type { CityPreset } from "./cityPresets";
import {
  buildAnchorLatLngsFromContour,
  type ContourPoint,
  type PlacementTransform,
} from "./placementFromContour";
import type { RouteLineString } from "./routeTypes";
import { principalAxisAngleDeg } from "./autoFindPlacement";
import type { AnchorPathSource } from "./simplifyAnchorPathForSnap";
import { snapWalkingRoute } from "./snapWalkingRoute";
import { buildCompositeGridDataUrl } from "./compositeRouteGrid";
import { renderRouteToDataUrl } from "./renderRouteImage";
import {
  buildRouteStaticMapUrl,
  loadRouteStaticMapImage,
} from "./mapboxStaticMap";
import {
  loadFinalizedRoutes,
  type FinalizedRouteMemory,
} from "./finalizedRouteMemory";
import { routeQualityScore } from "./routeQuality";
import { interpretationMatchPercent } from "./shapeMatchScore";
import { haversineMeters } from "./haversine";
import { isValidLatLng } from "./mapboxCoordsValidate";
import { heartConfidence } from "./artPathInterpretation";
import { reviewStreetDesignSketch } from "./streetDesignSketch";
import { cleanupRouteSpurs } from "./routeSpurCleanup";

const MARGIN = 0.012;
const MIN_PERIMETER_KM = 3;
/**
 * Accommodates hero-scale placements (e.g. an island-sized heart on Manhattan,
 * perimeter ≈ 28–32 km). The snap-ratio filter + vision rank still weed out
 * candidates that don't read at that size, so widening here only expands the
 * candidate *pool*, not the output quality bar.
 */
const MAX_PERIMETER_KM = 35;
const CANDIDATES_TO_SNAP = 36;
const SNAP_BATCH_SIZE = 4;
const SNAP_BATCH_GAP_MS = 100;

/**
 * Snap-quality filter: reject candidates whose snapped route length deviates
 * wildly from the anchor perimeter. A ratio far from 1.0 means Mapbox had to
 * detour massively (e.g., routing across a bridge because the shape straddled
 * water) and the resulting geometry no longer resembles the intended shape.
 *
 * Loose by design — Mapbox commonly shortcuts jagged outlines through straight
 * streets (ratio < 1.0) for legit letter/shape traces, so we only drop the
 * extremes. The in-bounds check on snapped coords is the stricter gate that
 * catches actual shape-destroying detours (river crossings etc.).
 */
const SNAP_RATIO_MIN = 0.55;
const SNAP_RATIO_MAX = 1.7;

export type ShapeHint = {
  shapeClass: "letter" | "creature" | "geometric" | "abstract";
  rotationStrategy: "upright" | "grid-aligned" | "flexible";
  scaleHint: "compact" | "medium" | "sprawling";
  reason: string;
};

export type Top5Pick = {
  placement: PlacementTransform;
  /** Anchor geometry used for this option. Usually derived from placement; city-first options may override it. */
  anchorLatLngs?: [number, number][];
  /** Short description of the route sketch used to generate this candidate. */
  designIntent?: string;
  /** Snapped walking-route geometry (`[lat, lng]` pairs). */
  routeCoords: [number, number][];
  /** Full snapped route from Mapbox, including editor block waypoints. */
  snappedRoute: RouteLineString;
  /** Image URL for the preview tile. Usually a Mapbox Static Images URL showing
   *  the route on a real map backdrop; falls back to a pure-outline data-URL
   *  if the static map can't be built (missing token, etc.). */
  previewDataUrl: string;
  distanceKm: number;
  /** 0-100, where higher means cleaner route geometry with less retracing or jitter. */
  qualityScore: number;
  /** 0-100, where higher means the snapped route still reads like the artwork. */
  shapeMatchScore: number;
  /** One-line rationale from Claude. Absent on fallback. */
  reason?: string;
};

export type AutoFindTop5Result = {
  picks: Top5Pick[];
  /** True if Claude ranked these; false if we fell back to snap-order. */
  visionUsed: boolean;
  /** Shape classification from the pre-pass, if it ran. Absent when the hint
   *  call failed or was skipped (no image provided). */
  hint?: ShapeHint;
};

export type AutoFindTop5Options = {
  anchorSource?: AnchorPathSource;
  /** Reference image as a data-URL or raw base64. When absent, vision is skipped. */
  imageBase64?: string;
  topK?: number;
  candidatesToSnap?: number;
  /**
   * When present, enter "refine" mode: explore tightly around this placement
   * (~2 km radius, ±30% scale, ±20° rotation) instead of sweeping the full
   * city. Use this when the user has manually positioned the shape and wants
   * to polish their placement rather than start fresh.
   */
  anchorAround?: {
    center: [number, number];
    rotationDeg: number;
    scale: number;
  };
  /**
   * When present (and not in refine mode), override the hint-derived scale
   * array with scales computed to yield a route close to this distance. The
   * snap stage can shift the final distance ±30% due to street shortcuts, so
   * this is a target, not a hard cap.
   */
  targetDistanceKm?: number;
};

// --- helpers -----------------------------------------------------------------

/**
 * Pick a scale array based on the hint — but with heavy overlap between
 * categories so a misclassification (e.g., Claude says "compact" when the
 * shape wanted "medium") can't lock us out of the right scale. The common
 * middle values 1.0 / 1.4 / 1.8 appear in every category.
 *
 * "sprawling" + the default (no-hint) sweep now reach hero scales up to ~5×.
 * That's what unlocks island-sized placements (HEART.webp-style hearts that
 * fill Manhattan from midtown to Battery) alongside neighborhood variants.
 * Compact / medium stay bounded — a 9 km letter is just unreadable spaghetti,
 * the vision ranker shouldn't even have to consider it.
 *
 * Letters / fine shapes need tight scales; big silhouettes want to roam.
 */
function scalesFromHint(hint: ShapeHint | null): number[] {
  switch (hint?.scaleHint) {
    case "compact":
      return [0.7, 0.9, 1.1, 1.4, 1.7, 2.0];
    case "medium":
      return [0.9, 1.2, 1.6, 2.0, 2.6, 3.2];
    case "sprawling":
      return [1.4, 2.0, 2.8, 3.6, 4.5, 5.5];
    default:
      // No hint (vision-hint unavailable) — sweep tiny → hero so the AI sees
      // the full range and picks whatever actually reads best.
      return [0.6, 1.0, 1.6, 2.4, 3.4, 4.5, 5.5];
  }
}

/**
 * When the user asks for a route close to a specific distance, compute the
 * scale that produces that anchor perimeter, then sample tight variants
 * around it. Mapbox snap can still shift the final route distance ±30% via
 * street shortcuts — this is a target, not a hard cap.
 */
function scalesFromTargetDistance(
  contour: ContourPoint[],
  preset: CityPreset,
  targetDistanceKm: number,
): number[] | null {
  if (!Number.isFinite(targetDistanceKm) || targetDistanceKm <= 0) return null;
  const ref = buildAnchorLatLngsFromContour(contour, {
    center: preset.defaultCenter,
    rotationDeg: 0,
    scale: 1.0,
  });
  if (!ref.approxDistanceKm || ref.approxDistanceKm <= 0) return null;
  const targetScale = targetDistanceKm / ref.approxDistanceKm;
  return [0.85, 0.93, 1.0, 1.08, 1.15]
    .map((m) => targetScale * m)
    .map((s) => Math.max(0.3, Math.min(6.0, s)));
}

/**
 * Pick a rotation array based on the hint — but always include BOTH
 * true-upright (0°) AND the city's grid bearings, because on a rotated grid
 * like Manhattan the cleanest street-snap for a letter happens at ~29°, not
 * at 0°. R2.png (the user's best manual placement) was true-upright, but
 * several of Claude's best picks in PIC1 were grid-aligned. Letters can
 * legitimately want either, so we include both.
 */
function rotationsFromHint(
  contour: ContourPoint[],
  preset: CityPreset,
  hint: ShapeHint | null,
): number[] {
  const bearings = preset.dominantGridBearingsDeg ?? [];
  const normalize = (deg: number) => Math.round(((deg + 540) % 360) - 180);

  if (hint?.rotationStrategy === "upright") {
    // Two "islands" of rotation: true-upright (±15° of 0°) AND the city grid
    // bearing closest to 0° (±10°). On Manhattan's ~29° grid, these end up
    // being {-15…+15} ∪ {19…39}. We skip the perpendicular bearing (~119°)
    // because rotating a letter by 90° makes it unreadable, no matter how
    // clean the street-snap ends up.
    const set = new Set<number>([-15, -10, -5, 0, 5, 10, 15]);
    for (const g of bearings) {
      const gn = normalize(g);
      if (Math.abs(gn) > 45) continue; // skip perpendicular-to-upright
      set.add(normalize(gn - 10));
      set.add(normalize(gn - 5));
      set.add(gn);
      set.add(normalize(gn + 5));
      set.add(normalize(gn + 10));
    }
    return [...set].sort((a, b) => a - b);
  }

  if (hint?.rotationStrategy === "grid-aligned") {
    // Each grid bearing + its perpendicular + small jitter, plus a pair of
    // upright fallback angles so misclassification can't lock out true-north.
    const set = new Set<number>([-5, 0, 5]);
    for (const g of bearings) {
      const gn = normalize(g);
      const perp = normalize(g + 90);
      for (const r of [gn, perp]) {
        set.add(normalize(r - 10));
        set.add(normalize(r - 5));
        set.add(r);
        set.add(normalize(r + 5));
        set.add(normalize(r + 10));
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  // flexible (or no hint): existing wide sweep + PCA-aligned seeds.
  const pca = principalAxisAngleDeg(contour);
  const pcaAligned =
    pca != null ? bearings.flatMap((g) => [g - pca, g - pca + 90]) : [];
  const base = [-90, -60, -30, -15, 0, 15, 30, 60, 90];
  return [...new Set([...base, ...pcaAligned.map(normalize)])];
}

function enumerateCandidates(
  contour: ContourPoint[],
  preset: CityPreset,
  hint: ShapeHint | null,
  anchorAround?: AutoFindTop5Options["anchorAround"],
  targetDistanceKm?: number,
): PlacementTransform[] {
  if (anchorAround) {
    return enumerateAroundAnchor(preset, anchorAround);
  }

  const b = preset.searchBounds;
  const latSpan = b.north - b.south - 2 * MARGIN;
  const lngSpan = b.east - b.west - 2 * MARGIN;
  const GRID = 5;
  // Target-distance scales take priority over hint-derived scales when both
  // are available — the user asked for a specific distance; respect it.
  const scales =
    (targetDistanceKm != null
      ? scalesFromTargetDistance(contour, preset, targetDistanceKm)
      : null) ?? scalesFromHint(hint);
  const rotations = rotationsFromHint(contour, preset, hint);

  const out: PlacementTransform[] = [];
  for (let li = 0; li < GRID; li++) {
    for (let gi = 0; gi < GRID; gi++) {
      const lat = b.south + MARGIN + (latSpan * (li + 0.5)) / GRID;
      const lng = b.west + MARGIN + (lngSpan * (gi + 0.5)) / GRID;
      for (const scale of scales) {
        for (const rotationDeg of rotations) {
          out.push({ center: [lat, lng], rotationDeg, scale });
        }
      }
    }
  }
  return out;
}

function isHeartLikeContour(contour: ContourPoint[]): boolean {
  return heartConfidence(contour) >= 0.6;
}

export function enumerateCityFirstHeartPlacements(
  contour: ContourPoint[],
  preset: CityPreset,
  targetDistanceKm?: number,
): PlacementTransform[] {
  if (preset.id !== "manhattan" || !isHeartLikeContour(contour)) return [];

  const gridRotations = [-29, 29, 0];
  const scales =
    targetDistanceKm != null && Number.isFinite(targetDistanceKm)
      ? scalesFromTargetDistance(contour, preset, targetDistanceKm) ?? [1.2, 1.6, 2.1]
      : [0.85, 1.15, 1.55, 2.05, 2.65, 3.35];

  const centers: [number, number][] = [
    // West Village / SoHo: tight grid, good for smaller iconic hearts.
    [40.727, -74.000],
    // Greenwich / East Village: diagonals and grid breaks can help the lobes.
    [40.733, -73.988],
    // Midtown: long avenues for confident sides, dense cross streets for lobes.
    [40.754, -73.985],
    // Central Park south / Upper West-East: strong long corridors and park edge.
    [40.775, -73.971],
    // Lower Manhattan: irregular streets can make a less literal but readable heart.
    [40.711, -74.006],
  ];

  const out: PlacementTransform[] = [];
  for (const center of centers) {
    for (const scale of scales) {
      for (const rotationDeg of gridRotations) {
        out.push({ center, scale, rotationDeg });
      }
    }
  }
  return out;
}

function cityFocusCenters(preset: CityPreset): [number, number][] {
  if (preset.id === "manhattan") {
    return [
      [40.711, -74.006],
      [40.720, -73.999],
      [40.728, -73.991],
      [40.735, -73.992],
      [40.742, -73.993],
      [40.748, -73.986],
      [40.754, -73.985],
      [40.760, -73.980],
      [40.768, -73.977],
      [40.776, -73.972],
      [40.792, -73.965],
      [40.807, -73.958],
    ];
  }

  const b = preset.searchBounds;
  const latMid = (b.south + b.north) / 2;
  const lngMid = (b.west + b.east) / 2;
  const latQ = (b.north - b.south) * 0.24;
  const lngQ = (b.east - b.west) * 0.24;
  return [
    preset.defaultCenter,
    [latMid, lngMid],
    [latMid - latQ, lngMid - lngQ],
    [latMid - latQ, lngMid + lngQ],
    [latMid + latQ, lngMid - lngQ],
    [latMid + latQ, lngMid + lngQ],
    [latMid, lngMid - lngQ],
    [latMid, lngMid + lngQ],
    [latMid - latQ, lngMid],
    [latMid + latQ, lngMid],
  ];
}

export function enumerateCityFocusPlacements(
  contour: ContourPoint[],
  preset: CityPreset,
  hint: ShapeHint | null = null,
  targetDistanceKm?: number,
): PlacementTransform[] {
  const scales =
    (targetDistanceKm != null
      ? scalesFromTargetDistance(contour, preset, targetDistanceKm)
      : null) ?? scalesFromHint(hint);
  const rotations = rotationsFromHint(contour, preset, hint);
  const centers = cityFocusCenters(preset);
  const b = preset.searchBounds;
  const innerS = b.south + MARGIN;
  const innerN = b.north - MARGIN;
  const innerW = b.west + MARGIN;
  const innerE = b.east - MARGIN;

  const out: PlacementTransform[] = [];
  for (const center of centers) {
    if (
      center[0] < innerS ||
      center[0] > innerN ||
      center[1] < innerW ||
      center[1] > innerE
    ) {
      continue;
    }
    for (const scale of scales) {
      for (const rotationDeg of rotations) {
        out.push({ center, scale, rotationDeg });
      }
    }
  }
  return out;
}

function routeLengthKm(coords: [number, number][]): number {
  let meters = 0;
  for (let i = 1; i < coords.length; i++) {
    meters += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return meters / 1000;
}

function placementFromAnchors(
  anchors: [number, number][],
  rotationDeg: number,
  scale: number,
): PlacementTransform {
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
    rotationDeg,
    scale,
  };
}

function heartAnchorsFromMeters({
  center,
  widthMeters,
  heightMeters,
  rotationDeg,
}: {
  center: [number, number];
  widthMeters: number;
  heightMeters: number;
  rotationDeg: number;
}): [number, number][] {
  const shape: [number, number][] = [
    [0, -0.52],
    [-0.46, -0.16],
    [-0.5, 0.1],
    [-0.36, 0.36],
    [-0.15, 0.42],
    [0, 0.2],
    [0.15, 0.42],
    [0.36, 0.36],
    [0.5, 0.1],
    [0.46, -0.16],
    [0, -0.52],
  ];
  const lat0 = center[0];
  const metersPerLat = 111_320;
  const metersPerLng = metersPerLat * Math.cos((lat0 * Math.PI) / 180);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  return shape.map(([nx, ny]) => {
    const x = nx * widthMeters;
    const y = ny * heightMeters;
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    return [center[0] + ry / metersPerLat, center[1] + rx / metersPerLng];
  });
}

function manhattanDesignedHeartCandidates(
  contour: ContourPoint[],
  preset: CityPreset,
  targetDistanceKm?: number,
): ValidCandidate[] {
  if (preset.id !== "manhattan" || !isHeartLikeContour(contour)) return [];

  const recipes: {
    anchors: [number, number][];
    rotationDeg: number;
    scale: number;
    kind?: "reference-heart" | "designed-heart";
  }[] = [
    {
      anchors: heartAnchorsFromMeters({
        center: [40.762, -73.976],
        widthMeters: 2300,
        heightMeters: 3300,
        rotationDeg: 0,
      }),
      rotationDeg: 0,
      scale: 1.65,
    },
    {
      anchors: heartAnchorsFromMeters({
        center: [40.741, -73.986],
        widthMeters: 2900,
        heightMeters: 4300,
        rotationDeg: 10,
      }),
      rotationDeg: 29,
      scale: 2.2,
    },
    {
      anchors: heartAnchorsFromMeters({
        center: [40.724, -73.994],
        widthMeters: 2100,
        heightMeters: 3100,
        rotationDeg: 16,
      }),
      rotationDeg: 29,
      scale: 1.55,
    },
  ];

  return recipes
    .map((recipe) => {
      const km = routeLengthKm(recipe.anchors);
      return {
        placement: placementFromAnchors(
          recipe.anchors,
          recipe.rotationDeg,
          recipe.scale,
        ),
        anchors: recipe.anchors,
        km,
        kind: recipe.kind ?? ("designed-heart" as const),
      };
    })
    .filter((candidate) => {
      if (targetDistanceKm == null || !Number.isFinite(targetDistanceKm)) return true;
      return (
        candidate.km >= targetDistanceKm * 0.55 &&
        candidate.km <= targetDistanceKm * 1.7
      );
    });
}

/**
 * Refine mode: dense local sweep around a user-placed anchor. 5×5 center grid
 * spanning ~±2 km, scales ±30% of the user's scale, rotations ±20° of the
 * user's rotation. Claude still re-ranks so they can pick the best of these
 * nearby variants.
 */
function enumerateAroundAnchor(
  preset: CityPreset,
  anchor: NonNullable<AutoFindTop5Options["anchorAround"]>,
): PlacementTransform[] {
  const b = preset.searchBounds;
  const [anchorLat, anchorLng] = anchor.center;

  // ~2 km on each side of the anchor. 0.018° latitude ≈ 2 km at Manhattan's
  // latitude; longitude span scales by cos(lat).
  const latStep = 0.009;
  const lngStep = 0.011;
  const offsets = [-2, -1, 0, 1, 2];

  const scales = [0.7, 0.85, 1.0, 1.15, 1.3]
    .map((m) => anchor.scale * m)
    .map((s) => Math.max(0.3, Math.min(3.5, s)));

  const rotations = [-20, -10, -5, 0, 5, 10, 20].map(
    (d) => anchor.rotationDeg + d,
  );

  const innerS = b.south + MARGIN;
  const innerN = b.north - MARGIN;
  const innerW = b.west + MARGIN;
  const innerE = b.east - MARGIN;

  const out: PlacementTransform[] = [];
  for (const oy of offsets) {
    for (const ox of offsets) {
      const lat = anchorLat + oy * latStep;
      const lng = anchorLng + ox * lngStep;
      if (lat < innerS || lat > innerN) continue;
      if (lng < innerW || lng > innerE) continue;
      for (const scale of scales) {
        for (const rotationDeg of rotations) {
          out.push({ center: [lat, lng], rotationDeg, scale });
        }
      }
    }
  }
  return out;
}

type ValidCandidate = {
  placement: PlacementTransform;
  anchors: [number, number][];
  km: number;
  designIntent?: string;
  kind?:
    | "generic"
    | "city-focus"
    | "city-heart"
    | "designed-heart"
    | "reference-heart"
    | "vision-design";
};

function sanityFilter(
  contour: ContourPoint[],
  preset: CityPreset,
  placement: PlacementTransform,
): ValidCandidate | null {
  const { anchorLatLngs, approxDistanceKm } = buildAnchorLatLngsFromContour(
    contour,
    placement,
  );
  if (anchorLatLngs.length < 2) return null;
  if (
    approxDistanceKm < MIN_PERIMETER_KM ||
    approxDistanceKm > MAX_PERIMETER_KM
  ) {
    return null;
  }
  const b = preset.searchBounds;
  const innerS = b.south + MARGIN;
  const innerN = b.north - MARGIN;
  const innerW = b.west + MARGIN;
  const innerE = b.east - MARGIN;
  for (const [lat, lng] of anchorLatLngs) {
    if (lat < innerS || lat > innerN || lng < innerW || lng > innerE) {
      return null;
    }
  }
  return { placement, anchors: anchorLatLngs, km: approxDistanceKm };
}

function designDraftCandidates(
  drafts: VisionDesignDraft[],
  preset: CityPreset,
  hint: ShapeHint | null,
  targetDistanceKm?: number,
): ValidCandidate[] {
  const out: ValidCandidate[] = [];
  for (const draft of drafts) {
    const placements = [
      ...enumerateCityFocusPlacements(
        draft.points,
        preset,
        hint,
        targetDistanceKm,
      ),
      ...enumerateCandidates(
        draft.points,
        preset,
        hint,
        undefined,
        targetDistanceKm,
      ),
    ];
    const validForDraft: ValidCandidate[] = [];
    for (const p of placements) {
      const v = sanityFilter(draft.points, preset, p);
      if (v) {
        validForDraft.push({
          ...v,
          designIntent: `${draft.label}: ${draft.description}`,
          kind: "vision-design",
        });
      }
    }
    out.push(
      ...diverseSubsample(
        validForDraft,
        Math.min(8, validForDraft.length),
        preset,
      ),
    );
  }
  return out;
}

/**
 * Greedy farthest-point sampling across (lat, lng, scale, rotation) so the
 * candidates we spend Mapbox calls on are spatially and parametrically diverse.
 * Lat/lng diversity is weighted higher than scale/rotation — what matters most
 * is covering the city, then varying size/orientation.
 */
function diverseSubsample(
  valid: ValidCandidate[],
  count: number,
  preset: CityPreset,
): ValidCandidate[] {
  if (count <= 0) return [];
  if (valid.length <= count) return valid;
  const b = preset.searchBounds;
  const latRange = b.north - b.south || 1;
  const lngRange = b.east - b.west || 1;

  const keys = valid.map((v) => {
    const p = v.placement;
    return [
      ((p.center[0] - b.south) / latRange) * 2, // spatial weight
      ((p.center[1] - b.west) / lngRange) * 2,
      ((p.scale - 0.5) / 3) * 0.7,
      (((p.rotationDeg + 180) % 360) / 360) * 0.7,
    ];
  });

  const pickedIdx = new Set<number>();
  pickedIdx.add(0);
  const minDistToPicked = new Float64Array(valid.length);
  for (let i = 0; i < valid.length; i++) {
    minDistToPicked[i] = distanceBetween(keys[i]!, keys[0]!);
  }

  while (pickedIdx.size < count) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < valid.length; i++) {
      if (pickedIdx.has(i)) continue;
      if (minDistToPicked[i]! > bestDist) {
        bestDist = minDistToPicked[i]!;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    pickedIdx.add(bestIdx);
    for (let i = 0; i < valid.length; i++) {
      if (pickedIdx.has(i)) continue;
      const d = distanceBetween(keys[i]!, keys[bestIdx]!);
      if (d < minDistToPicked[i]!) minDistToPicked[i] = d;
    }
  }
  return [...pickedIdx].map((i) => valid[i]!);
}

function distanceBetween(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s);
}

function polylineLengthKm(coords: [number, number][]): number {
  let meters = 0;
  for (let i = 1; i < coords.length; i++) {
    meters += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return meters / 1000;
}

export function snappedRouteDistanceKm(route: RouteLineString): number | null {
  const coords = (route.coordinates ?? []).filter(
    (p): p is [number, number] =>
      Array.isArray(p) &&
      typeof p[0] === "number" &&
      typeof p[1] === "number" &&
      isValidLatLng([p[0], p[1]]),
  );
  if (coords.length < 2) return null;
  if (
    typeof route.distanceMeters === "number" &&
    Number.isFinite(route.distanceMeters) &&
    route.distanceMeters > 0
  ) {
    return route.distanceMeters / 1000;
  }
  const measured = polylineLengthKm(coords);
  return measured > 0 ? measured : null;
}

async function snapOne(
  anchors: [number, number][],
  anchorSource: AnchorPathSource | undefined,
): Promise<{
  coords: [number, number][];
  snappedKm: number;
  route: RouteLineString;
} | null> {
  try {
    if (anchors.length < 2) return null;
    const route = await snapWalkingRoute(anchors, {
      anchorSource,
      startVariantCount: 4,
    });
    const coords = route.coordinates as [number, number][];
    if (coords.length < 2) return null;
    const snappedKm = snappedRouteDistanceKm(route);
    if (snappedKm == null) return null;
    return { coords, snappedKm, route };
  } catch {
    return null;
  }
}

type SnappedCandidate = {
  placement: PlacementTransform;
  anchors: [number, number][];
  designIntent?: string;
  coords: [number, number][];
  route: RouteLineString;
  /** Snapped walking distance in km (what Mapbox returned). */
  km: number;
  /** 0-100, penalizes unnecessary reverse retracing and fussy short jogs. */
  qualityScore: number;
  /** 0-100, rewards snapped geometry that still follows the intended artwork. */
  shapeMatchScore: number;
};

export type AutoFindPickSelectionCandidate = {
  placement: PlacementTransform;
  qualityScore: number;
  shapeMatchScore: number;
};

export function scoreAutoPlacementCandidate(
  qualityScore: number,
  shapeMatchScore: number,
): number {
  const clean = Math.max(0, Math.min(100, qualityScore));
  const shape = Math.max(0, Math.min(100, shapeMatchScore));
  return shape * 0.58 + clean * 0.42;
}

function centerDistanceMeters(
  a: PlacementTransform["center"],
  b: PlacementTransform["center"],
): number {
  const latMid = ((a[0] + b[0]) / 2) * (Math.PI / 180);
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos(latMid);
  return Math.hypot((a[0] - b[0]) * metersPerLat, (a[1] - b[1]) * metersPerLng);
}

function rotationDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

function placementDiversityScore(
  a: PlacementTransform,
  b: PlacementTransform,
): number {
  const center = Math.min(1, centerDistanceMeters(a.center, b.center) / 1200);
  const scale = Math.min(
    1,
    Math.abs(Math.log(Math.max(0.01, a.scale) / Math.max(0.01, b.scale))) /
      0.35,
  );
  const rotation = Math.min(1, rotationDiffDeg(a.rotationDeg, b.rotationDeg) / 35);
  return center * 0.62 + scale * 0.23 + rotation * 0.15;
}

export function selectDiverseAutoFindPickIndices(
  candidates: AutoFindPickSelectionCandidate[],
  topK: number,
  preferredOrder?: number[],
): number[] {
  const limit = Math.max(0, Math.floor(topK));
  if (limit === 0 || candidates.length === 0) return [];

  const preferredRank = new Map<number, number>();
  for (const i of preferredOrder ?? []) {
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) continue;
    if (!preferredRank.has(i)) preferredRank.set(i, preferredRank.size);
  }
  const visionBonusMax = preferredRank.size > 0 ? 8 : 0;
  const ordered = candidates
    .map((c, i) => {
      const score = scoreAutoPlacementCandidate(c.qualityScore, c.shapeMatchScore);
      const rank = preferredRank.get(i);
      const visionBonus =
        rank == null
          ? 0
          : visionBonusMax *
            (1 - rank / Math.max(1, preferredRank.size));
      return { i, score: score + visionBonus };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i);

  const picked: number[] = [];
  const tooSimilar = (idx: number) =>
    picked.some(
      (p) =>
        placementDiversityScore(
          candidates[idx]!.placement,
          candidates[p]!.placement,
        ) < 0.35,
    );

  for (const i of ordered) {
    if (picked.length >= limit) break;
    if (picked.length === 0 || !tooSimilar(i)) picked.push(i);
  }
  for (const i of ordered) {
    if (picked.length >= limit) break;
    if (!picked.includes(i)) picked.push(i);
  }

  return picked;
}

/** Does the snapped route stray outside the city preset's search bounds?
 *  Anchors are pre-checked to be in-bounds, but Mapbox can detour far outside
 *  (e.g., across the East River into Queens) when the shape straddles water. */
function snapEscapesBounds(
  coords: [number, number][],
  preset: CityPreset,
): boolean {
  const b = preset.searchBounds;
  for (const [lat, lng] of coords) {
    if (lat < b.south || lat > b.north || lng < b.west || lng > b.east) {
      return true;
    }
  }
  return false;
}

async function parallelSnap(
  candidates: ValidCandidate[],
  anchorSource: AnchorPathSource | undefined,
  preset: CityPreset,
): Promise<SnappedCandidate[]> {
  const out: SnappedCandidate[] = [];
  let rejectedByRatio = 0;
  let rejectedByBounds = 0;
  for (let i = 0; i < candidates.length; i += SNAP_BATCH_SIZE) {
    const batch = candidates.slice(i, i + SNAP_BATCH_SIZE);
    const snapped = await Promise.all(
      batch.map(async (c) => {
        const r = await snapOne(c.anchors, anchorSource);
        if (!r) return null;

        // Filter 1: snap-destroyed shapes (massive perimeter change)
        const ratio = r.snappedKm / Math.max(c.km, 0.1);
        if (ratio < SNAP_RATIO_MIN || ratio > SNAP_RATIO_MAX) {
          rejectedByRatio++;
          return null;
        }

        // Filter 2: snap that escaped the city preset (the East-River case)
        if (snapEscapesBounds(r.coords, preset)) {
          rejectedByBounds++;
          return null;
        }

        const cleaned = cleanupRouteSpurs(r.route).route;
        const cleanedCoords = cleaned.coordinates;
        const cleanedKm = (cleaned.distanceMeters ?? r.snappedKm * 1000) / 1000;
        return {
          placement: c.placement,
          anchors: c.anchors,
          designIntent: c.designIntent,
          coords: cleanedCoords,
          route: cleaned,
          km: cleanedKm,
          qualityScore: routeQualityScore(cleanedCoords),
          shapeMatchScore: interpretationMatchPercent(
            c.anchors,
            cleanedCoords,
          ),
        } as SnappedCandidate;
      }),
    );
    for (const s of snapped) if (s) out.push(s);
    if (i + SNAP_BATCH_SIZE < candidates.length) {
      await new Promise((r) => setTimeout(r, SNAP_BATCH_GAP_MS));
    }
  }
  if (rejectedByRatio > 0 || rejectedByBounds > 0) {
    console.log(
      `[autoFindTop5] dropped ${rejectedByRatio} snap-destroyed + ${rejectedByBounds} bounds-escaping candidates`,
    );
  }
  out.sort(
    (a, b) =>
      scoreAutoPlacementCandidate(b.qualityScore, b.shapeMatchScore) -
      scoreAutoPlacementCandidate(a.qualityScore, a.shapeMatchScore),
  );
  return out;
}

type ParsedImage = { data: string; mediaType: string };
function parseImageBase64(imageBase64: string): ParsedImage {
  if (imageBase64.startsWith("data:")) {
    const comma = imageBase64.indexOf(",");
    if (comma !== -1) {
      const mediaType =
        imageBase64.slice(0, comma).split(":")[1]?.split(";")[0] ??
        "image/png";
      return { data: imageBase64.slice(comma + 1), mediaType };
    }
  }
  return { data: imageBase64, mediaType: "image/png" };
}

export type VisionDesignDraft = {
  label: string;
  description: string;
  points: ContourPoint[];
  designScore: number;
};

function validDesignPoint(v: unknown): ContourPoint | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r.x !== "number" ||
    typeof r.y !== "number" ||
    !Number.isFinite(r.x) ||
    !Number.isFinite(r.y)
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(1, r.x)),
    y: Math.max(0, Math.min(1, r.y)),
  };
}

export function cleanVisionDesignDrafts(raw: unknown): VisionDesignDraft[] {
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  const rawDrafts = Array.isArray(rec.drafts) ? rec.drafts : [rec];
  const out: VisionDesignDraft[] = [];
  for (const item of rawDrafts) {
    if (!item || typeof item !== "object") continue;
    const draft = item as Record<string, unknown>;
    const points = Array.isArray(draft.points)
      ? draft.points
          .map(validDesignPoint)
          .filter((p): p is ContourPoint => p != null)
      : [];
    if (points.length < 2) continue;
    const review = reviewStreetDesignSketch(points);
    if (!review.pass) {
      console.log(
        "[autoFindTop5] dropped weak design draft",
        typeof draft.label === "string" ? draft.label : `AI draft ${out.length + 1}`,
        review,
      );
      continue;
    }
    out.push({
      label:
        typeof draft.label === "string" && draft.label.trim()
          ? draft.label.trim().slice(0, 40)
          : `AI draft ${out.length + 1}`,
      description:
        typeof draft.description === "string" && draft.description.trim()
          ? draft.description.trim().slice(0, 180)
          : "Street-native GPS-art sketch.",
      points,
      designScore: review.score,
    });
    if (out.length >= 8) break;
  }
  return out.sort((a, b) => b.designScore - a.designScore);
}

async function getVisionDesignDrafts(
  originalData: string,
  originalMediaType: string,
  cityLabel: string,
): Promise<VisionDesignDraft[]> {
  console.log("[autoFindTop5] requesting map-first design drafts...");
  try {
    const res = await fetch("/api/vision-design", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: originalData,
        mediaType: originalMediaType,
        cityLabel,
        draftCount: 8,
      }),
    });
    if (!res.ok) {
      console.warn(
        "[autoFindTop5] vision-design http",
        res.status,
        await res.text().catch(() => ""),
      );
      return [];
    }
    const drafts = cleanVisionDesignDrafts(await res.json());
    console.log(
      `[autoFindTop5] vision-design returned ${drafts.length} draft(s):`,
      drafts.map((d) => `${d.label} (${d.designScore})`),
    );
    return drafts;
  } catch (err) {
    console.warn("[autoFindTop5] vision-design fetch failed:", err);
    return [];
  }
}

async function getVisionHint(
  originalData: string,
  originalMediaType: string,
  cityLabel: string,
): Promise<ShapeHint | null> {
  console.log("[autoFindTop5] requesting vision hint…");
  try {
    const res = await fetch("/api/vision-hint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: originalData,
        mediaType: originalMediaType,
        cityLabel,
      }),
    });
    if (!res.ok) {
      console.warn(
        "[autoFindTop5] vision-hint http",
        res.status,
        await res.text().catch(() => ""),
      );
      return null;
    }
    const json = (await res.json()) as Partial<ShapeHint>;
    if (
      !json.shapeClass ||
      !json.rotationStrategy ||
      !json.scaleHint
    ) {
      console.warn("[autoFindTop5] vision-hint response missing fields:", json);
      return null;
    }
    const hint: ShapeHint = {
      shapeClass: json.shapeClass,
      rotationStrategy: json.rotationStrategy,
      scaleHint: json.scaleHint,
      reason: json.reason ?? "",
    };
    console.log("[autoFindTop5] shape hint:", hint);
    return hint;
  } catch (err) {
    console.warn("[autoFindTop5] vision-hint fetch failed:", err);
    return null;
  }
}

async function visionRank(
  gridRawBase64: string,
  originalData: string,
  originalMediaType: string,
  count: number,
  topK: number,
  userHistory: FinalizedRouteMemory[],
  cityLabel: string,
  candidateNotes: string[],
): Promise<{ id: number; reason: string }[] | null> {
  console.log(
    `[autoFindTop5] calling vision-rank with count=${count}, topK=${topK}, gridB64=${gridRawBase64.length}ch, origB64=${originalData.length}ch, historyEntries=${userHistory.length}, city=${cityLabel}`,
  );
  try {
    const res = await fetch("/api/vision-rank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gridImageBase64: gridRawBase64,
        originalImageBase64: originalData,
        originalMediaType,
        count,
        topK,
        cityLabel,
        candidateNotes,
        userHistory: userHistory.map((h) => ({
          center: h.center,
          rotationDeg: h.rotationDeg,
          scale: h.scale,
          distanceKm: h.distanceKm,
        })),
      }),
    });
    if (!res.ok) {
      console.warn(
        "[autoFindTop5] vision-rank http",
        res.status,
        await res.text().catch(() => ""),
      );
      return null;
    }
    const json = (await res.json()) as {
      ranked?: { id: number; reason: string }[];
    };
    console.log(
      `[autoFindTop5] vision-rank returned ${json.ranked?.length ?? 0} items:`,
      json.ranked,
    );
    return json.ranked ?? null;
  } catch (err) {
    console.warn("[autoFindTop5] vision-rank fetch failed:", err);
    return null;
  }
}

function pickPreviewUrl(coords: [number, number][]): string {
  // Prefer the Mapbox Static Images URL so the preview shows the route on a
  // real map backdrop (same image Claude saw). If that's unavailable — no
  // token, non-browser context — fall back to an outline-only data URL.
  const mapUrl = buildRouteStaticMapUrl(coords, { size: 256 });
  if (mapUrl) return mapUrl;
  return renderRouteToDataUrl(coords) ?? "";
}

function makePicks(
  snapped: SnappedCandidate[],
  order: number[] | null,
  reasons: Map<number, string> | null,
  topK: number,
): Top5Pick[] {
  const indices =
    order != null
      ? selectDiverseAutoFindPickIndices(snapped, topK, order)
      : selectDiverseAutoFindPickIndices(snapped, topK);
  const out: Top5Pick[] = [];
  for (const i of indices) {
    const s = snapped[i]!;
    out.push({
      placement: s.placement,
      anchorLatLngs: s.anchors,
      designIntent: s.designIntent,
      routeCoords: s.coords,
      snappedRoute: s.route,
      previewDataUrl: pickPreviewUrl(s.coords),
      distanceKm: s.km,
      qualityScore: s.qualityScore,
      shapeMatchScore: s.shapeMatchScore,
      reason: reasons?.get(i),
    });
  }
  return out;
}

// --- main orchestrator -------------------------------------------------------

export async function autoFindTop5(
  contour: ContourPoint[],
  preset: CityPreset,
  options: AutoFindTop5Options = {},
): Promise<AutoFindTop5Result> {
  const topK = options.topK ?? 5;
  const snapCount = options.candidatesToSnap ?? CANDIDATES_TO_SNAP;

  // Phase 0: quick shape classification so candidate gen knows whether to
  // keep letters upright, align to the city grid, or explore widely.
  let hint: ShapeHint | null = null;
  let parsedOrig: ParsedImage | null = null;
  if (options.imageBase64) {
    parsedOrig = parseImageBase64(options.imageBase64);
    hint = await getVisionHint(
      parsedOrig.data,
      parsedOrig.mediaType,
      preset.label,
    );
  }
  const visionDesignDrafts =
    parsedOrig && !options.anchorAround
      ? await getVisionDesignDrafts(
          parsedOrig.data,
          parsedOrig.mediaType,
          preset.label,
        )
      : [];

  const designedCityRoutes = !options.anchorAround
    ? manhattanDesignedHeartCandidates(
        contour,
        preset,
        options.targetDistanceKm,
      )
    : [];
  const cityFirstRaw = !options.anchorAround
    ? enumerateCityFirstHeartPlacements(
        contour,
        preset,
        options.targetDistanceKm,
      )
    : [];
  const cityFocusRaw = !options.anchorAround
    ? enumerateCityFocusPlacements(
        contour,
        preset,
        hint,
        options.targetDistanceKm,
      )
    : [];
  const raw = enumerateCandidates(
    contour,
    preset,
    hint,
    options.anchorAround,
    options.targetDistanceKm,
  );

  const validCityFirst: ValidCandidate[] = [];
  for (const p of cityFirstRaw) {
    const v = sanityFilter(contour, preset, p);
    if (v) validCityFirst.push(v);
  }

  const validCityFocus: ValidCandidate[] = [];
  for (const p of cityFocusRaw) {
    const v = sanityFilter(contour, preset, p);
    if (v) validCityFocus.push({ ...v, kind: "city-focus" });
  }

  const validGeneric: ValidCandidate[] = [];
  for (const p of raw) {
    const v = sanityFilter(contour, preset, p);
    if (v) validGeneric.push(v);
  }
  const validVisionDesign = !options.anchorAround
    ? designDraftCandidates(
        visionDesignDrafts,
        preset,
        hint,
        options.targetDistanceKm,
      )
    : [];
  const valid = [
    ...validVisionDesign,
    ...designedCityRoutes,
    ...validCityFirst,
    ...validCityFocus,
    ...validGeneric,
  ];
  if (valid.length === 0) {
    return { picks: [], visionUsed: false, hint: hint ?? undefined };
  }

  const visionDesignBudget =
    validVisionDesign.length > 0
      ? Math.min(18, Math.ceil(snapCount * 0.5))
      : 0;
  const visionDesignSubset =
    visionDesignBudget > 0
      ? diverseSubsample(validVisionDesign, visionDesignBudget, preset)
      : [];
  const designedBudget =
    designedCityRoutes.length > 0
      ? Math.min(
          4,
          Math.max(
            0,
            Math.ceil((snapCount - visionDesignSubset.length) * 0.25),
          ),
        )
      : 0;
  const designedSubset =
    designedBudget > 0
      ? diverseSubsample(designedCityRoutes, designedBudget, preset)
      : [];
  const cityFirstBudget =
    validCityFirst.length > 0
      ? Math.min(
          12,
          Math.max(
            0,
            Math.ceil(
              (snapCount - visionDesignSubset.length - designedSubset.length) *
                0.6,
            ),
          ),
        )
      : 0;
  const cityFirstSubset =
    cityFirstBudget > 0
      ? diverseSubsample(validCityFirst, cityFirstBudget, preset)
      : [];
  const cityFocusBudget =
    validCityFocus.length > 0
      ? Math.min(
          12,
          Math.max(
            0,
            Math.ceil(
              (snapCount -
                visionDesignSubset.length -
                designedSubset.length -
                cityFirstSubset.length) *
                0.5,
            ),
          ),
        )
      : 0;
  const cityFocusSubset =
    cityFocusBudget > 0
      ? diverseSubsample(validCityFocus, cityFocusBudget, preset)
      : [];
  const genericSubset = diverseSubsample(
    validGeneric,
    Math.max(
      0,
      snapCount -
        visionDesignSubset.length -
        designedSubset.length -
        cityFirstSubset.length -
        cityFocusSubset.length,
    ),
    preset,
  );
  const subset = [
    ...visionDesignSubset,
    ...designedSubset,
    ...cityFirstSubset,
    ...cityFocusSubset,
    ...genericSubset,
  ];
  const snapped = await parallelSnap(subset, options.anchorSource, preset);
  if (snapped.length === 0) {
    return { picks: [], visionUsed: false, hint: hint ?? undefined };
  }

  if (!parsedOrig) {
    return {
      picks: makePicks(snapped, null, null, topK),
      visionUsed: false,
      hint: hint ?? undefined,
    };
  }

  // Pre-load a map-backed tile image for each snapped candidate in parallel.
  // Putting the route on an actual Mapbox backdrop (streets + water visible) is
  // what lets the vision ranker reject candidates that sit over water or
  // inside parks — outline-only tiles can't carry that signal.
  const mapImages = await Promise.all(
    snapped.map((s) => loadRouteStaticMapImage(s.coords, { size: 256 })),
  );

  const grid = buildCompositeGridDataUrl(
    snapped.map((s, i) => ({ route: s.coords, mapImage: mapImages[i] ?? null })),
    { tileSize: 256, cols: 5 },
  );
  if (!grid) {
    return {
      picks: makePicks(snapped, null, null, topK),
      visionUsed: false,
      hint: hint ?? undefined,
    };
  }

  // Per-browser memory of previously finalized placements — lets Claude
  // gently favour candidates that match what this user actually kept before.
  const userHistory = loadFinalizedRoutes();

  const ranked = await visionRank(
    grid.rawBase64,
    parsedOrig.data,
    parsedOrig.mediaType,
    snapped.length,
    topK,
    userHistory,
    preset.label,
    snapped.map((s) => s.designIntent ?? ""),
  );

  if (!ranked || ranked.length === 0) {
    return {
      picks: makePicks(snapped, null, null, topK),
      visionUsed: false,
      hint: hint ?? undefined,
    };
  }

  const order: number[] = [];
  const reasons = new Map<number, string>();
  for (const r of ranked) {
    const idx = r.id - 1;
    if (idx < 0 || idx >= snapped.length) continue;
    if (order.includes(idx)) continue; // dedupe
    order.push(idx);
    reasons.set(idx, r.reason);
  }

  return {
    picks: makePicks(snapped, order, reasons, topK),
    visionUsed: true,
    hint: hint ?? undefined,
  };
}
