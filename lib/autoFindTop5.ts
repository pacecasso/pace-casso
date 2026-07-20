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
import { generateMapNativeCandidates } from "./mapNativeDesigner";
import {
  CURATED_NIKE_SWOOSH_DESIGN_INTENT,
  curatedNikeSwooshMapNativeCandidate,
  curatedNikeSwooshRouteLine,
} from "./curatedNikeSwooshManhattanRoute";
import { compileContourToLattice } from "./latticeCompiler";
import { getManhattanLatticeGraph } from "./manhattanLattice";

const MARGIN = 0.012;
const MIN_PERIMETER_KM = 3;
/**
 * Accommodates hero-scale placements (e.g. an island-sized heart on Manhattan,
 * perimeter ≈ 28–32 km). The snap-ratio filter + vision rank still weed out
 * candidates that don't read at that size, so widening here only expands the
 * candidate *pool*, not the output quality bar.
 */
const MAX_PERIMETER_KM = 35;
/**
 * Call budget: each snapped candidate costs roughly startVariantCount x
 * chunk-count Mapbox Directions calls plus one map-matching pass. 48
 * candidates x 4 variants blew straight past the 180/min API window and the
 * resulting 429s silently dropped candidates. 28 x 3 with wider batch gaps
 * fits the window; failures are now counted and surfaced to the user.
 */
const CANDIDATES_TO_SNAP = 28;
const SNAP_BATCH_SIZE = 4;
const SNAP_BATCH_GAP_MS = 250;
const SNAP_START_VARIANTS = 3;

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
  /** 0-100, where higher means the final snapped route resembles the source upload itself. */
  sourceMatchScore: number;
  /** True when this is a verified curated route, not a generic auto-found candidate. */
  verifiedRoute?: boolean;
  /** Human-readable verification label for curated/map-native routes. */
  verificationLabel?: string;
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
  /** Candidates that could not be street-checked (rate limit / network).
   *  When > 0 the results are partial and a retry may find better options. */
  snapFailures?: number;
  /** True when no candidate cleared the quality gates and the picks are the
   *  best-available routes instead. The UI should soften its messaging. */
  relaxedQuality?: boolean;
};

export type AutoFindTop5Options = {
  anchorSource?: AnchorPathSource;
  /** Reference image as a data-URL or raw base64. When absent, vision is skipped. */
  imageBase64?: string;
  /** Original upload filename; used only as a weak hint for letter/wordmark uploads. */
  imageSourceName?: string;
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

export function usableTargetDistanceKm(
  hint: ShapeHint | null | undefined,
  explicitTargetDistanceKm?: number,
): number | undefined {
  if (
    explicitTargetDistanceKm != null &&
    Number.isFinite(explicitTargetDistanceKm) &&
    explicitTargetDistanceKm > 0
  ) {
    return explicitTargetDistanceKm;
  }
  if (!hint) return undefined;
  // Lettering needs size above all else: a glyph stroke has to be several
  // blocks thick to read from map altitude. 9 km produced cramped, illegible
  // wordmarks; the best one this project has made is ~50 km.
  if (hint.shapeClass === "letter") return 18;
  if (hint.shapeClass === "geometric") return 14;
  if (hint.shapeClass === "creature") {
    return hint.scaleHint === "sprawling" ? 18 : 14;
  }
  if (hint.scaleHint === "compact") return 12;
  if (hint.scaleHint === "sprawling") return 18;
  return 14;
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
 * Legibility scale floor — the July 2026 "detail density needs scale" lesson.
 *
 * A detailed contour (dense traced outline, feature-rich AI sketch) only
 * survives street-grid quantization when its sampled detail maps to at
 * least about a city block on the ground. Below that, curves and features
 * collapse into noise — the shrunken-scribble failure mode. The p25 segment
 * length must land at ≥ ~55 m (the lattice compiler's pin spacing).
 *
 * Sparse icons return 0 (no floor): a 12-point heart is legible at any
 * scale the hint proposes. metersPerUnit here mirrors placementFromContour:
 * (2000 * scale) / maxDim.
 */
/**
 * The July 2026 dense-design experiment (legibility scale floor, first-class
 * lattice draft candidates, compile-fidelity quality override, street-native
 * snapping, 34 km truth floor). It made dense pixel-traced logos legible in
 * harness runs with a vision key - but in production it force-upscales
 * simple shapes (a bolt's sharp corners read as "dense"), replaces the
 * user's contour with grid staircases, and reports compile fidelity where
 * the gates expect route quality, so ugly routes win. Off by default;
 * re-enable with NEXT_PUBLIC_AUTOFIND_LATTICE=1 once re-tuned.
 */
const DENSE_LATTICE_PATH_ENABLED =
  typeof process !== "undefined" &&
  process.env?.NEXT_PUBLIC_AUTOFIND_LATTICE === "1";

export function legibilityScaleFloor(contour: ContourPoint[]): number {
  if (contour.length < 24) return 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of contour) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const maxDim = Math.max(maxX - minX, maxY - minY);
  if (!(maxDim > 0)) return 0;

  // Strokes = spans between significant direction changes (>35°). These are
  // the drawing's FEATURES (a head arc, a hose loop, a leg) — the thing that
  // must survive quantization — as opposed to raw sample segments, which
  // just reflect how densely curves were sampled.
  let perimeter = 0;
  const strokes: number[] = [];
  let strokeLen = 0;
  for (let i = 1; i < contour.length; i++) {
    const dx = contour[i]!.x - contour[i - 1]!.x;
    const dy = contour[i]!.y - contour[i - 1]!.y;
    const d = Math.hypot(dx, dy);
    perimeter += d;
    strokeLen += d;
    if (i < contour.length - 1) {
      const dx2 = contour[i + 1]!.x - contour[i]!.x;
      const dy2 = contour[i + 1]!.y - contour[i]!.y;
      const l2 = Math.hypot(dx2, dy2);
      if (d > 1e-9 && l2 > 1e-9) {
        const cos = Math.max(-1, Math.min(1, (dx * dx2 + dy * dy2) / (d * l2)));
        const turnDeg = (Math.acos(cos) * 180) / Math.PI;
        if (turnDeg > 35) {
          if (strokeLen > 0.004) strokes.push(strokeLen);
          strokeLen = 0;
        }
      }
    }
  }
  if (strokeLen > 0.004) strokes.push(strokeLen);
  if (strokes.length < 6 || !(perimeter > 0)) return 0;
  strokes.sort((a, b) => a - b);
  const p25 = strokes[Math.floor(strokes.length * 0.25)]!;
  if (!(p25 > 0)) return 0;

  // A feature needs ~2 city blocks (170 m) to read after snapping.
  // metersPerUnit mirrors placementFromContour: (2000 * scale) / maxDim.
  const featureFloor = (170 * maxDim) / (2000 * p25);
  // But never push the route past what the pipeline can hold (35 km
  // perimeter cap, with a little headroom).
  const kmAtScale1 = (perimeter * 2) / maxDim; // (perimeter/maxDim)*2000m per unit
  const kmCap = kmAtScale1 > 0 ? 33 / kmAtScale1 : Infinity;
  const floor = Math.min(featureFloor, kmCap, 4.5);
  // Below ~0.7 the hint scales already cover it — no floor needed.
  return floor >= 0.7 ? floor : 0;
}

/**
 * Drop sub-legible scale rungs and guarantee legible ones. Placements the
 * city can't hold at these scales die in sanityFilter, exactly as before —
 * this only stops us from spending the candidate budget on scales where a
 * dense drawing is guaranteed mush.
 */
function applyLegibilityFloor(
  scales: number[],
  contour: ContourPoint[],
): number[] {
  if (!DENSE_LATTICE_PATH_ENABLED) return scales;
  const floor = legibilityScaleFloor(contour);
  if (floor <= 0) return scales;
  const out = scales.filter((s) => s >= floor);
  out.push(Math.min(floor, 6), Math.min(floor * 1.2, 6));
  return Array.from(new Set(out.map((s) => Number(s.toFixed(3))))).sort(
    (a, b) => a - b,
  );
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
  // Either way, dense contours get a legibility floor: detail below block
  // size quantizes into noise, so sub-legible rungs are wasted budget.
  const scales = applyLegibilityFloor(
    (targetDistanceKm != null
      ? scalesFromTargetDistance(contour, preset, targetDistanceKm)
      : null) ?? scalesFromHint(hint),
    contour,
  );
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
  const scales = applyLegibilityFloor(
    targetDistanceKm != null && Number.isFinite(targetDistanceKm)
      ? scalesFromTargetDistance(contour, preset, targetDistanceKm) ?? [1.2, 1.6, 2.1]
      : [0.85, 1.15, 1.55, 2.05, 2.65, 3.35],
    contour,
  );

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
  const scales = applyLegibilityFloor(
    (targetDistanceKm != null
      ? scalesFromTargetDistance(contour, preset, targetDistanceKm)
      : null) ?? scalesFromHint(hint),
    contour,
  );
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
  routeMode?: "direct-grid";
  /**
   * For lattice-compiled candidates: quality derived from compile fidelity
   * (meanDev/detour/skipped pins). Retrace-heavy designs are CLEAN by
   * construction — every point is a street junction on the intended path —
   * but routeQualityScore reads their deliberate out-and-backs as
   * backtracking mess and five separate gates then reject them.
   */
  compiledQuality?: number;
  kind?:
    | "generic"
    | "city-focus"
    | "city-heart"
    | "designed-heart"
    | "reference-heart"
    | "vision-design"
    | "street-design"
    | "street-wordmark";
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
        const featuresText = draft.visualFeatures?.length
          ? ` Features: ${draft.visualFeatures.join(", ")}.`
          : "";
        validForDraft.push({
          ...v,
          designIntent: `${draft.label}: ${draft.description}${featuresText}`,
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

function localMetricPoints(coords: [number, number][]): ContourPoint[] {
  const valid = coords.filter((p) => isValidLatLng(p));
  if (valid.length < 2) return [];
  const lat0 =
    valid.reduce((sum, [lat]) => sum + lat, 0) / Math.max(1, valid.length);
  const lng0 =
    valid.reduce((sum, [, lng]) => sum + lng, 0) / Math.max(1, valid.length);
  const metersPerLat = 111_320;
  const metersPerLng = metersPerLat * Math.cos((lat0 * Math.PI) / 180);
  return valid.map(([lat, lng]) => ({
    x: (lng - lng0) * metersPerLng,
    y: (lat - lat0) * metersPerLat,
  }));
}

function localPathLength(points: ContourPoint[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y,
    );
  }
  return d;
}

function boundsForPoints(points: ContourPoint[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return {
    width,
    height,
    diagonal: Math.hypot(width, height) || 1,
  };
}

function normalizedFeatureSimilarity(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-6);
  return Math.max(0, 1 - Math.abs(a - b) / scale);
}

function directionHistogram(points: ContourPoint[], bins = 8): number[] {
  const hist = Array.from({ length: bins }, () => 0);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= 0) continue;
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) + Math.PI * 2) % Math.PI;
    const idx = Math.min(bins - 1, Math.floor((angle / Math.PI) * bins));
    hist[idx] += len;
    total += len;
  }
  return total > 0 ? hist.map((v) => v / total) : hist;
}

function histogramSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let diff = 0;
  for (let i = 0; i < n; i++) diff += Math.abs(a[i]! - b[i]!);
  return Math.max(0, 1 - diff / 2);
}

function significantTurnStats(points: ContourPoint[]): {
  count: number;
  strength: number;
} {
  if (points.length < 3) return { count: 0, strength: 0 };
  const step = Math.max(1, Math.floor(points.length / 90));
  const sampled = points.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== points[points.length - 1]) {
    sampled.push(points[points.length - 1]!);
  }

  let count = 0;
  let strength = 0;
  for (let i = 1; i < sampled.length - 1; i++) {
    const p0 = sampled[i - 1]!;
    const p1 = sampled[i]!;
    const p2 = sampled[i + 1]!;
    const ax = p1.x - p0.x;
    const ay = p1.y - p0.y;
    const bx = p2.x - p1.x;
    const by = p2.y - p1.y;
    const al = Math.hypot(ax, ay);
    const bl = Math.hypot(bx, by);
    if (al <= 0 || bl <= 0) continue;
    const dot = (ax * bx + ay * by) / (al * bl);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (angle >= Math.PI / 7) {
      count++;
      strength += angle;
    }
  }
  return { count, strength };
}

function visualSignature(points: ContourPoint[]) {
  const bounds = boundsForPoints(points);
  const pathLen = localPathLength(points);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const chord = Math.hypot(last.x - first.x, last.y - first.y);
  const aspect =
    Math.max(bounds.width, bounds.height) / Math.max(1, Math.min(bounds.width, bounds.height));
  const closedness = Math.max(0, 1 - chord / Math.max(1, bounds.diagonal * 0.35));
  const pathChordRatio = pathLen / Math.max(1, chord || bounds.diagonal);
  const turns = significantTurnStats(points);
  return {
    aspect,
    closedness,
    pathChordRatio,
    turnCount: turns.count,
    turnStrength: turns.strength,
    directions: directionHistogram(points),
  };
}

export function visualStructureMatchPercent(
  intended: [number, number][],
  actual: [number, number][],
): number {
  const aPts = localMetricPoints(intended);
  const bPts = localMetricPoints(actual);
  if (aPts.length < 2 || bPts.length < 2) return 0;
  const a = visualSignature(aPts);
  const b = visualSignature(bPts);

  const aspect = normalizedFeatureSimilarity(Math.log(a.aspect), Math.log(b.aspect));
  const closed = 1 - Math.min(1, Math.abs(a.closedness - b.closedness));
  const pathRatio = normalizedFeatureSimilarity(
    Math.log(a.pathChordRatio),
    Math.log(b.pathChordRatio),
  );
  const turnCount = normalizedFeatureSimilarity(a.turnCount + 1, b.turnCount + 1);
  const turnStrength = normalizedFeatureSimilarity(
    a.turnStrength + 0.1,
    b.turnStrength + 0.1,
  );
  const direction = histogramSimilarity(a.directions, b.directions);

  const score =
    aspect * 0.16 +
    closed * 0.18 +
    pathRatio * 0.18 +
    turnCount * 0.17 +
    turnStrength * 0.13 +
    direction * 0.18;
  return Math.round(Math.max(0, Math.min(100, score * 100)));
}

export function routeShapeMatchPercent(
  intended: [number, number][],
  actual: [number, number][],
): number {
  const proximity = interpretationMatchPercent(intended, actual);
  const structure = visualStructureMatchPercent(intended, actual);
  // Etch-a-sketch GPS art: gestalt and coarse silhouette beat pixel-tight fit.
  const blended = proximity * 0.42 + structure * 0.58;
  const cap = structure < 32 ? Math.min(blended, structure + 48) : blended;
  return Math.round(Math.max(0, Math.min(100, cap)));
}

function isSourceDerivedCandidate(kind: ValidCandidate["kind"] | undefined): boolean {
  return kind == null || kind === "generic" || kind === "city-focus";
}

function blendedCandidateShapeMatch({
  candidateAnchors,
  sourceAnchors,
  routeCoords,
  kind,
}: {
  candidateAnchors: [number, number][];
  sourceAnchors: [number, number][];
  routeCoords: [number, number][];
  kind: ValidCandidate["kind"] | undefined;
}): { shapeMatchScore: number; sourceMatchScore: number } {
  const candidateMatch = routeShapeMatchPercent(candidateAnchors, routeCoords);
  const sourceMatch = routeShapeMatchPercent(sourceAnchors, routeCoords);
  if (isSourceDerivedCandidate(kind)) {
    return {
      shapeMatchScore: candidateMatch,
      sourceMatchScore: sourceMatch,
    };
  }

  const sourceWeight =
    kind === "street-wordmark" ? 0.5 : kind === "street-design" ? 0.28 : 0.22;
  const blended = candidateMatch * (1 - sourceWeight) + sourceMatch * sourceWeight;
  const sourceCapPadding =
    kind === "street-wordmark" ? 32 : kind === "street-design" ? 48 : 52;
  const capped = Math.min(blended, sourceMatch + sourceCapPadding);
  return {
    shapeMatchScore: Math.round(Math.max(0, Math.min(100, capped))),
    sourceMatchScore: sourceMatch,
  };
}

export function anchorSourceForAutoFindCandidate(
  routeMode: ValidCandidate["routeMode"] | undefined,
  requested: AnchorPathSource | undefined,
): AnchorPathSource | undefined {
  return routeMode === "direct-grid" ? "street-native" : requested;
}

function directGridRouteFromAnchors(
  anchors: [number, number][],
): {
  coords: [number, number][];
  snappedKm: number;
  route: RouteLineString;
} | null {
  if (anchors.length < 2) return null;
  let meters = 0;
  for (let i = 1; i < anchors.length; i++) {
    meters += haversineMeters(anchors[i - 1]!, anchors[i]!);
  }
  return {
    coords: anchors,
    snappedKm: meters / 1000,
    route: {
      coordinates: anchors,
      distanceMeters: meters,
      blockWaypoints: anchors,
    },
  };
}
async function snapOne(
  anchors: [number, number][],
  anchorSource: AnchorPathSource | undefined,
): Promise<
  | {
      coords: [number, number][];
      snappedKm: number;
      route: RouteLineString;
    }
  | "snap-error"
  | null
> {
  try {
    if (anchors.length < 2) return null;
    const route = await snapWalkingRoute(anchors, {
      anchorSource,
      startVariantCount: SNAP_START_VARIANTS,
    });
    const coords = route.coordinates as [number, number][];
    if (coords.length < 2) return null;
    const snappedKm = snappedRouteDistanceKm(route);
    if (snappedKm == null) return null;
    return { coords, snappedKm, route };
  } catch {
    // Rate limit / network / API failure — the candidate was never actually
    // evaluated. Counted separately so the UI can tell the user results are
    // partial instead of silently degrading.
    return "snap-error";
  }
}

type SnappedCandidate = {
  placement: PlacementTransform;
  anchors: [number, number][];
  designIntent?: string;
  kind?: ValidCandidate["kind"];
  routeMode?: ValidCandidate["routeMode"];
  coords: [number, number][];
  route: RouteLineString;
  /** Snapped walking distance in km (what Mapbox returned). */
  km: number;
  /** 0-100, penalizes unnecessary reverse retracing and fussy short jogs. */
  qualityScore: number;
  /** 0-100, rewards snapped geometry that still follows the intended artwork. */
  shapeMatchScore: number;
  /** 0-100, rewards resemblance to the user's uploaded/approved source sketch. */
  sourceMatchScore: number;
};

type StructuralRequirement = "gas-pump-person";

export type AutoFindPickSelectionCandidate = {
  placement: PlacementTransform;
  kind?: ValidCandidate["kind"];
  routeMode?: ValidCandidate["routeMode"];
  designIntent?: string;
  qualityScore: number;
  shapeMatchScore: number;
  sourceMatchScore?: number;
  distanceKm?: number;
};

export function scoreAutoPlacementCandidate(
  qualityScore: number,
  shapeMatchScore: number,
): number {
  const clean = Math.max(0, Math.min(100, qualityScore));
  const shape = Math.max(0, Math.min(100, shapeMatchScore));
  return shape * 0.7 + clean * 0.3;
}

function candidateDistancePenalty(distanceKm: number | undefined): number {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return 0;
  // Runners target ~10–25 km for readable brand art; don't punish until past 25.
  if (distanceKm <= 25) return 0;
  if (distanceKm <= 32) return (distanceKm - 25) * 0.65;
  return 4.55 + (distanceKm - 32) * 1.5;
}

function candidateSelectionScore(
  candidate: AutoFindPickSelectionCandidate,
  preferredRank: number | undefined,
  preferredCount: number,
  preferredWeight: number,
): number {
  const base = scoreAutoPlacementCandidate(
    candidate.qualityScore,
    candidate.shapeMatchScore,
  );
  const clean = Math.max(0, Math.min(100, candidate.qualityScore));
  const cleanPenalty = clean < 30 ? (30 - clean) * 1.15 : 0;
  const visionBonus =
    preferredRank == null
      ? 0
      : preferredWeight * (1 - preferredRank / Math.max(1, preferredCount));
  return (
    base +
    visionBonus -
    cleanPenalty -
    candidateDistancePenalty(candidate.distanceKm)
  );
}

/**
 * The absolute floor: routes below this are never shown, not even by the
 * best-available fallback. Showing an unreadable tangle is worse than
 * showing nothing — the user can't tell it's junk from a thumbnail, runs
 * 10 km, and gets a scribble on Strava. Empty + an honest message beats
 * five red tangles (the "Ranks2" failure).
 *
 * Deliberately far below the normal display bar: this only catches routes
 * that cannot possibly read as the uploaded artwork.
 */
export function meetsAbsoluteDisplayFloor(
  candidate: AutoFindPickSelectionCandidate,
): boolean {
  const clean = clampPercent(candidate.qualityScore);
  const shape = clampPercent(candidate.shapeMatchScore);
  const distance = candidate.distanceKm;
  // Block-letter wordmarks are drawn directly on avenue/street lines, where
  // length is what makes the letters readable — the best one this project
  // has made is 50 km. Judging them by the same distance rule as a snapped
  // silhouette would throw away the good ones.
  const gridWordmark =
    candidate.kind === "street-wordmark" && candidate.routeMode === "direct-grid";
  const maxKm = gridWordmark ? 56 : 32;
  if (shape < 30) return false;
  if (clean < 20) return false;
  if (distance != null && Number.isFinite(distance) && distance > maxKm) {
    return false;
  }
  return true;
}

export function isDisplayWorthyAutoFindCandidate(
  candidate: AutoFindPickSelectionCandidate,
): boolean {
  const clean = Math.max(0, Math.min(100, candidate.qualityScore));
  const shape = Math.max(0, Math.min(100, candidate.shapeMatchScore));
  const distance = candidate.distanceKm;
  // See meetsAbsoluteDisplayFloor: grid-drawn wordmarks earn a much larger
  // distance budget, because scale is what makes block letters legible.
  const gridWordmark =
    candidate.kind === "street-wordmark" && candidate.routeMode === "direct-grid";
  const maxKm = gridWordmark ? 56 : 30;
  if (shape < 40) return false;
  if (clean < 28) return false;
  if (distance != null && Number.isFinite(distance) && distance > maxKm) {
    return false;
  }
  return clean >= 28 || shape >= 58;
}

type FinalRouteTruthVerdict = {
  ok: boolean;
  reason: string;
  minShape: number;
  minSource: number;
  minClean: number;
  maxDistanceKm: number;
};

function clampPercent(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function finalRouteTruthFloors(
  candidate: AutoFindPickSelectionCandidate,
  hint: ShapeHint | null | undefined,
  requiredVisualFeatures: string[],
): Omit<FinalRouteTruthVerdict, "ok" | "reason"> {
  const featureText = requiredVisualFeatures.join(" ").toLowerCase();
  const isWordmark =
    hint?.shapeClass === "letter" ||
    candidate.kind === "street-wordmark" ||
    /\b(letter|letters|word|wordmark|baseline|reading order)\b/.test(
      featureText,
    );
  const directGridWordmark =
    candidate.kind === "street-wordmark" && candidate.routeMode === "direct-grid";
  const needsSweep = requiresSweepStructure(requiredVisualFeatures);
  const isCuratedNike = /\bcurated nike swoosh manhattan v1\b/.test(
    (candidate.designIntent ?? "").toLowerCase(),
  );
  const needsStar = requiresStarStructure(requiredVisualFeatures);
  const needsBolt = requiresBoltStructure(requiredVisualFeatures);

  if (directGridWordmark) {
    // Block letters are drawn straight onto avenue/street lines, so extra
    // length is extra legibility, not sprawl — the best wordmark this
    // project has produced ran 50 km across 14th-54th Street. A 24 km
    // ceiling silently rejected exactly that class of route.
    return { minShape: 45, minSource: 20, minClean: 7, maxDistanceKm: 56 };
  }
  if (isCuratedNike) {
    return { minShape: 42, minSource: 0, minClean: 20, maxDistanceKm: 12 };
  }
  if (isWordmark) {
    return { minShape: 62, minSource: 42, minClean: 18, maxDistanceKm: 42 };
  }
  if (hint?.shapeClass === "geometric" || needsStar || needsBolt) {
    return { minShape: 50, minSource: 28, minClean: 35, maxDistanceKm: 25 };
  }
  if (needsSweep) {
    if (candidate.kind === "street-design") {
      return { minShape: 42, minSource: 0, minClean: 25, maxDistanceKm: 25 };
    }
    return { minShape: 48, minSource: 26, minClean: 30, maxDistanceKm: 25 };
  }
  if (candidate.kind === "street-design" || candidate.kind === "vision-design") {
    // Sketch-led routes: judge readability of the etch-a-sketch, not pixel
    // trace. The 34 km allowance only makes sense when the legible-scale
    // lattice path is on; otherwise it just lets sprawl through.
    return {
      minShape: 45,
      minSource: 0,
      minClean: 25,
      maxDistanceKm: DENSE_LATTICE_PATH_ENABLED ? 34 : 25,
    };
  }
  return { minShape: 48, minSource: 30, minClean: 28, maxDistanceKm: 30 };
}

export function finalRouteTruthVerdict(
  candidate: AutoFindPickSelectionCandidate,
  hint: ShapeHint | null | undefined = null,
  requiredVisualFeatures: string[] = [],
): FinalRouteTruthVerdict {
  const floors = finalRouteTruthFloors(candidate, hint, requiredVisualFeatures);
  const shape = clampPercent(candidate.shapeMatchScore);
  const clean = clampPercent(candidate.qualityScore);
  const source =
    candidate.sourceMatchScore == null
      ? shape
      : clampPercent(candidate.sourceMatchScore);
  const distance = candidate.distanceKm;

  if (shape < floors.minShape) {
    return { ...floors, ok: false, reason: "low final-route shape match" };
  }
  if (source < floors.minSource) {
    return { ...floors, ok: false, reason: "low source-art match" };
  }
  if (clean < floors.minClean) {
    return { ...floors, ok: false, reason: "messy snapped route" };
  }
  if (
    distance != null &&
    Number.isFinite(distance) &&
    distance > floors.maxDistanceKm
  ) {
    return { ...floors, ok: false, reason: "route is too long to be credible" };
  }
  return { ...floors, ok: true, reason: "truth-worthy snapped route" };
}

function isDisplayWorthyForHint(
  candidate: AutoFindPickSelectionCandidate,
  hint: ShapeHint | null | undefined,
  requiredVisualFeatures: string[] = [],
): boolean {
  const shape = Math.max(0, Math.min(100, candidate.shapeMatchScore));
  const clean = Math.max(0, Math.min(100, candidate.qualityScore));
  const source =
    candidate.sourceMatchScore == null
      ? shape
      : Math.max(0, Math.min(100, candidate.sourceMatchScore));
  const distance = candidate.distanceKm;
  if (!finalRouteTruthVerdict(candidate, hint, requiredVisualFeatures).ok) {
    return false;
  }
  if (/\bcurated nike swoosh manhattan v1\b/.test(
    (candidate.designIntent ?? "").toLowerCase(),
  )) {
    return true;
  }

  if (hint?.shapeClass === "letter") {
    if (candidate.kind === "street-wordmark" && candidate.routeMode === "direct-grid") {
      if (shape < 45) return false;
      if (source < 20) return false;
      if (clean < 7) return false;
      if (distance != null && Number.isFinite(distance) && distance > 24) {
        return false;
      }
      return true;
    }
    if (shape < 70) return false;
    if (source < 45) return false;
    if (clean < 10) return false;
    if (distance != null && Number.isFinite(distance) && distance > 22) {
      return false;
    }
    return true;
  }

  if (candidate.kind === "street-design") {
    if (shape < 42) return false;
    if (clean < 22) return false;
    if (distance != null && Number.isFinite(distance) && distance > 25) {
      return false;
    }
    return true;
  }

  if (!isDisplayWorthyAutoFindCandidate(candidate)) return false;
  if (source < 38 && shape < 82) {
    return false;
  }

  if (hint?.shapeClass === "geometric") {
    if (shape < 52) return false;
    if (source < 28) return false;
    return !(clean >= 55 && shape < 58);
  }

  return true;
}

function normalizedDesignSpacePoints(
  coords: [number, number][],
  placement: PlacementTransform,
): ContourPoint[] {
  if (coords.length < 2) return [];
  const center = placement.center;
  const metersPerLat = 111_320;
  const metersPerLng =
    metersPerLat * Math.cos((center[0] * Math.PI) / 180);
  const rad = (placement.rotationDeg * Math.PI) / 180;
  const xAxis = { east: Math.sin(rad), north: Math.cos(rad) };
  const yAxis = {
    east: Math.sin(rad + Math.PI / 2),
    north: Math.cos(rad + Math.PI / 2),
  };

  const raw = coords.map(([lat, lng]) => {
    const east = (lng - center[1]) * metersPerLng;
    const north = (lat - center[0]) * metersPerLat;
    return {
      x: east * xAxis.east + north * xAxis.north,
      y: east * yAxis.east + north * yAxis.north,
    };
  });
  const xs = raw.map((p) => p.x);
  const ys = raw.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  return raw.map((p) => ({
    x: (p.x - minX) / width,
    y: (p.y - minY) / height,
  }));
}

function span(points: ContourPoint[], axis: "x" | "y"): number {
  if (points.length === 0) return 0;
  const values = points.map((p) => p[axis]);
  return Math.max(...values) - Math.min(...values);
}

function segmentLengthNorm(a: ContourPoint, b: ContourPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function gasPumpPersonStructureScore(
  coords: [number, number][],
  placement: PlacementTransform,
): number {
  const pts = normalizedDesignSpacePoints(coords, placement);
  if (pts.length < 4) return 0;

  let total = 0;
  let leftLen = 0;
  let midLen = 0;
  let rightLen = 0;
  const leftPts: ContourPoint[] = [];
  const midPts: ContourPoint[] = [];
  const rightPts: ContourPoint[] = [];

  for (const p of pts) {
    if (p.x <= 0.44) leftPts.push(p);
    if (p.x >= 0.32 && p.x <= 0.76) midPts.push(p);
    if (p.x >= 0.58) rightPts.push(p);
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = segmentLengthNorm(a, b);
    const mx = (a.x + b.x) / 2;
    total += len;
    if (mx <= 0.44) leftLen += len;
    if (mx >= 0.32 && mx <= 0.76) midLen += len;
    if (mx >= 0.58) rightLen += len;
  }
  if (total <= 0) return 0;

  const leftRatio = leftLen / total;
  const midRatio = midLen / total;
  const rightRatio = rightLen / total;
  const leftY = span(leftPts, "y");
  const leftX = span(leftPts, "x");
  const midY = span(midPts, "y");
  const rightY = span(rightPts, "y");
  const rightX = span(rightPts, "x");

  let score = 0;
  score +=
    30 *
    Math.min(1, leftRatio / 0.25) *
    Math.min(1, leftY / 0.45) *
    Math.min(1, leftX / 0.12);
  score +=
    28 *
    Math.min(1, rightRatio / 0.16) *
    Math.min(1, rightY / 0.35) *
    Math.min(1, rightX / 0.08);
  score +=
    24 *
    Math.min(1, midRatio / 0.18) *
    Math.min(1, midY / 0.24);
  if (leftRatio >= 0.16 && midRatio >= 0.12 && rightRatio >= 0.1) {
    score += 18;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function structuralScore(
  candidate: SnappedCandidate,
  requirement: StructuralRequirement | null,
): number {
  if (requirement === "gas-pump-person") {
    return gasPumpPersonStructureScore(candidate.coords, candidate.placement);
  }
  return 100;
}

export function hasCompleteGasPumpPersonText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(gas|pump|fuel|nozzle)\b/.test(t) &&
    /\b(hose|nozzle|cable|loop|arc|handle)\b/.test(t) &&
    /\b(person|human|figure|head|body|torso|legs|arm|hand|headphones)\b/.test(
      t,
    )
  );
}

function hasAnyFeatureText(text: string, keywords: RegExp): boolean {
  return keywords.test(text.toLowerCase());
}

function passesStructuralTextGate(
  candidate: SnappedCandidate,
  reason: string | undefined,
  requirement: StructuralRequirement | null,
): boolean {
  if (requirement !== "gas-pump-person") return true;
  if (!hasCompleteGasPumpPersonText(candidate.designIntent ?? "")) {
    return false;
  }
  return reason == null || hasCompleteGasPumpPersonText(reason);
}

function isRouteNativeVisualMatch(
  candidate: SnappedCandidate,
  requiredVisualFeatures: string[],
): boolean {
  if (candidate.kind !== "street-design" && candidate.kind !== "street-wordmark") {
    return false;
  }
  if (requiredVisualFeatures.length === 0) return false;

  const intent = (candidate.designIntent ?? "").toLowerCase();
  const isRouteLibrary = /\broute-library manhattan\b/.test(intent);
  const goodEnoughRoute =
    candidate.km >= 4.5 &&
    candidate.qualityScore >= 42 &&
    (isRouteLibrary || candidate.shapeMatchScore >= 38);

  if (!goodEnoughRoute) return false;

  if (requiresSweepStructure(requiredVisualFeatures)) {
    if (isRouteLibrary) {
      return (
        /\b(swoosh|sweep|ribbon|wing|rising tail|taper)\b/.test(intent) &&
        candidate.km >= 5.5 &&
        candidate.qualityScore >= 35 &&
        sweepVisualStructureScore(candidate.coords, candidate.placement) >= 34
      );
    }
    return (
      /\b(swoosh|sweep|ribbon|wing|rising tail)\b/.test(intent) &&
      passesSweepDisplayFloor(candidate, requiredVisualFeatures)
    );
  }

  if (requiresBoltStructure(requiredVisualFeatures)) {
    const namesBolt = /\b(lightning|bolt|zig[-\s]?zag|notch|pointed bottom)\b/.test(
      intent,
    );
    const boltStructure = boltVisualStructureScore(candidate.coords);
    return namesBolt &&
      candidate.qualityScore >= 50 &&
      (isRouteLibrary || candidate.shapeMatchScore >= 45) &&
      (isRouteLibrary || boltStructure >= 32);
  }

  if (requiresStarStructure(requiredVisualFeatures)) {
    const namesStar = /\b(star|five[-\s]?point|sharp tip|inner crossing)\b/.test(
      intent,
    );
    return namesStar &&
      candidate.km >= 5 &&
      candidate.km <= 13 &&
      candidate.qualityScore >= 45 &&
      (isRouteLibrary || candidate.shapeMatchScore >= 40);
  }

  return false;
}

function requiredFeatureCoverageThreshold(featureCount: number): number {
  if (featureCount <= 0) return 0;
  if (featureCount <= 3) return 33;
  if (featureCount <= 5) return 40;
  return 50;
}

function passesRequiredVisualFeatureGate(
  candidate: SnappedCandidate,
  reason: string | undefined,
  requiredVisualFeatures: string[],
  requireVisibleReason = false,
): boolean {
  if (requiredVisualFeatures.length === 0) return true;
  // Source-derived candidates ARE the user's own art placed directly on the
  // map — a text-coverage gate on designIntent is meaningless for them (they
  // carry no designIntent at all) and used to hard-drop every one of them
  // whenever vision-design produced feature lists. Their fidelity is judged
  // by the numeric shape/source-match floors instead.
  if (isSourceDerivedCandidate(candidate.kind)) return true;
  if (isRouteNativeVisualMatch(candidate, requiredVisualFeatures)) return true;
  const combinedText = [candidate.designIntent, reason].filter(Boolean).join(" ");
  const text = requireVisibleReason ? reason ?? "" : combinedText;
  if (!text.trim() && !candidate.designIntent?.trim()) return false;
  const threshold = requiredFeatureCoverageThreshold(requiredVisualFeatures.length);
  const designIntentCoverage = requiredFeatureCoverageScore(
    (candidate.designIntent ?? "").toLowerCase(),
    requiredVisualFeatures,
  );
  if (
    (candidate.kind === "street-design" ||
      candidate.kind === "street-wordmark" ||
      candidate.kind === "vision-design") &&
    designIntentCoverage >= threshold
  ) {
    return true;
  }
  if (requireVisibleReason) {
    const visibleCoverage = requiredFeatureCoverageScore(
      text,
      requiredVisualFeatures,
    );
    if (visibleCoverage >= threshold) {
      return true;
    }
    if (visibleCoverage <= 0) {
      return (
        (candidate.kind === "street-design" ||
          candidate.kind === "street-wordmark" ||
          candidate.kind === "vision-design") &&
        designIntentCoverage >= threshold
      );
    }
    return (
      requiredFeatureCoverageScore(combinedText, requiredVisualFeatures) >=
      threshold
    );
  }
  return (
    requiredFeatureCoverageScore(text, requiredVisualFeatures) >=
    threshold
  );
}

function requiresSweepStructure(requiredVisualFeatures: string[]): boolean {
  return requiredVisualFeatures.some((feature) =>
    /\b(swoosh|sweep|sweeping|wing|ribbon|slash|checkmark|check mark|boomerang)\b/i.test(
      feature,
    ),
  );
}

function requiresTaperedSweep(requiredVisualFeatures: string[]): boolean {
  return requiredVisualFeatures.some((feature) =>
    /\b(taper|tapered|outline|heel|belly|tip)\b/i.test(feature),
  );
}

function requiresBoltStructure(requiredVisualFeatures: string[]): boolean {
  return requiredVisualFeatures.some((feature) =>
    /\b(lightning|bolt|zigzag|zig zag|notch)\b/i.test(feature),
  );
}

function requiresStarStructure(requiredVisualFeatures: string[]): boolean {
  return requiredVisualFeatures.some((feature) =>
    /\b(star|five points|five point|sharp tips|inner crossings)\b/i.test(
      feature,
    ),
  );
}

function requiredVisualStructureThreshold(requiredVisualFeatures: string[]): number {
  return requiresSweepStructure(requiredVisualFeatures) ? 26 : 36;
}

function localDesignSpaceRawPoints(
  coords: [number, number][],
  placement: PlacementTransform,
): ContourPoint[] {
  if (coords.length < 2) return [];
  const center = placement.center;
  const metersPerLat = 111_320;
  const metersPerLng =
    metersPerLat * Math.cos((center[0] * Math.PI) / 180);
  const rad = (placement.rotationDeg * Math.PI) / 180;
  const xAxis = { east: Math.sin(rad), north: Math.cos(rad) };
  const yAxis = {
    east: Math.sin(rad + Math.PI / 2),
    north: Math.cos(rad + Math.PI / 2),
  };

  return coords.map(([lat, lng]) => {
    const east = (lng - center[1]) * metersPerLng;
    const north = (lat - center[0]) * metersPerLat;
    return {
      x: east * xAxis.east + north * xAxis.north,
      y: east * yAxis.east + north * yAxis.north,
    };
  });
}

function pointLineDistanceNorm(
  p: ContourPoint,
  a: ContourPoint,
  b: ContourPoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = Math.hypot(dx, dy) || 1;
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / denom;
}

function dominantChord(
  pts: ContourPoint[],
): { a: ContourPoint; b: ContourPoint; length: number } {
  const step = Math.max(1, Math.floor(pts.length / 96));
  const sampled = pts.filter((_, i) => i % step === 0);
  if (!sampled.includes(pts[pts.length - 1]!)) sampled.push(pts[pts.length - 1]!);
  let best = {
    a: sampled[0]!,
    b: sampled[Math.min(1, sampled.length - 1)]!,
    length: 0,
  };
  for (let i = 0; i < sampled.length; i++) {
    for (let j = i + 1; j < sampled.length; j++) {
      const a = sampled[i]!;
      const b = sampled[j]!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d > best.length) best = { a, b, length: d };
    }
  }
  return best;
}

export function sweepVisualStructureScore(
  coords: [number, number][],
  placement: PlacementTransform,
): number {
  const pts = localDesignSpaceRawPoints(coords, placement);
  if (pts.length < 3) return 0;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (width < 100 || height < 25) return 0;

  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) {
    pathLen += segmentLengthNorm(pts[i - 1]!, pts[i]!);
  }
  const chordInfo = dominantChord(pts);
  const chord = chordInfo.length || 1;
  const diag = Math.hypot(width, height) || 1;
  const maxDeviation = Math.max(
    ...pts.map((p) => pointLineDistanceNorm(p, chordInfo.a, chordInfo.b)),
  );

  const aspect = width / Math.max(height, 1);
  const chordCoverage = chord / diag;
  const curveRatio = maxDeviation / chord;
  const pathRatio = pathLen / chord;

  let score = 0;
  score += Math.min(35, Math.max(0, ((aspect - 1.1) / 1.0) * 35));
  score += Math.min(20, Math.max(0, ((chordCoverage - 0.52) / 0.35) * 20));
  score += Math.min(25, Math.max(0, ((curveRatio - 0.045) / 0.18) * 25));
  score += Math.min(20, Math.max(0, ((pathRatio - 1.06) / 0.55) * 20));

  if (aspect < 1.2) score -= 25;
  if (curveRatio < 0.035) score -= 20;
  if (pathRatio > 3.2) score -= 15;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function boltVisualStructureScore(coords: [number, number][]): number {
  if (coords.length < 4) return 0;
  const lats = coords.map(([lat]) => lat);
  const lngs = coords.map(([, lng]) => lng);
  const midLat = ((Math.min(...lats) + Math.max(...lats)) / 2) * (Math.PI / 180);
  const height = (Math.max(...lats) - Math.min(...lats)) * 111_320;
  const width = (Math.max(...lngs) - Math.min(...lngs)) * 111_320 * Math.cos(midLat);
  if (height < 300 || width < 120) return 0;

  const aspect = height / Math.max(width, 1);
  let directionChanges = 0;
  let previousSign = 0;
  const step = Math.max(1, Math.floor(coords.length / 24));
  for (let i = step; i < coords.length; i += step) {
    const dx = coords[i]![1] - coords[i - step]![1];
    const sign = Math.abs(dx) < 0.0003 ? 0 : Math.sign(dx);
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) {
      directionChanges++;
    }
    if (sign !== 0) previousSign = sign;
  }

  let score = 0;
  score += Math.min(46, Math.max(0, ((aspect - 0.55) / 0.85) * 46));
  score += Math.min(18, Math.max(0, ((height - 700) / 700) * 18));
  score += Math.min(24, directionChanges * 8);
  score += Math.min(12, Math.max(0, ((width - 450) / 650) * 12));

  if (aspect < 0.65) score -= 42;
  if (aspect > 2.8) score -= 18;
  if (directionChanges < 2) score -= 20;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function isCuratedNikeCandidate(candidate: SnappedCandidate): boolean {
  return /\bcurated nike swoosh manhattan v1\b/.test(
    (candidate.designIntent ?? "").toLowerCase(),
  );
}
function requiredVisualStructureScore(
  candidate: SnappedCandidate,
  requiredVisualFeatures: string[],
): number {
  if (!requiresSweepStructure(requiredVisualFeatures)) return 100;
  if (isCuratedNikeCandidate(candidate)) return 100;
  return sweepVisualStructureScore(candidate.coords, candidate.placement);
}

function passesSweepDisplayFloor(
  candidate: SnappedCandidate,
  requiredVisualFeatures: string[],
): boolean {
  if (!requiresSweepStructure(requiredVisualFeatures)) return true;
  if (isCuratedNikeCandidate(candidate)) {
    return candidate.km >= 8 && candidate.km <= 24;
  }
  if (requiresTaperedSweep(requiredVisualFeatures)) {
    const intent = (candidate.designIntent ?? "").toLowerCase();
    if (/\bgrid-etched\b/.test(intent)) {
      return false;
    }
    if (!/\b(taper|tapered|outline|ribbon|broad heel|wide heel|curved belly|thin rising tip)\b/.test(intent)) {
      return false;
    }
  }
  if (/\bhuman-grade manhattan open sweep\b/.test(candidate.designIntent ?? "")) {
    return (
      candidate.qualityScore >= 50 &&
      candidate.shapeMatchScore >= 35 &&
      candidate.km >= 5.5 &&
      candidate.km <= 10
    );
  }
  if (candidate.kind === "street-design") {
    const intent = (candidate.designIntent ?? "").toLowerCase();
    if (/\broute-library manhattan\b/.test(intent)) {
      return (
        /\b(swoosh|sweep|ribbon|wing|rising tail|taper)\b/.test(intent) &&
        candidate.qualityScore >= 35 &&
        candidate.km >= 5.5
      );
    }
    const sweepStructure = sweepVisualStructureScore(
      candidate.coords,
      candidate.placement,
    );
    return sweepStructure >= 34 && candidate.shapeMatchScore >= 50 && candidate.km >= 5.5;
  }
  return candidate.shapeMatchScore >= 52 && candidate.km >= 5.5;
}

function gasRankPriority(candidate: SnappedCandidate): number {
  const intent = (candidate.designIntent ?? "").toLowerCase();
  let score = gasPumpPersonStructureScore(candidate.coords, candidate.placement);
  if (candidate.kind === "street-design") score += 24;
  if (candidate.routeMode === "direct-grid") score += 48;
  if (/\bcurated gas logo manhattan v1\b/.test(intent)) score += 220;
  if (/\b(east village gas pump|gas logo)\b/.test(intent)) score += 36;
  if (/\b(pump|hose loop|headphones|nozzle)\b/.test(intent)) score += 18;
  score += Math.min(18, Math.max(0, candidate.shapeMatchScore - 50));
  score += Math.min(12, Math.max(0, candidate.qualityScore - 45));
  if (candidate.km >= 8 && candidate.km <= 22) score += 14;
  return score;
}

function sweepRankPriority(candidate: SnappedCandidate): number {
  const intent = (candidate.designIntent ?? "").toLowerCase();
  let score = sweepVisualStructureScore(candidate.coords, candidate.placement);
  if (candidate.kind === "street-design") score += 20;
  if (/\broute-library manhattan\b/.test(intent)) score -= 28;
  if (/\bhuman-grade manhattan tapered swoosh outline\b/.test(intent)) {
    score += 80;
  }
  if (/\bcurated nike block lockup manhattan v1\b/.test(intent)) {
    score += 340;
  }
  if (/\bcurated nike swoosh manhattan v1\b/.test(intent)) {
    score += 260;
  }
  if (/\bhuman-grade manhattan open sweep\b/.test(intent)) {
    score += 110;
  }
  if (/\b(short-logo-check|chelsea-hook-check|flat-logo-swoosh)\b/.test(intent)) {
    score += 60;
  }
  if (/\bgrid-etched\b/.test(intent)) {
    score -= 160;
  }
  if (/\bmanhattan corridor ribbon sweep\b/.test(intent)) {
    score += 48;
  }
  if (/\bstreet-native\b/.test(intent)) {
    score -= 14;
  }
  if (/\btaper(?:ed)?\b/.test(intent)) score += 34;
  if (/\boutline\b/.test(intent)) score += 28;
  if (/\b(broad heel|wide heel|curved belly|belly|thin rising tip)\b/.test(intent)) {
    score += 22;
  }
  if (/\bribbon\b/.test(intent)) score += 14;
  if (/\b(open line|one clean open line|plain line|centerline)\b/.test(intent)) {
    score -= 36;
  }
  score += Math.min(16, Math.max(0, candidate.shapeMatchScore - 68));
  score += Math.min(10, Math.max(0, candidate.km - 5));
  return score;
}

function prioritizeSweepRankable(snapped: SnappedCandidate[]): SnappedCandidate[] {
  return [...snapped].sort((a, b) => sweepRankPriority(b) - sweepRankPriority(a));
}

function boltRankPriority(candidate: SnappedCandidate): number {
  const intent = (candidate.designIntent ?? "").toLowerCase();
  const boltStructure = boltVisualStructureScore(candidate.coords);
  let score = 0;
  score += boltStructure;
  if (candidate.kind === "street-design") score += 20;
  if (/\broute-library manhattan .*lightning\b/.test(intent)) score += 90;
  if (/\bhuman-grade manhattan lightning bolt\b/.test(intent)) score += 120;
  if (/\b(zigzag|zig-zag|notch|pointed bottom|lightning)\b/.test(intent)) {
    score += 40;
  }
  if (/\b(open line|plain line|single slash|ribbon sweep|swoosh)\b/.test(intent)) {
    score -= 50;
  }
  score += Math.min(20, Math.max(0, candidate.shapeMatchScore - 65));
  score += Math.min(16, Math.max(0, candidate.qualityScore - 55));
  if (boltStructure < 35) score -= 70;
  if (candidate.km >= 5 && candidate.km <= 10) score += 16;
  return score;
}

function starRankPriority(candidate: SnappedCandidate): number {
  const intent = (candidate.designIntent ?? "").toLowerCase();
  let score = 0;
  if (candidate.kind === "street-design") score += 18;
  if (/\broute-library manhattan .*star\b/.test(intent)) score += 90;
  if (/\b(five[-\s]?point|sharp tip|inner crossing|closed outline)\b/.test(intent)) {
    score += 32;
  }
  score += Math.min(22, Math.max(0, candidate.shapeMatchScore - 52));
  score += Math.min(18, Math.max(0, candidate.qualityScore - 45));
  if (candidate.km >= 6 && candidate.km <= 20) score += 16;
  else if (candidate.km > 20 && candidate.km <= 25) score += 9;
  return score;
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
  preferredWeight = 4,
): number[] {
  const limit = Math.max(0, Math.floor(topK));
  if (limit === 0 || candidates.length === 0) return [];

  const preferredRank = new Map<number, number>();
  for (const i of preferredOrder ?? []) {
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) continue;
    if (!preferredRank.has(i)) preferredRank.set(i, preferredRank.size);
  }
  const scoreOrder = candidates
    .map((c, i) => ({
      i,
      score: candidateSelectionScore(
        c,
        preferredRank.get(i),
        preferredRank.size,
        preferredWeight,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i);
  const ordered = scoreOrder;

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
  sourceContour: ContourPoint[],
): Promise<{ snapped: SnappedCandidate[]; snapFailures: number }> {
  const out: SnappedCandidate[] = [];
  let rejectedByRatio = 0;
  let rejectedByBounds = 0;
  let snapFailures = 0;
  for (let i = 0; i < candidates.length; i += SNAP_BATCH_SIZE) {
    const batch = candidates.slice(i, i + SNAP_BATCH_SIZE);
    const snapped = await Promise.all(
      batch.map(async (c) => {
        const directGrid = c.routeMode === "direct-grid";
        const r = directGrid
          ? directGridRouteFromAnchors(c.anchors)
          : await snapOne(
              c.anchors,
              anchorSourceForAutoFindCandidate(c.routeMode, anchorSource),
            );
        if (r === "snap-error") {
          snapFailures++;
          return null;
        }
        if (!r) return null;

        // Filter 1: snap-destroyed shapes (massive perimeter change)
        const ratio = r.snappedKm / Math.max(c.km, 0.1);
        const streetNative =
          c.kind === "street-design" || c.kind === "street-wordmark";
        const ratioMin =
          c.kind === "street-wordmark"
            ? 0.25
            : directGrid
              ? 0.72
              : streetNative
                ? 0.4
                : SNAP_RATIO_MIN;
        const ratioMax =
          c.kind === "street-wordmark"
            ? 3.2
            : directGrid
              ? 1.4
              : streetNative
                ? 2.4
                : SNAP_RATIO_MAX;
        if (ratio < ratioMin || ratio > ratioMax) {
          rejectedByRatio++;
          if (typeof process !== "undefined" && process.env?.AUTOFIND_DEBUG === "1") {
            console.log(
              `[autoFindTop5:debug] snap-destroyed kind=${c.kind} mode=${c.routeMode ?? "-"} km=${c.km.toFixed(1)} snappedKm=${r.snappedKm.toFixed(1)} ratio=${ratio.toFixed(2)} allowed=[${ratioMin},${ratioMax}]`,
            );
          }
          return null;
        }

        // Filter 2: snap that escaped the city preset (the East-River case)
        if (snapEscapesBounds(r.coords, preset)) {
          rejectedByBounds++;
          return null;
        }

        const cleaned = directGrid
          ? r.route
          : cleanupRouteSpurs(r.route).route;
        const cleanedCoords = cleaned.coordinates;
        const cleanedKm = (cleaned.distanceMeters ?? r.snappedKm * 1000) / 1000;
        const sourceAnchors =
          buildAnchorLatLngsFromContour(sourceContour, c.placement)
            .anchorLatLngs;
        const shapeScores = blendedCandidateShapeMatch({
          candidateAnchors: c.anchors,
          sourceAnchors:
            sourceAnchors.length >= 2 ? sourceAnchors : c.anchors,
          routeCoords: cleanedCoords,
          kind: c.kind,
        });
        return {
          placement: c.placement,
          anchors: c.anchors,
          designIntent: c.designIntent,
          kind: c.kind,
          routeMode: c.routeMode,
          coords: cleanedCoords,
          route: cleaned,
          km: cleanedKm,
          // Compile fidelity may only stand in for route quality when the
          // dense-lattice path is on; the gates/rankers assume this number
          // reflects how the final route actually looks.
          qualityScore:
            (DENSE_LATTICE_PATH_ENABLED ? c.compiledQuality : undefined) ??
            routeQualityScore(cleanedCoords),
          shapeMatchScore: shapeScores.shapeMatchScore,
          sourceMatchScore: shapeScores.sourceMatchScore,
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
  return { snapped: out, snapFailures };
}

/**
 * Compile placed candidates onto the real street-junction lattice
 * (Manhattan only for now). The compiled chain visits actual intersections
 * one block at a time, so the walking-directions snap reproduces it almost
 * losslessly — this is the same "compile onto the lattice" approach that
 * produced the curated Manhattan runs, automated. Compiles cost ~2 ms each;
 * bad placements (over parks, off-grid, big forced detours) fail fidelity
 * gates and are simply not emitted.
 */
/**
 * The hero path for detail-dense drafts (July 2026): place each dense draft
 * at its LEGIBILITY floor scale across the city's focus centers and compile
 * it straight onto the street lattice, ranked by compile fidelity. This is
 * exactly the flow that produced the street-verified GAS/apple/tiger routes
 * — the Mapbox-snap path quantizes dense drawings into mush at the scales
 * the km-target selects, so dense drafts get their own first-class family.
 */
async function latticeDesignDraftCandidates(
  drafts: VisionDesignDraft[],
  preset: CityPreset,
  maxOut: number,
): Promise<ValidCandidate[]> {
  if (!DENSE_LATTICE_PATH_ENABLED) return [];
  if (preset.id !== "manhattan" || drafts.length === 0 || maxOut <= 0) {
    return [];
  }
  let graph;
  try {
    graph = await getManhattanLatticeGraph();
  } catch {
    return [];
  }
  const gridRotations = [0, ...(preset.dominantGridBearingsDeg ?? [])].slice(0, 3);
  const centers = cityFocusCenters(preset);
  const scored: { cand: ValidCandidate; score: number; key: string }[] = [];
  for (const draft of drafts.slice(0, 6)) {
    const floor = legibilityScaleFloor(draft.points);
    if (floor <= 0) continue; // sparse drafts are fine on the normal path
    for (const scale of [floor, Math.min(floor * 1.15, 4.5)]) {
      for (const center of centers) {
        for (const rotationDeg of gridRotations) {
          const placement = { center, rotationDeg, scale };
          const built = buildAnchorLatLngsFromContour(draft.points, placement);
          if (!built.anchorLatLngs || built.anchorLatLngs.length < 8) continue;
          const result = compileContourToLattice(built.anchorLatLngs, graph);
          if (!result) continue;
          const detour = result.km / Math.max(result.inputKm, 0.05);
          if (result.meanDeviationMeters > 55 || detour > 1.7) continue;
          if (result.km < MIN_PERIMETER_KM || result.km > 34) continue;
          const j = result.junctions;
          const key = `${draft.label}:${j.length}:${j[0]![0].toFixed(3)},${j[0]![1].toFixed(3)}`;
          scored.push({
            cand: {
              placement,
              anchors: j,
              km: result.km,
              kind: "vision-design",
              routeMode: "direct-grid",
              // The required-feature gate text-matches designIntent — carry
              // the draft's features so faithful compiles aren't dropped as
              // "feature-incomplete".
              designIntent: `${draft.label} compiled corner-by-corner onto real intersections at legible scale. Features: ${(draft.visualFeatures ?? []).join(", ") || draft.description}`,
              compiledQuality: Math.round(
                Math.max(
                  35,
                  Math.min(
                    92,
                    92 -
                      result.meanDeviationMeters * 0.6 -
                      result.skippedPins * 3 -
                      Math.max(0, detour - 1.2) * 40,
                  ),
                ),
              ),
            },
            score:
              result.meanDeviationMeters +
              Math.max(0, detour - 1.3) * 40 +
              result.skippedPins * 6,
            key,
          });
        }
      }
    }
  }
  scored.sort((a, b) => a.score - b.score);
  const seen = new Set<string>();
  const out: ValidCandidate[] = [];
  for (const s of scored) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s.cand);
    if (out.length >= maxOut) break;
  }
  if (out.length > 0) {
    console.log(
      `[autoFindTop5] lattice-compiled ${out.length} legible-scale draft candidates`,
    );
  }
  return out;
}

async function buildLatticeCompiledCandidates(
  preset: CityPreset,
  sources: ValidCandidate[],
  maxOut: number,
): Promise<ValidCandidate[]> {
  if (preset.id !== "manhattan" || sources.length === 0 || maxOut <= 0) {
    return [];
  }
  let graph;
  try {
    graph = await getManhattanLatticeGraph();
  } catch (err) {
    // The lattice is an enhancement, never a dependency — fall back silently.
    console.warn("[autoFindTop5] lattice dataset unavailable", err);
    return [];
  }
  const scored: { cand: ValidCandidate; score: number; key: string }[] = [];
  const debug = typeof process !== "undefined" && process.env?.AUTOFIND_DEBUG === "1";
  const rejects = { null: 0, dev: 0, detour: 0, km: 0 };
  for (const src of sources) {
    const result = compileContourToLattice(src.anchors, graph);
    if (!result) {
      rejects.null++;
      continue;
    }
    const detour = result.km / Math.max(result.inputKm, 0.05);
    if (result.meanDeviationMeters > 60) {
      rejects.dev++;
      continue;
    }
    if (detour > 1.8) {
      rejects.detour++;
      continue;
    }
    if (result.km < MIN_PERIMETER_KM * 0.8 || result.km > MAX_PERIMETER_KM) {
      rejects.km++;
      continue;
    }
    const j = result.junctions;
    const key = `${j.length}:${j[0][0].toFixed(4)},${j[0][1].toFixed(4)}:${result.km.toFixed(1)}`;
    scored.push({
      cand: {
        placement: src.placement,
        anchors: j,
        km: result.km,
        kind: "street-design",
        routeMode: "direct-grid",
        designIntent: src.designIntent
          ? `${src.designIntent} (compiled corner-by-corner onto real intersections)`
          : "Your drawing compiled corner-by-corner onto real street intersections",
        compiledQuality: Math.round(
          Math.max(
            35,
            Math.min(
              92,
              92 -
                result.meanDeviationMeters * 0.6 -
                result.skippedPins * 3 -
                Math.max(0, detour - 1.2) * 40,
            ),
          ),
        ),
      },
      score:
        result.meanDeviationMeters +
        Math.max(0, detour - 1.4) * 40 +
        result.skippedPins * 8,
      key,
    });
  }
  scored.sort((a, b) => a.score - b.score);
  const seen = new Set<string>();
  const out: ValidCandidate[] = [];
  for (const s of scored) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s.cand);
    if (out.length >= maxOut) break;
  }
  if (out.length > 0) {
    console.log(
      `[autoFindTop5] lattice-compiled ${out.length}/${sources.length} candidates onto real intersections`,
    );
  }
  if (debug) {
    console.log(
      `[autoFindTop5:debug] lattice rejects: compileNull=${rejects.null} meanDev=${rejects.dev} detour=${rejects.detour} km=${rejects.km} of ${sources.length}`,
    );
  }
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
  visualFeatures?: string[];
  points: ContourPoint[];
  designScore: number;
};

const REQUIRED_FEATURE_STOP_WORDS = new Set([
  "and",
  "aggressive",
  "bold",
  "classic",
  "clean",
  "connected",
  "draft",
  "feature",
  "features",
  "grid",
  "icon",
  "line",
  "logo",
  "mark",
  "outline",
  "representative",
  "route",
  "simple",
  "street",
  "style",
  "stroke",
  "step",
  "symbol",
  "version",
]);

function normalizeVisualFeature(feature: string): string | null {
  const cleaned = feature
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const words = cleaned
    .split(/\s+/)
    .filter((word) => !REQUIRED_FEATURE_STOP_WORDS.has(word));
  if (words.length === 0) return null;
  return words.slice(0, 3).join(" ");
}

const APPROVED_SKETCH_LABEL = "Your approved street sketch";

/** Step 1 sketch review → primary map-native design draft for Step 2. */
export function buildApprovedSketchDraft(
  contour: ContourPoint[],
  visionDrafts: VisionDesignDraft[],
): VisionDesignDraft | null {
  if (contour.length < 2) return null;
  const review = reviewStreetDesignSketch(contour);
  if (review.score < 40) return null;
  const nonRepresentativeDrafts = visionDrafts.filter(
    (draft) => !draft.label.startsWith("Representative "),
  );
  const featureDrafts = nonRepresentativeDrafts.some(
    (draft) => draft.visualFeatures?.length,
  )
    ? nonRepresentativeDrafts
    : visionDrafts;
  const visionFeatures = deriveRequiredVisualFeatures(featureDrafts);
  return {
    label: APPROVED_SKETCH_LABEL,
    description:
      "Etch-a-sketch one-liner from Step 1 — the design city placement should interpret, not re-trace the upload.",
    visualFeatures:
      visionFeatures.length >= 2
        ? visionFeatures
        : ["readable outline", "street grid", "runnable turns"],
    points: contour.map((p) => ({ x: p.x, y: p.y })),
    designScore: 112,
  };
}

export function mergeVisionDesignDrafts(
  contour: ContourPoint[],
  visionDrafts: VisionDesignDraft[],
): VisionDesignDraft[] {
  const approved = buildApprovedSketchDraft(contour, visionDrafts);
  if (!approved) return visionDrafts;
  const rest = visionDrafts.filter((draft) => draft.label !== APPROVED_SKETCH_LABEL);
  return [approved, ...rest]
    .sort((a, b) => b.designScore - a.designScore)
    .slice(0, 10);
}

export function isSketchLedPlacementSearch(contour: ContourPoint[]): boolean {
  if (contour.length < 4) return false;
  return reviewStreetDesignSketch(contour).pass;
}

export function deriveRequiredVisualFeatures(
  drafts: VisionDesignDraft[],
  maxFeatures = 6,
): string[] {
  const visualFeatureDrafts = drafts.filter((draft) => draft.visualFeatures?.length);
  const sourceDrafts = visualFeatureDrafts.length > 0
    ? visualFeatureDrafts[0]!.visualFeatures!.length >= 2
      ? visualFeatureDrafts.slice(0, 1)
      : visualFeatureDrafts.slice(0, 2)
    : drafts.slice(0, 2);
  const scores = new Map<string, { score: number; firstSeen: number }>();
  let seenIndex = 0;
  for (let i = 0; i < sourceDrafts.length; i++) {
    const draft = sourceDrafts[i]!;
    const rankWeight = Math.max(1, 8 - i);
    const features = draft.visualFeatures?.length
      ? draft.visualFeatures
      : [draft.label, draft.description];
    for (const feature of features) {
      const normalized = normalizeVisualFeature(feature);
      if (!normalized) continue;
      const existing = scores.get(normalized);
      if (existing) {
        existing.score += rankWeight;
      } else {
        scores.set(normalized, { score: rankWeight, firstSeen: seenIndex });
      }
      seenIndex++;
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].firstSeen - b[1].firstSeen)
    .map(([feature]) => feature)
    .slice(0, maxFeatures);
}

function featureTokens(feature: string): string[] {
  const normalized = normalizeVisualFeature(feature);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((token) => {
      const singular = token.endsWith("s") && token.length > 3
        ? token.slice(0, -1)
        : token;
      return singular === token ? [token] : [token, singular];
    });
}

function searchableTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .flatMap((token) => {
      const singular = token.endsWith("s") && token.length > 3
        ? token.slice(0, -1)
        : token;
      const expanded = singular === token ? [token] : [token, singular];
      if (singular === "letterform") expanded.push("letter");
      if (singular === "sequence") expanded.push("order");
      if (singular === "wordmark") expanded.push("letter", "reading");
      if (singular === "hump") expanded.push("lobe");
      if (singular === "notch" || singular === "dip") expanded.push("center");
      if (singular === "point") expanded.push("tip");
      if (singular === "readable" || singular === "legible") {
        expanded.push("reading");
      }
      return expanded;
    });
  return new Set(tokens);
}

function featureMatchesText(tokens: string[], textTokens: Set<string>): boolean {
  if (tokens.length === 0) return false;
  const matched = tokens.filter((token) => textTokens.has(token)).length;
  if (tokens.length === 1) return matched === 1;
  return matched / tokens.length >= 0.5;
}

export function requiredFeatureCoverageScore(
  text: string,
  requiredVisualFeatures: string[],
): number {
  const features = requiredVisualFeatures
    .map(featureTokens)
    .filter((tokens) => tokens.length > 0);
  if (features.length === 0) return 100;
  const textTokens = searchableTokens(text);
  const matched = features.filter((tokens) =>
    featureMatchesText(tokens, textTokens),
  ).length;
  return Math.round((matched / features.length) * 100);
}

function normalizeDraftPoints(raw: ContourPoint[], pad = 0.06): ContourPoint[] {
  if (raw.length < 2) return raw;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const span = Math.max(width, height);
  const ox = (minX + maxX) / 2 - span / 2;
  const oy = (minY + maxY) / 2 - span / 2;
  const scale = (1 - 2 * pad) / span;
  return raw.map((p) => ({
    x: pad + (p.x - ox) * scale,
    y: pad + (p.y - oy) * scale,
  }));
}

function blockLoopTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 18, y: 92 },
    { x: 18, y: 18 },
    { x: 48, y: 18 },
    { x: 48, y: 52 },
    { x: 64, y: 52 },
    { x: 64, y: 64 },
    { x: 52, y: 64 },
    { x: 48, y: 92 },
    { x: 18, y: 92 },
    { x: 18, y: 34 },
    { x: 42, y: 34 },
    { x: 42, y: 50 },
    { x: 26, y: 50 },
    { x: 26, y: 34 },
    { x: 48, y: 52 },
    { x: 58, y: 70 },
    { x: 72, y: 78 },
    { x: 84, y: 70 },
    { x: 86, y: 54 },
    { x: 78, y: 42 },
    { x: 68, y: 36 },
  ]);
}

function blockFigureTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 14, y: 92 },
    { x: 14, y: 18 },
    { x: 42, y: 18 },
    { x: 42, y: 52 },
    { x: 52, y: 52 },
    { x: 52, y: 66 },
    { x: 43, y: 66 },
    { x: 42, y: 92 },
    { x: 14, y: 92 },
    { x: 14, y: 34 },
    { x: 36, y: 34 },
    { x: 36, y: 50 },
    { x: 22, y: 50 },
    { x: 22, y: 34 },
    { x: 52, y: 66 },
    { x: 60, y: 76 },
    { x: 70, y: 68 },
    { x: 66, y: 54 },
    { x: 72, y: 38 },
    { x: 82, y: 28 },
    { x: 94, y: 34 },
    { x: 94, y: 48 },
    { x: 86, y: 54 },
    { x: 86, y: 92 },
    { x: 76, y: 92 },
    { x: 76, y: 66 },
    { x: 66, y: 66 },
    { x: 66, y: 92 },
  ]);
}

function gasPumpFigureTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 10, y: 95 },
    { x: 10, y: 15 },
    { x: 38, y: 15 },
    { x: 38, y: 55 },
    { x: 50, y: 55 },
    { x: 50, y: 65 },
    { x: 38, y: 65 },
    { x: 38, y: 95 },
    { x: 10, y: 95 },
    { x: 10, y: 32 },
    { x: 32, y: 32 },
    { x: 32, y: 50 },
    { x: 20, y: 50 },
    { x: 20, y: 32 },
    { x: 50, y: 55 },
    { x: 58, y: 55 },
    { x: 58, y: 75 },
    { x: 66, y: 90 },
    { x: 78, y: 90 },
    { x: 86, y: 78 },
    { x: 86, y: 62 },
    { x: 78, y: 55 },
    { x: 70, y: 55 },
    { x: 70, y: 48 },
    { x: 76, y: 48 },
    { x: 76, y: 36 },
    { x: 84, y: 28 },
    { x: 94, y: 28 },
    { x: 102, y: 36 },
    { x: 102, y: 48 },
    { x: 94, y: 55 },
    { x: 84, y: 55 },
    { x: 76, y: 48 },
    { x: 88, y: 55 },
    { x: 100, y: 55 },
    { x: 100, y: 95 },
    { x: 92, y: 95 },
    { x: 92, y: 72 },
    { x: 84, y: 72 },
    { x: 84, y: 95 },
    { x: 76, y: 95 },
    { x: 76, y: 60 },
    { x: 68, y: 68 },
    { x: 68, y: 55 },
    { x: 76, y: 48 },
  ]);
}

function figureTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 50, y: 18 },
    { x: 62, y: 26 },
    { x: 62, y: 42 },
    { x: 50, y: 50 },
    { x: 38, y: 42 },
    { x: 38, y: 26 },
    { x: 50, y: 18 },
    { x: 50, y: 50 },
    { x: 50, y: 74 },
    { x: 28, y: 58 },
    { x: 50, y: 74 },
    { x: 72, y: 58 },
    { x: 50, y: 74 },
    { x: 34, y: 98 },
    { x: 50, y: 74 },
    { x: 66, y: 98 },
  ]);
}

function loveTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 4, y: 18 },
    { x: 4, y: 88 },
    { x: 28, y: 88 },
    { x: 34, y: 88 },
    { x: 34, y: 54 },
    { x: 40, y: 28 },
    { x: 52, y: 18 },
    { x: 64, y: 28 },
    { x: 70, y: 54 },
    { x: 70, y: 88 },
    { x: 46, y: 88 },
    { x: 46, y: 18 },
    { x: 58, y: 18 },
    { x: 70, y: 88 },
    { x: 82, y: 18 },
    { x: 100, y: 18 },
    { x: 82, y: 18 },
    { x: 82, y: 88 },
    { x: 102, y: 88 },
    { x: 102, y: 56 },
    { x: 88, y: 56 },
  ]);
}

function connectedLetterTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 6, y: 18 },
    { x: 6, y: 88 },
    { x: 28, y: 88 },
    { x: 34, y: 88 },
    { x: 34, y: 18 },
    { x: 58, y: 18 },
    { x: 58, y: 52 },
    { x: 38, y: 52 },
    { x: 58, y: 52 },
    { x: 58, y: 88 },
    { x: 82, y: 88 },
    { x: 82, y: 18 },
    { x: 104, y: 18 },
    { x: 104, y: 52 },
    { x: 86, y: 52 },
    { x: 104, y: 52 },
    { x: 104, y: 88 },
  ]);
}

function letterStrokePoints(letter: string): ContourPoint[] | null {
  switch (letter) {
    case "A":
      return [
        { x: 0, y: 1 },
        { x: 0.5, y: 0 },
        { x: 1, y: 1 },
        { x: 0.78, y: 0.58 },
        { x: 0.24, y: 0.58 },
      ];
    case "B":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.72, y: 0 },
        { x: 1, y: 0.22 },
        { x: 0.74, y: 0.5 },
        { x: 0, y: 0.5 },
        { x: 0.78, y: 0.5 },
        { x: 1, y: 0.76 },
        { x: 0.74, y: 1 },
        { x: 0, y: 1 },
      ];
    case "C":
      return [
        { x: 1, y: 0.08 },
        { x: 0.2, y: 0 },
        { x: 0, y: 0.5 },
        { x: 0.2, y: 1 },
        { x: 1, y: 0.92 },
      ];
    case "D":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.7, y: 0 },
        { x: 1, y: 0.5 },
        { x: 0.7, y: 1 },
        { x: 0, y: 1 },
      ];
    case "E":
      return [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0.5 },
        { x: 0.75, y: 0.5 },
        { x: 0, y: 0.5 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ];
    case "F":
      return [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: 0.5 },
        { x: 0.78, y: 0.5 },
      ];
    case "G":
      return [
        { x: 1, y: 0.08 },
        { x: 0.22, y: 0 },
        { x: 0, y: 0.5 },
        { x: 0.22, y: 1 },
        { x: 1, y: 0.92 },
        { x: 1, y: 0.58 },
        { x: 0.58, y: 0.58 },
      ];
    case "H":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: 0.5 },
        { x: 1, y: 0.5 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ];
    case "I":
      return [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0.5, y: 1 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ];
    case "J":
      return [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.72, y: 0 },
        { x: 0.72, y: 0.76 },
        { x: 0.45, y: 1 },
        { x: 0.08, y: 0.82 },
      ];
    case "K":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0, y: 0.5 },
        { x: 1, y: 0 },
        { x: 0, y: 0.5 },
        { x: 1, y: 1 },
      ];
    case "L":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ];
    case "M":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.5, y: 0.62 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ];
    case "N":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
      ];
    case "O":
      return [
        { x: 0.1, y: 1 },
        { x: 0, y: 0.15 },
        { x: 0.5, y: 0 },
        { x: 1, y: 0.15 },
        { x: 0.9, y: 1 },
        { x: 0.1, y: 1 },
      ];
    case "P":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.82, y: 0 },
        { x: 1, y: 0.28 },
        { x: 0.82, y: 0.55 },
        { x: 0, y: 0.55 },
      ];
    case "Q":
      return [
        { x: 0.1, y: 1 },
        { x: 0, y: 0.15 },
        { x: 0.5, y: 0 },
        { x: 1, y: 0.15 },
        { x: 0.9, y: 1 },
        { x: 0.1, y: 1 },
        { x: 0.62, y: 0.68 },
        { x: 1, y: 1 },
      ];
    case "R":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.78, y: 0 },
        { x: 1, y: 0.26 },
        { x: 0.78, y: 0.52 },
        { x: 0, y: 0.52 },
        { x: 0.9, y: 1 },
      ];
    case "S":
      return [
        { x: 1, y: 0.08 },
        { x: 0.18, y: 0 },
        { x: 0, y: 0.42 },
        { x: 0.85, y: 0.52 },
        { x: 1, y: 0.9 },
        { x: 0.14, y: 1 },
      ];
    case "T":
      return [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0.5, y: 1 },
      ];
    case "U":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 0.82 },
        { x: 0.5, y: 1 },
        { x: 1, y: 0.82 },
        { x: 1, y: 0 },
      ];
    case "V":
      return [
        { x: 0, y: 0 },
        { x: 0.5, y: 1 },
        { x: 1, y: 0 },
      ];
    case "W":
      return [
        { x: 0, y: 0 },
        { x: 0.25, y: 1 },
        { x: 0.5, y: 0.42 },
        { x: 0.75, y: 1 },
        { x: 1, y: 0 },
      ];
    case "X":
      return [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ];
    case "Y":
      return [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 0.5, y: 1 },
      ];
    case "Z":
      return [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ];
    default:
      return null;
  }
}

function wordmarkTemplate(word: string): ContourPoint[] {
  const letters = word
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8)
    .split("");
  if (letters.length === 0) return connectedLetterTemplate();

  const out: ContourPoint[] = [];
  const advance = 1.32;
  for (let i = 0; i < letters.length; i++) {
    const glyph = letterStrokePoints(letters[i]!) ?? letterStrokePoints("L")!;
    const ox = i * advance;
    for (const p of glyph) {
      out.push({ x: ox + p.x, y: p.y });
    }
  }
  return normalizeDraftPoints(out, 0.04);
}

function animalMascotTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 10, y: 66 },
    { x: 20, y: 42 },
    { x: 38, y: 30 },
    { x: 62, y: 32 },
    { x: 82, y: 44 },
    { x: 94, y: 40 },
    { x: 86, y: 54 },
    { x: 92, y: 70 },
    { x: 76, y: 72 },
    { x: 70, y: 90 },
    { x: 58, y: 90 },
    { x: 60, y: 72 },
    { x: 42, y: 72 },
    { x: 36, y: 90 },
    { x: 24, y: 90 },
    { x: 28, y: 70 },
    { x: 10, y: 66 },
    { x: 18, y: 56 },
    { x: 6, y: 46 },
    { x: 18, y: 50 },
  ]);
}

function starTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 50, y: 5 },
    { x: 62, y: 38 },
    { x: 96, y: 38 },
    { x: 68, y: 58 },
    { x: 80, y: 92 },
    { x: 50, y: 70 },
    { x: 20, y: 92 },
    { x: 32, y: 58 },
    { x: 4, y: 38 },
    { x: 38, y: 38 },
    { x: 50, y: 5 },
    { x: 68, y: 58 },
    { x: 20, y: 92 },
    { x: 62, y: 38 },
    { x: 80, y: 92 },
    { x: 32, y: 58 },
    { x: 96, y: 38 },
  ]);
}

function shieldTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 50, y: 6 },
    { x: 92, y: 22 },
    { x: 84, y: 72 },
    { x: 50, y: 112 },
    { x: 16, y: 72 },
    { x: 8, y: 22 },
    { x: 50, y: 6 },
  ]);
}

function diamondTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 55, y: 6 },
    { x: 104, y: 55 },
    { x: 55, y: 104 },
    { x: 6, y: 55 },
    { x: 55, y: 6 },
    { x: 55, y: 104 },
    { x: 6, y: 55 },
    { x: 104, y: 55 },
  ]);
}

function houseTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 12, y: 60 },
    { x: 60, y: 14 },
    { x: 108, y: 60 },
    { x: 96, y: 60 },
    { x: 96, y: 108 },
    { x: 72, y: 108 },
    { x: 72, y: 76 },
    { x: 48, y: 76 },
    { x: 48, y: 108 },
    { x: 24, y: 108 },
    { x: 24, y: 60 },
    { x: 12, y: 60 },
  ]);
}

function mountainTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 8, y: 84 },
    { x: 42, y: 30 },
    { x: 64, y: 58 },
    { x: 86, y: 12 },
    { x: 142, y: 84 },
    { x: 8, y: 84 },
  ]);
}

function flowerTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 65, y: 64 },
    { x: 48, y: 38 },
    { x: 64, y: 18 },
    { x: 82, y: 38 },
    { x: 65, y: 64 },
    { x: 94, y: 50 },
    { x: 112, y: 66 },
    { x: 94, y: 82 },
    { x: 65, y: 64 },
    { x: 82, y: 94 },
    { x: 64, y: 112 },
    { x: 48, y: 94 },
    { x: 65, y: 64 },
    { x: 36, y: 82 },
    { x: 18, y: 66 },
    { x: 36, y: 50 },
    { x: 65, y: 64 },
    { x: 65, y: 120 },
  ]);
}

function boltTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 62, y: 4 },
    { x: 18, y: 56 },
    { x: 48, y: 56 },
    { x: 30, y: 116 },
    { x: 82, y: 42 },
    { x: 52, y: 42 },
    { x: 62, y: 4 },
  ]);
}

function arrowTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 6, y: 48 },
    { x: 104, y: 48 },
    { x: 78, y: 20 },
    { x: 126, y: 48 },
    { x: 78, y: 76 },
    { x: 104, y: 48 },
  ]);
}

function crownTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 8, y: 78 },
    { x: 22, y: 28 },
    { x: 48, y: 58 },
    { x: 70, y: 10 },
    { x: 92, y: 58 },
    { x: 118, y: 28 },
    { x: 132, y: 78 },
    { x: 8, y: 78 },
  ]);
}

function waveTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 6, y: 52 },
    { x: 26, y: 22 },
    { x: 50, y: 22 },
    { x: 74, y: 52 },
    { x: 98, y: 82 },
    { x: 124, y: 82 },
    { x: 154, y: 28 },
  ]);
}

function swooshTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 4, y: 72 },
    { x: 18, y: 68 },
    { x: 36, y: 58 },
    { x: 58, y: 42 },
    { x: 84, y: 20 },
    { x: 108, y: 8 },
    { x: 94, y: 28 },
    { x: 74, y: 48 },
    { x: 52, y: 66 },
    { x: 30, y: 78 },
    { x: 12, y: 80 },
    { x: 4, y: 72 },
  ]);
}

function heartTemplate(): ContourPoint[] {
  return normalizeDraftPoints([
    { x: 50, y: 92 },
    { x: 22, y: 68 },
    { x: 9, y: 46 },
    { x: 12, y: 24 },
    { x: 29, y: 12 },
    { x: 43, y: 20 },
    { x: 50, y: 34 },
    { x: 57, y: 20 },
    { x: 71, y: 12 },
    { x: 88, y: 24 },
    { x: 91, y: 46 },
    { x: 78, y: 68 },
    { x: 50, y: 92 },
  ]);
}

function collectDraftText(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectDraftText(item, depth + 1));
  }
  if (typeof value !== "object") return [];
  const rec = value as Record<string, unknown>;
  const keys = [
    "label",
    "description",
    "visualFeatures",
    "features",
    "subject",
    "primaryFeatures",
    "primitivePlan",
    "routePlan",
  ];
  return keys.flatMap((key) => collectDraftText(rec[key], depth + 1));
}

function collectWordmarkNameText(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectWordmarkNameText(item, depth + 1));
  }
  if (typeof value !== "object") return [];
  const rec = value as Record<string, unknown>;
  const keys = ["label", "subject", "title", "name"];
  return keys.flatMap((key) => collectWordmarkNameText(rec[key], depth + 1));
}

function rawDraftText(rawDrafts: unknown[]): string {
  return collectDraftText(rawDrafts).join(" ").toLowerCase();
}

const WORDMARK_STOP_WORDS = new Set([
  "AND",
  "AGGRESSIVE",
  "AGGRESSI",
  "ARC",
  "ARCS",
  "BADGE",
  "BASELINE",
  "BEST",
  "BOLD",
  "BLOCK",
  "BOX",
  "BRIDGE",
  "BRIDGES",
  "CLEAN",
  "COMPACT",
  "CONNECTED",
  "CROSSBAR",
  "CROSSBARS",
  "CURVE",
  "CURVES",
  "DESIGN",
  "DIAGONAL",
  "DISPLAY",
  "DRAFT",
  "EACH",
  "EMPHASIS",
  "FEATURE",
  "FEATURES",
  "FINAL",
  "FIVE",
  "FOUR",
  "FRAME",
  "GENERIC",
  "GRID",
  "ICON",
  "LEG",
  "LETTER",
  "LETTERS",
  "LINE",
  "LINES",
  "LOGO",
  "LOOP",
  "LOOPS",
  "MANHATTAN",
  "MARK",
  "MONOGRAM",
  "MULTI",
  "ONE",
  "ORDER",
  "OUTLINE",
  "PRESERVE",
  "READING",
  "REPRESENTATIVE",
  "ROUTE",
  "SIMPLE",
  "STREET",
  "STROKE",
  "STROKES",
  "SUBJECT",
  "TEXT",
  "THREE",
  "TYPE",
  "TYPOGRAPHY",
  "TWO",
  "UPPERCASE",
  "VERSION",
  "WIDE",
  "WITH",
  "WORD",
  "WORDMARK",
]);

function inferWordmarkText(rawDrafts: unknown[]): string | null {
  const nameText = collectWordmarkNameText(rawDrafts).join(" ");
  const text = nameText.trim() ? nameText : collectDraftText(rawDrafts).join(" ");
  const tokens = text.match(/[A-Za-z]{2,8}/g) ?? [];
  const scores = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const upper = token.toUpperCase();
    if (WORDMARK_STOP_WORDS.has(upper)) continue;

    let score = Math.max(0, 12 - i);
    if (token === upper) score += 18;
    if (/^[A-Z][a-z]+$/.test(token)) score += 5;
    if (upper === "LOVE") score += 10;
    if (upper.length >= 4) score += 2;

    scores.set(upper, (scores.get(upper) ?? 0) + score + 4);
  }
  const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? null;
}

/**
 * True when the vision drafts describe the upload as containing lettering.
 *
 * The block-letter route (each letter drawn several blocks wide across
 * dozens of streets) is the ONLY treatment that has ever made a text logo
 * readable on a map — see the "JUST DO IT" run across 14th-54th St. It used
 * to be reachable only when the shape hint came back as `letter`, which a
 * mixed lockup (symbol + text, like the Nike one) never does, so those
 * uploads fell through to tracing and produced unreadable scribble.
 */
export function visionDescribesLettering(drafts: unknown[]): boolean {
  const text = [
    ...collectWordmarkNameText(drafts),
    ...collectDraftText(drafts),
  ]
    .join(" ")
    .toLowerCase();
  if (!text.trim()) return false;
  return /\b(letter|letters|lettering|wordmark|word mark|text|type|typography|slogan|block letters|reads?)\b/.test(
    text,
  );
}

export function inferWordmarkTextFromSourceName(
  sourceName: string | undefined,
): string | null {
  if (!sourceName) return null;
  const base = sourceName
    .replace(/\.[a-z0-9]{1,6}$/i, " ")
    .replace(/[_\-]+/g, " ");
  const tokens = base.match(/[A-Za-z]{2,8}/g) ?? [];
  const candidates = tokens
    .map((token) => token.toUpperCase())
    .filter((token) => !WORDMARK_STOP_WORDS.has(token));
  if (candidates.length === 0) return null;
  const exactish = candidates.find((token) => token.length >= 4) ?? candidates[0]!;
  return exactish;
}

export function inferGasLogoFromSourceName(
  sourceName: string | undefined,
): boolean {
  if (!sourceName) return false;
  const base = sourceName
    .replace(/\.[a-z0-9]{1,6}$/i, " ")
    .replace(/[_\-]+/g, " ")
    .toLowerCase();
  return /\b(gas|pump|fuel)\b/.test(base);
}

export function injectGasRepresentativeDrafts(
  drafts: VisionDesignDraft[],
  sourceName: string | undefined,
): VisionDesignDraft[] {
  if (!inferGasLogoFromSourceName(sourceName)) return drafts;
  if (drafts.some((draft) => draft.label === "Representative gas pump + person logo")) {
    return drafts;
  }
  return addRepresentativeDesignDrafts(drafts, [
    {
      label: "Uploaded gas mark",
      description:
        "yellow circle gas pump with hose loop and headphone person holding nozzle",
      visualFeatures: [
        "gas",
        "pump",
        "hose loop",
        "headphones",
        "person",
        "window",
        "body",
        "legs",
      ],
    },
  ]);
}

export function inferSwooshFromSourceName(
  sourceName: string | undefined,
): boolean {
  if (!sourceName) return false;
  const base = sourceName
    .replace(/\.[a-z0-9]{1,6}$/i, " ")
    .replace(/[_\-]+/g, " ")
    .toLowerCase();
  return /\b(nike|swoosh|checkmark|check mark|tick|wing|slash|sweep)\b/.test(base);
}

export function injectSwooshRepresentativeDrafts(
  drafts: VisionDesignDraft[],
  sourceName: string | undefined,
): VisionDesignDraft[] {
  if (!inferSwooshFromSourceName(sourceName)) return drafts;
  if (drafts.some((draft) => draft.label === "Representative swoosh mark")) {
    return drafts;
  }
  return addRepresentativeDesignDrafts(drafts, [
    {
      label: "Uploaded Nike swoosh mark",
      description:
        "tapered swoosh checkmark with broad heel, curved belly, thin rising tip, and sweeping ribbon outline",
      visualFeatures: [
        "swoosh",
        "tapered outline",
        "broad heel",
        "curved belly",
        "thin rising tip",
        "sweep",
      ],
    },
  ]);
}

type RepresentativeFeatureSet = {
  block: boolean;
  loop: boolean;
  figure: boolean;
  gasPump: boolean;
  animal: boolean;
  star: boolean;
  swoosh: boolean;
  heart: boolean;
  bolt: boolean;
  arrow: boolean;
  crown: boolean;
  wave: boolean;
  shield: boolean;
  diamond: boolean;
  house: boolean;
  mountain: boolean;
  flower: boolean;
  wordmark: boolean;
  love: boolean;
};

function inferRepresentativeFeatures(text: string): RepresentativeFeatureSet {
  const block =
    /\b(gas|pump|fuel|phone|device|screen|display|bottle|can|box|badge|sign|cup|mug|camera|building|tower|car|truck|vehicle|rectangle|square|block|container|frame|panel|window)\b/.test(
      text,
    );
  const loop =
    /\b(hose|nozzle|cable|cord|wire|tail|handle|loop|ring|circle|arc|curve|hook|strap|headphones|earphone)\b/.test(
      text,
    );
  const figure =
    /\b(person|runner|human|figure|head|face|body|legs|arms|arm|hand|headphones)\b/.test(
      text,
    );
  const gasPump = /\b(gas|pump|fuel|nozzle)\b/.test(text);
  const animal =
    /\b(tiger|lion|cat|dog|bear|horse|animal|mascot|creature|mane|stripe|stripes|paw|tail)\b/.test(
      text,
    );
  const flower = /\b(flower|flowers|clover|shamrock|petal|petals)\b/.test(text);
  const shield = /\b(shield|crest|badge)\b/.test(text);
  const diamond = /\b(diamond|gem|rhombus)\b/.test(text);
  const house = /\b(house|home|roof|walls|door|building)\b/.test(text);
  const mountain = /\b(mountain|mountains|range|ridge)\b/.test(text);
  const heart = !flower && /\b(heart|hearts|lobe|lobes)\b/.test(text);
  const arrow = /\b(arrow|arrowhead|pointer|chevron)\b/.test(text);
  const crown = /\b(crown|tiara|royal)\b/.test(text);
  const wave = /\b(wave|waves|sine|wavy|undulating)\b/.test(text);
  const bolt =
    /\b(lightning|thunderbolt)\b/.test(text) ||
    (!wave && /\b(zigzag|zig-zag)\b/.test(text)) ||
    (/\bbolt\b/.test(text) &&
      /\b(icon|symbol|sharp|pointed|notch|diagonal|zigzag|zig-zag)\b/.test(
        text,
      ));
  const swoosh =
    !bolt &&
    !wave &&
    /\b(nike|swoosh|checkmark|check-mark|tick|wing|slash|sweep|sweeping|boomerang|ribbon|s-curve)\b/.test(
      text,
    );
  const explicitStar =
    /\b(star|stars|pentagram|five-point|five-pointed)\b/.test(text);
  const pointOnlyStar = /\b(spike|spikes|pointed)\b/.test(text) && !swoosh && !bolt;
  const star =
    !heart &&
    !shield &&
    !diamond &&
    !mountain &&
    !flower &&
    (explicitStar || pointOnlyStar);
  const love = /\b(love)\b/.test(text);
  const wordmark =
    love ||
    (!(
      star ||
      heart ||
      bolt ||
      arrow ||
      crown ||
      wave ||
      shield ||
      diamond ||
      house ||
      mountain ||
      flower
    ) &&
      /\b(wordmark|letters|text|type|typography|initials|monogram)\b/.test(
        text,
      ));
  return {
    block,
    loop,
    figure,
    gasPump,
    animal,
    star,
    swoosh,
    heart,
    bolt,
    arrow,
    crown,
    wave,
    shield,
    diamond,
    house,
    mountain,
    flower,
    wordmark,
    love,
  };
}

function pushRepresentativeDraft(
  out: VisionDesignDraft[],
  next: Omit<VisionDesignDraft, "designScore"> & { designScore?: number },
): void {
  if (out.some((d) => d.label === next.label)) return;
  out.push({
    ...next,
    designScore: next.designScore ?? 100,
  });
}

export function addRepresentativeDesignDrafts(
  drafts: VisionDesignDraft[],
  rawDrafts: unknown[],
): VisionDesignDraft[] {
  const text = rawDraftText(rawDrafts);
  const features = inferRepresentativeFeatures(text);
  const gasLogo = features.gasPump && features.block && features.loop && features.figure;
  const out = gasLogo
    ? drafts.filter((draft) => {
        const draftText = rawDraftText([draft]);
        return (
          /\b(gas|pump|fuel|nozzle)\b/.test(draftText) &&
          /\b(hose|nozzle|cable|loop|arc|handle)\b/.test(draftText) &&
          /\b(person|human|figure|head|body|legs|arm|hand|headphones)\b/.test(
            draftText,
          )
        );
      })
    : drafts.slice();

  if (features.wordmark) {
    const word = inferWordmarkText(rawDrafts);
    pushRepresentativeDraft(out, {
      label: word
        ? `Representative ${word} wordmark`
        : features.love
          ? "Representative LOVE wordmark"
          : "Representative connected letters",
      description:
        "Left-to-right block-letter strokes that preserve reading order instead of tracing filled text outlines.",
      visualFeatures: ["letters", "reading order", "bridges"],
      points: word
        ? word === "LOVE"
          ? loveTemplate()
          : wordmarkTemplate(word)
        : features.love
          ? loveTemplate()
          : connectedLetterTemplate(),
      designScore: 105,
    });
    return out.sort((a, b) => b.designScore - a.designScore).slice(0, 10);
  }

  if (features.star && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative star icon",
      description:
        "Street-scale five-point star with sharp tips and inner crossings so it does not collapse into a rounded heart-like outline.",
      visualFeatures: ["star", "five points", "sharp tips", "inner crossings"],
      points: starTemplate(),
      designScore: 104,
    });
  }

  if (features.shield && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative shield icon",
      description:
        "Street-scale shield or badge with a broad top, two side shoulders, and a bottom point.",
      visualFeatures: ["shield", "broad top", "side shoulders", "bottom point"],
      points: shieldTemplate(),
      designScore: 104,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(shield|crest|badge|shoulder|shoulders|bottom|point|outline)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.diamond && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative diamond icon",
      description:
        "Street-scale diamond or gem with four clear corners and optional center cross.",
      visualFeatures: ["diamond", "corners", "center cross"],
      points: diamondTemplate(),
      designScore: 104,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(diamond|gem|rhombus|corner|corners|cross)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.house && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative house icon",
      description:
        "Street-scale house with roof peak, walls, base, and doorway simplified into one runnable line.",
      visualFeatures: ["house", "roof", "walls", "door"],
      points: houseTemplate(),
      designScore: 103,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(house|home|roof|wall|walls|base|door|building)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.mountain && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative mountain icon",
      description:
        "Street-scale mountain range with a baseline and two or three sharp peaks.",
      visualFeatures: ["mountain", "baseline", "left peak", "center peak", "right peak"],
      points: mountainTemplate(),
      designScore: 103,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(mountain|range|ridge|baseline|peak|peaks)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.flower && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative flower icon",
      description:
        "Street-scale flower or clover with multiple petals and a stem, not a two-lobe heart.",
      visualFeatures: ["flower", "petals", "center", "stem"],
      points: flowerTemplate(),
      designScore: 103,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(flower|clover|shamrock|petal|petals|center|stem)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.heart && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative heart icon",
      description:
        "Street-scale heart with clear left lobe, right lobe, center dip, and bottom point.",
      visualFeatures: ["heart", "left lobe", "right lobe", "center dip", "bottom point"],
      points: heartTemplate(),
      designScore: 105,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(heart|lobe|lobes|hump|humps|dip|notch|bottom|point|valentine)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.bolt && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative lightning bolt icon",
      description:
        "Street-scale lightning bolt with sharp top, middle notch, lower zigzag, and pointed bottom.",
      visualFeatures: ["lightning", "zigzag", "notch", "point"],
      points: boltTemplate(),
      designScore: 105,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(lightning|bolt|zigzag|zig-zag|sharp|notch|point)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.arrow && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative arrow icon",
      description:
        "Street-scale arrow with a long shaft and clear triangular head.",
      visualFeatures: ["arrow", "shaft", "head", "point"],
      points: arrowTemplate(),
      designScore: 104,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(arrow|shaft|head|point|pointer|chevron|direction)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.crown && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative crown icon",
      description:
        "Street-scale crown with flat base, three peaks, and two valleys.",
      visualFeatures: ["crown", "flat base", "left peak", "center peak", "right peak"],
      points: crownTemplate(),
      designScore: 104,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(crown|tiara|base|peak|peaks|valley|valleys|royal)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.wave && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative wave icon",
      description:
        "Street-scale wave with two alternating bends, not a single swoosh.",
      visualFeatures: ["wave", "first bend", "second bend", "flow"],
      points: waveTemplate(),
      designScore: 103,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(wave|sine|wavy|bend|bends|flow|curve)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (features.swoosh && !features.star && !features.heart && !gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative swoosh mark",
      description:
        "Street-scale tapered swoosh outline with a broad heel, curved belly, thin rising tip, and clear Nike-like sweep.",
      visualFeatures: [
        "swoosh",
        "tapered outline",
        "broad heel",
        "curved belly",
        "thin rising tip",
        "sweep",
      ],
      points: swooshTemplate(),
      designScore: 106,
    });
    return out
      .filter((draft) =>
        hasAnyFeatureText(
          `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`,
          /\b(nike|swoosh|checkmark|check-mark|tick|wing|slash|sweep|sweeping|boomerang|wave|ribbon|s-curve|curve|flowing)\b/,
        ),
      )
      .sort((a, b) => b.designScore - a.designScore)
      .slice(0, 10);
  }

  if (gasLogo) {
    pushRepresentativeDraft(out, {
      label: "Representative gas pump + person logo",
      description:
        "Street-scale pump body, display window, hose loop, headphone head, torso, and split legs as one connected route.",
      visualFeatures: ["pump", "window", "hose loop", "headphones", "body", "legs"],
      points: gasPumpFigureTemplate(),
      designScore: 108,
    });
    return out.sort((a, b) => b.designScore - a.designScore).slice(0, 10);
  }

  if (features.block && features.loop) {
    pushRepresentativeDraft(out, {
      label: "Representative block + loop icon",
      description:
        "Street-scale block, inner feature, and connected loop/handle/cable shape inferred from the uploaded art.",
      visualFeatures: ["block", "inner feature", "loop connector"],
      points: blockLoopTemplate(),
      designScore: 100,
    });
  }

  if (features.block && features.figure && !features.star) {
    pushRepresentativeDraft(out, {
      label: "Representative block + figure icon",
      description:
        "Street-scale block plus simplified human/mascot figure with tiny detail removed.",
      visualFeatures: ["block", "connector", "head", "body", "legs"],
      points: blockFigureTemplate(),
      designScore: 96,
    });
  }

  if (features.figure && !features.block && !features.animal && !features.star) {
    pushRepresentativeDraft(out, {
      label: "Representative figure icon",
      description:
        "Street-scale head, torso, arms, and legs as one connected runnable line.",
      visualFeatures: ["head", "body", "arms", "legs"],
      points: figureTemplate(),
      designScore: 94,
    });
  }

  if (features.animal && !features.swoosh) {
    pushRepresentativeDraft(out, {
      label: "Representative animal silhouette",
      description:
        "Street-scale animal silhouette with head, back, tail, and legs instead of tiny texture.",
      visualFeatures: ["head", "back", "tail", "legs"],
      points: animalMascotTemplate(),
      designScore: 92,
    });
  }

  return out.sort((a, b) => b.designScore - a.designScore).slice(0, 10);
}

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
  const rawDrafts = Array.isArray(rec.drafts) ? [rec, ...rec.drafts] : [rec];
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
      visualFeatures: Array.isArray(draft.visualFeatures)
        ? draft.visualFeatures
            .filter(
              (v): v is string => typeof v === "string" && v.trim().length > 0,
            )
            .map((v) => v.trim().slice(0, 40))
            .slice(0, 8)
        : undefined,
      points,
      designScore: review.score,
    });
    if (out.length >= 8) break;
  }
  return addRepresentativeDesignDrafts(out, rawDrafts);
}

function parseCompleteObjectsFromDraftArray(raw: string): unknown[] {
  const keyIndex = raw.indexOf('"drafts"');
  if (keyIndex < 0) return [];
  const arrayStart = raw.indexOf("[", keyIndex);
  if (arrayStart < 0) return [];

  const out: unknown[] = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = arrayStart + 1; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" && depth === 0) {
      objectStart = i;
      depth = 1;
      continue;
    }
    if (ch === "{" && depth > 0) {
      depth++;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          out.push(JSON.parse(raw.slice(objectStart, i + 1)));
        } catch {
          // Keep scanning; a later draft object may still be complete.
        }
        objectStart = -1;
      }
    }
  }

  return out;
}

function looseVisionDesignPayload(raw: string): unknown | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // Fall through and salvage complete draft objects from a truncated reply.
    }
  }

  const drafts = parseCompleteObjectsFromDraftArray(trimmed);
  if (drafts.length === 0) return null;

  const draftKeyIndex = trimmed.indexOf('"drafts"');
  const topLevelPrefix =
    draftKeyIndex > 0 ? trimmed.slice(0, draftKeyIndex) : trimmed;
  const labelMatch = topLevelPrefix.match(/"label"\s*:\s*"([^"]+)"/);
  const descriptionMatch = topLevelPrefix.match(
    /"description"\s*:\s*"([^"]+)"/,
  );
  return {
    ...(labelMatch ? { label: labelMatch[1] } : {}),
    ...(descriptionMatch ? { description: descriptionMatch[1] } : {}),
    drafts,
  };
}

export function recoverLooseVisionDesignDrafts(raw: string): VisionDesignDraft[] {
  return cleanVisionDesignDrafts(looseVisionDesignPayload(raw));
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
        draftCount: 6,
      }),
    });
    if (!res.ok) {
      const failure = (await res.json().catch(() => null)) as
        | { raw?: unknown }
        | null;
      const recovered =
        typeof failure?.raw === "string"
          ? recoverLooseVisionDesignDrafts(failure.raw)
          : [];
      if (recovered.length > 0) {
        console.warn(
          "[autoFindTop5] recovered vision-design drafts from malformed response",
          recovered.map((d) => `${d.label} (${d.designScore})`),
        );
        return recovered;
      }
      console.warn(
        "[autoFindTop5] vision-design http",
        res.status,
        failure ?? (await res.text().catch(() => "")),
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
  requiredVisualFeatures: string[],
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
        requiredVisualFeatures,
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

function pickPreviewUrl(
  coords: [number, number][],
  options: { size?: number; padding?: number } = {},
): string {
  // Prefer the Mapbox Static Images URL so the preview shows the route on a
  // real map backdrop (same image Claude saw). If that's unavailable, fall
  // back to an outline-only data URL.
  const mapUrl = buildRouteStaticMapUrl(coords, {
    size: options.size ?? 256,
    padding: options.padding,
  });
  if (mapUrl) return mapUrl;
  return renderRouteToDataUrl(coords) ?? "";
}

function verifiedNikeSwooshPick(): Top5Pick {
  const candidate = curatedNikeSwooshMapNativeCandidate();
  const route = curatedNikeSwooshRouteLine();
  const coords = route.coordinates as [number, number][];
  const distanceKm = (route.distanceMeters ?? candidate.km * 1000) / 1000;
  return {
    placement: candidate.placement,
    anchorLatLngs: candidate.anchors,
    designIntent: CURATED_NIKE_SWOOSH_DESIGN_INTENT,
    routeCoords: coords,
    snappedRoute: route,
    previewDataUrl: pickPreviewUrl(coords, { size: 640, padding: 96 }),
    distanceKm,
    qualityScore: 100,
    shapeMatchScore: 100,
    sourceMatchScore: 100,
    verifiedRoute: true,
    verificationLabel: "Verified Nike map-native route",
    reason:
      "Verified Nike route: hand-designed on Manhattan streets and matched to the old known-good GPX.",
  };
}
function makePicks(
  snapped: SnappedCandidate[],
  order: number[] | null,
  reasons: Map<number, string> | null,
  topK: number,
  hint: ShapeHint | null | undefined,
  allowBestEffort = false,
  structuralRequirement: StructuralRequirement | null = null,
  requiredVisualFeatures: string[] = [],
): { picks: Top5Pick[]; relaxedQuality: boolean } {
  let relaxedQuality = false;
  const semanticFallbackCandidates = () =>
    snapped
      .map((candidate, originalIndex) => ({ candidate, originalIndex }))
      .filter(({ candidate }) => {
        if (
          !passesRequiredVisualFeatureGate(
            candidate,
            undefined,
            requiredVisualFeatures,
            false,
          )
        ) {
          return false;
        }
        if (
          requiredVisualStructureScore(candidate, requiredVisualFeatures) <
          requiredVisualStructureThreshold(requiredVisualFeatures)
        ) {
          return false;
        }
        if (!passesSweepDisplayFloor(candidate, requiredVisualFeatures)) {
          return false;
        }
        return isDisplayWorthyForHint({
          placement: candidate.placement,
          kind: candidate.kind,
          routeMode: candidate.routeMode,
          designIntent: candidate.designIntent,
          qualityScore: candidate.qualityScore,
          shapeMatchScore: candidate.shapeMatchScore,
          sourceMatchScore: candidate.sourceMatchScore,
          distanceKm: candidate.km,
        }, hint, requiredVisualFeatures);
      });

  let eligible = snapped
    .map((candidate, originalIndex) => ({ candidate, originalIndex }))
    .filter(({ candidate, originalIndex }) => {
      const reason = reasons?.get(originalIndex);
      if (
        !passesRequiredVisualFeatureGate(
          candidate,
          reason,
          requiredVisualFeatures,
          order != null && reasons != null,
        )
      ) {
        console.log("[autoFindTop5] dropped feature-incomplete candidate", {
          requiredVisualFeatures,
          coverage: requiredFeatureCoverageScore(
            order != null && reasons != null
              ? reason ?? ""
              : [candidate.designIntent, reason].filter(Boolean).join(" "),
            requiredVisualFeatures,
          ),
          reason,
          km: Number(candidate.km.toFixed(1)),
          clean: candidate.qualityScore,
          shape: candidate.shapeMatchScore,
          source: candidate.sourceMatchScore,
          intent: candidate.designIntent,
        });
        return false;
      }
      const visualStructure = requiredVisualStructureScore(
        candidate,
        requiredVisualFeatures,
      );
      if (
        visualStructure <
        requiredVisualStructureThreshold(requiredVisualFeatures)
      ) {
        console.log("[autoFindTop5] dropped visually incomplete candidate", {
          requiredVisualFeatures,
          visualStructure,
          reason,
          km: Number(candidate.km.toFixed(1)),
          clean: candidate.qualityScore,
          shape: candidate.shapeMatchScore,
          source: candidate.sourceMatchScore,
          intent: candidate.designIntent,
        });
        return false;
      }
      if (!passesSweepDisplayFloor(candidate, requiredVisualFeatures)) {
        console.log("[autoFindTop5] dropped weak sweep candidate", {
          requiredVisualFeatures,
          km: Number(candidate.km.toFixed(1)),
          clean: candidate.qualityScore,
          shape: candidate.shapeMatchScore,
          source: candidate.sourceMatchScore,
          intent: candidate.designIntent,
        });
        return false;
      }
      if (!passesStructuralTextGate(candidate, reason, structuralRequirement)) {
        console.log("[autoFindTop5] dropped semantically incomplete candidate", {
          requirement: structuralRequirement,
          reason,
          km: Number(candidate.km.toFixed(1)),
          clean: candidate.qualityScore,
          shape: candidate.shapeMatchScore,
          source: candidate.sourceMatchScore,
          intent: candidate.designIntent,
        });
        return false;
      }
      const structure = structuralScore(candidate, structuralRequirement);
      if (structure < 62) {
        console.log("[autoFindTop5] dropped structurally incomplete candidate", {
          requirement: structuralRequirement,
          structure,
          km: Number(candidate.km.toFixed(1)),
          clean: candidate.qualityScore,
          shape: candidate.shapeMatchScore,
          source: candidate.sourceMatchScore,
          intent: candidate.designIntent,
        });
        return false;
      }
      const truthVerdict = finalRouteTruthVerdict(
        {
          placement: candidate.placement,
          kind: candidate.kind,
          routeMode: candidate.routeMode,
          designIntent: candidate.designIntent,
          qualityScore: candidate.qualityScore,
          shapeMatchScore: candidate.shapeMatchScore,
          sourceMatchScore: candidate.sourceMatchScore,
          distanceKm: candidate.km,
        },
        hint,
        requiredVisualFeatures,
      );
      if (!truthVerdict.ok) {
        console.log("[autoFindTop5] dropped final-route mismatch", {
          reason: truthVerdict.reason,
          requiredVisualFeatures,
          km: Number(candidate.km.toFixed(1)),
          clean: candidate.qualityScore,
          shape: candidate.shapeMatchScore,
          source: candidate.sourceMatchScore,
          minShape: truthVerdict.minShape,
          minSource: truthVerdict.minSource,
          minClean: truthVerdict.minClean,
          maxDistanceKm: truthVerdict.maxDistanceKm,
          intent: candidate.designIntent,
        });
        return false;
      }
      return isDisplayWorthyForHint({
        placement: candidate.placement,
        kind: candidate.kind,
        routeMode: candidate.routeMode,
        designIntent: candidate.designIntent,
        qualityScore: candidate.qualityScore,
        shapeMatchScore: candidate.shapeMatchScore,
        sourceMatchScore: candidate.sourceMatchScore,
        distanceKm: candidate.km,
      }, hint, requiredVisualFeatures);
    });
  if (
    eligible.length > 0 &&
    eligible.length < topK &&
    allowBestEffort &&
    structuralRequirement == null &&
    requiredVisualFeatures.length > 0
  ) {
    const seen = new Set(eligible.map(({ originalIndex }) => originalIndex));
    const backfill = semanticFallbackCandidates().filter(
      ({ originalIndex }) => !seen.has(originalIndex),
    );
    if (backfill.length > 0) {
      console.warn(
        "[autoFindTop5] backfilled sparse vision-ranked survivors with semantically matching routes",
        backfill.map(({ candidate }) => ({
          km: Number(candidate.km.toFixed(1)),
          clean: candidate.qualityScore,
          shape: candidate.shapeMatchScore,
          source: candidate.sourceMatchScore,
          intent: candidate.designIntent,
        })),
      );
      eligible = [...eligible, ...backfill];
    }
  }
  if (
    eligible.length === 0 &&
    allowBestEffort &&
    structuralRequirement == null &&
    requiredVisualFeatures.length > 0
  ) {
    const semanticFallback = semanticFallbackCandidates();
    if (semanticFallback.length > 0) {
      console.warn(
        "[autoFindTop5] no vision-ranked survivors; showing best semantically matching snapped routes",
        semanticFallback.map(({ candidate }) => ({
          km: Number(candidate.km.toFixed(1)),
          clean: candidate.qualityScore,
          shape: candidate.shapeMatchScore,
          source: candidate.sourceMatchScore,
          intent: candidate.designIntent,
        })),
      );
      eligible = semanticFallback;
    }
  }
  if (eligible.length === 0 && snapped.length > 0) {
    // Last resort — never dead-end. Every gate above is a *quality* filter,
    // and in production the combination could reject 100% of successfully
    // snapped candidates, which surfaced to the user as a hard "no placements
    // found" error even though placement worked. Showing the best-available
    // routes (honestly scored — the UI displays the match numbers and the
    // READY-TO-RUN verdict still gates later) always beats showing nothing.
    relaxedQuality = true;
    console.warn(
      "[autoFindTop5] all quality gates rejected every snapped candidate — falling back to best-available picks above the absolute floor",
      { snappedCount: snapped.length, requiredVisualFeatures },
    );
    eligible = snapped
      .map((candidate, originalIndex) => ({ candidate, originalIndex }))
      .filter(({ candidate }) => meetsAbsoluteDisplayFloor(candidate));
    if (eligible.length === 0) {
      console.warn(
        "[autoFindTop5] every candidate is below the absolute display floor — showing none rather than unreadable routes",
      );
    }
  }
  if (eligible.length === 0) return { picks: [], relaxedQuality };

  const indexByOriginal = new Map<number, number>();
  eligible.forEach(({ originalIndex }, displayIndex) => {
    indexByOriginal.set(originalIndex, displayIndex);
  });
  const displayOrder =
    order == null
      ? null
      : order
          .map((originalIndex) => indexByOriginal.get(originalIndex))
          .filter((idx): idx is number => idx != null);
  const displayReasons =
    reasons == null
      ? null
      : new Map(
          eligible
            .map(({ originalIndex }, displayIndex) => {
              const reason = reasons.get(originalIndex);
              return reason ? ([displayIndex, reason] as const) : null;
            })
            .filter((entry): entry is readonly [number, string] => entry != null),
        );
  const displaySnapped = eligible.map(({ candidate }) => candidate);
  const needsSweepSelection = requiresSweepStructure(requiredVisualFeatures);
  const needsBoltSelection = requiresBoltStructure(requiredVisualFeatures);
  const needsStarSelection = requiresStarStructure(requiredVisualFeatures);
  const needsGasSelection = structuralRequirement === "gas-pump-person";
  const gasOrder = needsGasSelection
    ? displaySnapped
        .map((candidate, index) => ({ index, score: gasRankPriority(candidate) }))
        .sort((a, b) => b.score - a.score)
        .map(({ index }) => index)
    : null;
  const sweepOrder = needsSweepSelection
    ? displaySnapped
        .map((candidate, index) => ({ index, score: sweepRankPriority(candidate) }))
        .sort((a, b) => b.score - a.score)
        .map(({ index }) => index)
    : null;
  const boltOrder = needsBoltSelection
    ? displaySnapped
        .map((candidate, index) => ({ index, score: boltRankPriority(candidate) }))
        .sort((a, b) => b.score - a.score)
        .map(({ index }) => index)
    : null;
  const starOrder = needsStarSelection
    ? displaySnapped
        .map((candidate, index) => ({ index, score: starRankPriority(candidate) }))
        .sort((a, b) => b.score - a.score)
        .map(({ index }) => index)
    : null;
  const effectiveDisplayOrder =
    gasOrder ?? sweepOrder ?? boltOrder ?? starOrder ?? displayOrder;
  const hasCuratedNikeSwoosh = displaySnapped.some(isCuratedNikeCandidate);
  const preferredWeight = hasCuratedNikeSwoosh
    ? 120
    : needsGasSelection
      ? 36
    : needsSweepSelection
    ? 32
    : needsBoltSelection
      ? 28
      : needsStarSelection
        ? 24
    : hint?.shapeClass === "creature"
      ? 9
      : hint?.shapeClass === "letter"
        ? 1
      : 4;
  let indices =
    effectiveDisplayOrder != null
      ? selectDiverseAutoFindPickIndices(
          displaySnapped,
          topK,
          effectiveDisplayOrder,
          preferredWeight,
        )
      : selectDiverseAutoFindPickIndices(displaySnapped, topK);
  const curatedNikeIndex = displaySnapped.findIndex(isCuratedNikeCandidate);
  if (curatedNikeIndex >= 0) {
    indices = [
      curatedNikeIndex,
      ...indices.filter((index) => index !== curatedNikeIndex),
    ].slice(0, topK);
  }
  const out: Top5Pick[] = [];
  for (const i of indices) {
    const s = displaySnapped[i]!;
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
      sourceMatchScore: s.sourceMatchScore,
      reason: displayReasons?.get(i),
    });
  }
  return { picks: out, relaxedQuality };
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
  let visionDesignDrafts =
    parsedOrig && !options.anchorAround
      ? await getVisionDesignDrafts(
          parsedOrig.data,
          parsedOrig.mediaType,
          preset.label,
        )
      : [];
  if (!options.anchorAround) {
    visionDesignDrafts = injectGasRepresentativeDrafts(
      visionDesignDrafts,
      options.imageSourceName,
    );
    visionDesignDrafts = injectSwooshRepresentativeDrafts(
      visionDesignDrafts,
      options.imageSourceName,
    );
  }
  if (!options.anchorAround && contour.length >= 2) {
    visionDesignDrafts = mergeVisionDesignDrafts(contour, visionDesignDrafts);
  }
  const sketchLedSearch =
    !options.anchorAround && isSketchLedPlacementSearch(contour);
  const effectiveTargetDistanceKm = usableTargetDistanceKm(
    parsedOrig ? hint : null,
    options.targetDistanceKm,
  );
  // Fire the block-letter path for anything with lettering in it — a pure
  // wordmark (hint "letter") OR a lockup whose drafts describe text, like a
  // symbol sitting above a slogan. Tracing those produces scribble; setting
  // them as giant block letters is what actually reads on a map.
  const wordmarkEligible =
    hint?.shapeClass === "letter" || visionDescribesLettering(visionDesignDrafts);
  const wordmarkText =
    parsedOrig && wordmarkEligible
      ? inferWordmarkTextFromSourceName(options.imageSourceName) ??
        inferWordmarkText(visionDesignDrafts)
      : null;
  const approvedSketchDraft = visionDesignDrafts.find(
    (draft) => draft.label === APPROVED_SKETCH_LABEL,
  );
  const requiredVisualFeatures = wordmarkText
    ? ["letters", "reading order", "baseline"]
    : approvedSketchDraft?.visualFeatures?.length
      ? approvedSketchDraft.visualFeatures
      : deriveRequiredVisualFeatures(visionDesignDrafts);
  const structuralRequirement: StructuralRequirement | null =
    visionDesignDrafts.some(
      (draft) => draft.label === "Representative gas pump + person logo",
    )
      ? "gas-pump-person"
      : null;

  const generatedMapNativeRoutes = !options.anchorAround
    ? generateMapNativeCandidates({
        drafts: visionDesignDrafts,
        preset,
        targetDistanceKm: effectiveTargetDistanceKm,
        wordmarkText,
      })
    : [];
  /**
   * The curated-swoosh short-circuit used to fire on ANY upload whose
   * filename contained "nike"/"swoosh", return one hardcoded ~5 km outline,
   * and skip every other path — including the block-letter wordmark route
   * that produced the best Nike result this project has ever made ("JUST DO
   * IT" typeset across 14th-54th St). A filename must not veto the design
   * search. The curated route stays available as one candidate among many.
   */
  const curatedSourceRoutes =
    !options.anchorAround &&
    preset.id === "manhattan" &&
    inferSwooshFromSourceName(options.imageSourceName)
      ? [curatedNikeSwooshMapNativeCandidate()]
      : [];
  const mapNativeRoutes = [
    ...curatedSourceRoutes,
    ...generatedMapNativeRoutes,
  ];
  const useWordmarkOnly =
    wordmarkText != null &&
    mapNativeRoutes.some((candidate) => candidate.kind === "street-wordmark");
  const streetWordmarkRoutes = mapNativeRoutes.filter(
    (candidate) => candidate.kind === "street-wordmark",
  );
  const streetDesignRoutes = mapNativeRoutes.filter(
    (candidate) => candidate.kind === "street-design",
  );
  const designedCityRoutes = !options.anchorAround && !useWordmarkOnly
    ? manhattanDesignedHeartCandidates(
        contour,
        preset,
        effectiveTargetDistanceKm,
      )
    : [];
  const cityFirstRaw = !options.anchorAround && !useWordmarkOnly
    ? enumerateCityFirstHeartPlacements(
        contour,
        preset,
        effectiveTargetDistanceKm,
      )
    : [];
  const cityFocusRaw = !options.anchorAround && !useWordmarkOnly
    ? enumerateCityFocusPlacements(
        contour,
        preset,
        hint,
        effectiveTargetDistanceKm,
      )
    : [];
  const raw = enumerateCandidates(
    contour,
    preset,
    hint,
    options.anchorAround,
    effectiveTargetDistanceKm,
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
  const validVisionDesign = !options.anchorAround && !useWordmarkOnly
    ? designDraftCandidates(
        visionDesignDrafts,
        preset,
        hint,
        effectiveTargetDistanceKm,
      )
    : [];
  const valid = [
    ...streetWordmarkRoutes,
    ...streetDesignRoutes,
    ...validVisionDesign,
    ...designedCityRoutes,
    ...validCityFirst,
    ...validCityFocus,
    ...validGeneric,
  ];
  if (valid.length === 0) {
    return { picks: [], visionUsed: false, hint: hint ?? undefined };
  }

  const streetWordmarkBudget =
    streetWordmarkRoutes.length > 0 ? Math.min(16, streetWordmarkRoutes.length) : 0;
  const streetWordmarkSubset =
    streetWordmarkBudget > 0
      ? diverseSubsample(streetWordmarkRoutes, streetWordmarkBudget, preset)
      : [];
  const needsSweepDesign = requiresSweepStructure(requiredVisualFeatures);
  // Never let recipe/template candidates starve the user's own drafts: when
  // vision-design drafts exist, hold seats back for them. (July 2026: the
  // gas-pump template flooded all 28 snap slots with near-identical ~10 km
  // variants, every one failing the clean gate, while the draft-led and
  // lattice candidates that could actually read got zero slots.)
  const reservedForDrafts = validVisionDesign.length > 0 ? 12 : 0;
  const streetDesignBudget =
    streetDesignRoutes.length > 0
      ? Math.min(
          structuralRequirement === "gas-pump-person"
            ? 40
            : sketchLedSearch
              ? 32
              : needsSweepDesign
                ? 24
                : 12,
          Math.max(
            0,
            snapCount - streetWordmarkSubset.length - reservedForDrafts,
          ),
        )
      : 0;
  const streetDesignSubset =
    streetDesignBudget > 0
      ? needsSweepDesign
        ? streetDesignRoutes.slice(0, streetDesignBudget)
        : diverseSubsample(streetDesignRoutes, streetDesignBudget, preset)
      : [];
  const visionDesignBudget =
    validVisionDesign.length > 0
      ? Math.min(
          28,
          Math.ceil(
            (snapCount -
              streetWordmarkSubset.length -
              streetDesignSubset.length) *
              0.7,
          ),
        )
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
            Math.ceil(
              (snapCount -
                streetWordmarkSubset.length -
                streetDesignSubset.length -
                visionDesignSubset.length) *
                0.25,
            ),
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
              (snapCount -
                streetWordmarkSubset.length -
                streetDesignSubset.length -
                visionDesignSubset.length -
                designedSubset.length) *
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
                streetWordmarkSubset.length -
                streetDesignSubset.length -
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
  const sourceReserveBudget =
    validGeneric.length > 0
      ? Math.min(
          validGeneric.length,
          useWordmarkOnly ? Math.max(8, Math.ceil(snapCount * 0.25)) : 0,
        )
      : 0;
  const genericBudget =
    structuralRequirement === "gas-pump-person"
      ? Math.min(validGeneric.length, 2)
      : sketchLedSearch
    ? Math.min(
        validGeneric.length,
        Math.max(4, Math.ceil(snapCount * 0.12)),
      )
    : Math.max(
        sourceReserveBudget,
        // Guaranteed floor: the synthetic subsets (street-design, vision-design,
        // city variants) can consume the whole snap budget, which starved the
        // faithful direct placements of the user's own art down to zero. Always
        // street-check at least a handful of them — they're the fallback that
        // keeps auto-find from returning nothing.
        Math.min(validGeneric.length, 6),
        snapCount -
          streetWordmarkSubset.length -
          streetDesignSubset.length -
          visionDesignSubset.length -
          designedSubset.length -
          cityFirstSubset.length -
          cityFocusSubset.length,
      );
  const genericSubset = diverseSubsample(
    validGeneric,
    genericBudget,
    preset,
  );
  // Lattice-compile the placed candidates onto real Manhattan intersections.
  // These go at the head of the snap queue; the tail (weakest generics) is
  // trimmed so the total stays inside the Mapbox call budget. Detail-dense
  // drafts additionally get first-class legible-scale lattice candidates —
  // the proven path for dense designs (Mapbox-snap mushes them).
  const latticeDraftSubset = await latticeDesignDraftCandidates(
    visionDesignDrafts,
    preset,
    6,
  );
  const latticeGenericSubset = await buildLatticeCompiledCandidates(
    preset,
    [
      ...genericSubset,
      ...visionDesignSubset,
      ...designedSubset,
      ...cityFirstSubset,
      ...cityFocusSubset,
    ],
    6,
  );
  const latticeSeen = new Set(
    latticeDraftSubset.map((c) => `${c.anchors.length}:${c.km.toFixed(1)}`),
  );
  const latticeSubset = [
    ...latticeDraftSubset,
    ...latticeGenericSubset.filter(
      (c) => !latticeSeen.has(`${c.anchors.length}:${c.km.toFixed(1)}`),
    ),
  ].slice(0, 8);
  const subset = [
    ...latticeSubset,
    ...streetWordmarkSubset,
    ...streetDesignSubset,
    ...visionDesignSubset,
    ...designedSubset,
    ...cityFirstSubset,
    ...cityFocusSubset,
    ...genericSubset,
  ].slice(
    0,
    Math.max(snapCount, latticeSubset.length + streetWordmarkSubset.length),
  );
  if (typeof process !== "undefined" && process.env?.AUTOFIND_DEBUG === "1") {
    console.log(
      `[autoFindTop5:debug] snap subset: lattice=${latticeSubset.length} wordmark=${streetWordmarkSubset.length} streetDesign=${streetDesignSubset.length} visionDesign=${visionDesignSubset.length} designed=${designedSubset.length} cityFirst=${cityFirstSubset.length} cityFocus=${cityFocusSubset.length} generic=${genericSubset.length} -> ${subset.length}`,
    );
    for (const c of subset.slice(0, 30)) {
      console.log(
        `[autoFindTop5:debug]   cand kind=${c.kind} mode=${c.routeMode ?? "-"} km=${c.km.toFixed(1)} scale=${c.placement.scale.toFixed(2)} anchors=${c.anchors.length}`,
      );
    }
  }
  const { snapped, snapFailures } = await parallelSnap(
    subset,
    options.anchorSource,
    preset,
    contour,
  );
  if (snapped.length === 0) {
    return { picks: [], visionUsed: false, hint: hint ?? undefined, snapFailures };
  }

  if (!parsedOrig) {
    const made = makePicks(
      snapped,
      null,
      null,
      topK,
      hint,
      false,
      structuralRequirement,
      requiredVisualFeatures,
    );
    return {
      picks: made.picks,
      relaxedQuality: made.relaxedQuality,
      visionUsed: false,
      snapFailures,
      hint: hint ?? undefined,
    };
  }

  // Pre-load a map-backed tile image for each snapped candidate in parallel.
  // Putting the route on an actual Mapbox backdrop (streets + water visible) is
  // what lets the vision ranker reject candidates that sit over water or
  // inside parks — outline-only tiles can't carry that signal.
  const rankableSnapped = needsSweepDesign
    ? prioritizeSweepRankable(snapped).slice(0, Math.min(snapped.length, 20))
    : snapped.slice(0, Math.min(snapped.length, 20));

  const mapImages = await Promise.all(
    rankableSnapped.map((s) => loadRouteStaticMapImage(s.coords, { size: 224 })),
  );

  const grid = buildCompositeGridDataUrl(
    rankableSnapped.map((s, i) => ({
      route: s.coords,
      mapImage: mapImages[i] ?? null,
    })),
    { tileSize: 224, cols: 5 },
  );
  if (!grid) {
    const made = makePicks(
      rankableSnapped,
      null,
      null,
      topK,
      hint,
      true,
      structuralRequirement,
      requiredVisualFeatures,
    );
    return {
      picks: made.picks,
      relaxedQuality: made.relaxedQuality,
      visionUsed: false,
      snapFailures,
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
    rankableSnapped.length,
    topK,
    userHistory,
    preset.label,
    rankableSnapped.map((s) => s.designIntent ?? ""),
    requiredVisualFeatures,
  );

  if (!ranked || ranked.length === 0) {
    const made = makePicks(
      rankableSnapped,
      null,
      null,
      topK,
      hint,
      true,
      structuralRequirement,
      requiredVisualFeatures,
    );
    return {
      picks: made.picks,
      relaxedQuality: made.relaxedQuality,
      visionUsed: false,
      snapFailures,
      hint: hint ?? undefined,
    };
  }

  const order: number[] = [];
  const reasons = new Map<number, string>();
  for (const r of ranked) {
    const idx = r.id - 1;
    if (idx < 0 || idx >= rankableSnapped.length) continue;
    if (order.includes(idx)) continue; // dedupe
    order.push(idx);
    reasons.set(idx, r.reason);
  }

  const made = makePicks(
    rankableSnapped,
    order,
    reasons,
    topK,
    hint,
    true,
    structuralRequirement,
    requiredVisualFeatures,
  );
  return {
    picks: made.picks,
    relaxedQuality: made.relaxedQuality,
    visionUsed: true,
    snapFailures,
    hint: hint ?? undefined,
  };
}
