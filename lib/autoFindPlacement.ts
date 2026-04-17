/**
 * Heuristic search for placement (center, rotation, scale), optional Mapbox snap refine.
 */

import type { CityPreset } from "./cityPresets";
import {
  buildAnchorLatLngsFromContour,
  type ContourPoint,
  type PlacementTransform,
} from "./placementFromContour";
import { interpretationMatchPercent } from "./shapeMatchScore";
import {
  simplifyAnchorPathForSnap,
  type AnchorPathSource,
} from "./simplifyAnchorPathForSnap";
import { snapWalkingRoute } from "./snapWalkingRoute";

export type { AnchorPathSource };

const MARGIN = 0.012;
const IDEAL_DISTANCE_KM = 9;
const DIST_WEIGHT = 2.2;
const GRID_ALIGN_WEIGHT = 0.35;

/** Extra penalty when outline perimeter (approx route length) is very long — discourages “bloated” scales. */
const LONG_ROUTE_THRESHOLD_KM = 12;
const LONG_ROUTE_EXTRA_WEIGHT = 1.15;

/** Reward placements whose footprint sits away from searchBounds edges (room to breathe). */
const BBOX_MARGIN_BONUS_MAX = 3.2;
const BBOX_MARGIN_BONUS_SCALE = 2.4;

/** Penalize extremely elongated footprints (thin slivers). */
const ASPECT_RATIO_SOFT_MAX = 6;
const ASPECT_RATIO_PENALTY_WEIGHT = 0.38;

/**
 * Minimum **interpretation** match (0–100) to label a snap-backed auto-find as
 * “street-backed.” Uses {@link interpretationMatchPercent} (gestalt-friendly),
 * not raw point-to-line tight fit.
 */
export const MIN_SNAP_MATCH_PERCENT_TO_ADOPT = 50;

const SNAP_RETRY_DELAY_MS = 85;
/**
 * Distinct placements (heuristic winner first, then top others) to snap-test
 * before local refinement. Higher = broader search at the cost of more Mapbox calls.
 */
export const MAX_SNAP_TRIES = 14;

/**
 * Extra snap evaluations to hill-climb around the best score from phase 1,
 * nudging center / rotation / scale toward higher shape match.
 */
/** Hill-climb budget (neighbors per round ≈22; allows ~2 improving rounds). */
const LOCAL_REFINE_MAX_SNAP_CALLS = 40;

/**
 * Lighter snap sweep for area-template cards (fewer Mapbox calls than full auto-find).
 */
export const AREA_TEMPLATE_SNAP_MAX_TRIES = 3;

/** How many top heuristic hits get a dense local refinement pass. */
const DENSE_REFINE_TOP_SEEDS = 5;

export type BestPlacementBySnapMatchOptions = {
  maxSnapTries?: number;
  retryDelayMs?: number;
  /** When set, skips a second heuristic ranking pass (same as auto-find’s rank). */
  precomputedRanked?: { placement: PlacementTransform; score: number }[];
  /** Align with street snap: photo traces use mild anchor reduction before Mapbox. */
  anchorSource?: AnchorPathSource;
};

function normalizeDeg180(d: number): number {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

/**
 * Principal axis of the contour in normalized (x,y) space (degrees from +x axis).
 * Used to suggest rotations that align the outline with the city street grid.
 */
export function principalAxisAngleDeg(contour: ContourPoint[]): number | null {
  const n = contour.length;
  if (n < 2) return null;
  let cx = 0;
  let cy = 0;
  for (const p of contour) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const p of contour) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  xx /= n;
  yy /= n;
  xy /= n;
  const half = (xx - yy) / 2;
  const root = Math.sqrt(half * half + xy * xy);
  const lambda1 = (xx + yy) / 2 + root;
  let vx: number;
  let vy: number;
  if (Math.abs(xy) > 1e-12 || Math.abs(xx - lambda1) > 1e-12) {
    vx = xy;
    vy = lambda1 - xx;
  } else {
    vx = 1;
    vy = 0;
  }
  const len = Math.hypot(vx, vy);
  if (len < 1e-12) return null;
  return (Math.atan2(vy, vx) * 180) / Math.PI;
}

/**
 * Rotations that approximately align the contour’s long axis with dominant grid directions.
 */
function gridSnappedRotationAnglesDeg(
  contour: ContourPoint[],
  preset: CityPreset,
): number[] {
  const theta = principalAxisAngleDeg(contour);
  if (theta == null) return [];
  const bearings = preset.dominantGridBearingsDeg?.length
    ? [...preset.dominantGridBearingsDeg]
    : [0];
  const seeds = new Set<number>();
  for (const g of bearings) {
    const align = normalizeDeg180(g - theta);
    seeds.add(Math.round(align));
    for (const d of [-10, -5, 5, 10]) {
      seeds.add(Math.round(normalizeDeg180(align + d)));
    }
  }
  return [...seeds];
}

/** Base + PCA/grid-snapped rotations (exported for tests). */
export function buildRotationAngles(
  contour: ContourPoint[],
  preset: CityPreset,
): number[] {
  const base = [
    -75, -60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60, 75, 90, -90,
  ];
  const pca = gridSnappedRotationAnglesDeg(contour, preset);
  const merged = new Set<number>([...base, ...pca]);
  return [...merged].sort((a, b) => a - b);
}

function anchorsInsideBounds(
  anchors: [number, number][],
  b: CityPreset["searchBounds"],
): boolean {
  for (const [lat, lng] of anchors) {
    if (
      lat < b.south + MARGIN ||
      lat > b.north - MARGIN ||
      lng < b.west + MARGIN ||
      lng > b.east - MARGIN
    ) {
      return false;
    }
  }
  return true;
}

function smallestAngleDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

/** Manhattan-ish grid bearings from north (deg) for mild alignment bonus. */
function gridAlignmentBonus(rotationDeg: number, preset: CityPreset): number {
  const g = preset.dominantGridBearingsDeg;
  if (!g?.length) return 0;
  let best = 90;
  for (const bearing of g) {
    for (const k of [0, 90]) {
      const d = smallestAngleDiffDeg(rotationDeg + k, bearing);
      if (d < best) best = d;
    }
  }
  return Math.max(0, 22 - best);
}

export type AnchorFootprintMetrics = {
  widthM: number;
  heightM: number;
  /** Shortest gap from axis-aligned bbox to inner searchBounds (km). */
  minEdgeMarginKm: number;
  /** max(w,h)/min(w,h) in meters. */
  aspectRatio: number;
};

/**
 * Footprint of placed anchors and breathing room inside the city search box.
 * Used to prefer compact, well-centered layouts (closer to typical manual tweaks).
 */
export function anchorFootprintMetrics(
  anchorLatLngs: [number, number][],
  preset: CityPreset,
): AnchorFootprintMetrics | null {
  if (anchorLatLngs.length < 2) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of anchorLatLngs) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  const latMid = (minLat + maxLat) / 2;
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((latMid * Math.PI) / 180);
  const widthM = Math.max((maxLng - minLng) * mPerLng, 1);
  const heightM = Math.max((maxLat - minLat) * mPerLat, 1);
  const aspectRatio = Math.max(widthM, heightM) / Math.min(widthM, heightM);
  const b = preset.searchBounds;
  const innerS = b.south + MARGIN;
  const innerN = b.north - MARGIN;
  const innerW = b.west + MARGIN;
  const innerE = b.east - MARGIN;
  const mSouth = ((minLat - innerS) * mPerLat) / 1000;
  const mNorth = ((innerN - maxLat) * mPerLat) / 1000;
  const mWest = ((minLng - innerW) * mPerLng) / 1000;
  const mEast = ((innerE - maxLng) * mPerLng) / 1000;
  const minEdgeMarginKm = Math.min(mSouth, mNorth, mWest, mEast);
  return { widthM, heightM, minEdgeMarginKm, aspectRatio };
}

/**
 * Higher is better. Returns -Infinity if anchors leave city bounds.
 */
export function scorePlacementHeuristic(
  contour: ContourPoint[],
  preset: CityPreset,
  t: PlacementTransform,
): number {
  const { anchorLatLngs, approxDistanceKm } = buildAnchorLatLngsFromContour(
    contour,
    t,
  );
  if (anchorLatLngs.length < 2) return -Infinity;
  if (!anchorsInsideBounds(anchorLatLngs, preset.searchBounds)) {
    return -Infinity;
  }
  const baseDistPen =
    DIST_WEIGHT * Math.abs(approxDistanceKm - IDEAL_DISTANCE_KM) ** 1.15;
  const longBloatPen =
    approxDistanceKm > LONG_ROUTE_THRESHOLD_KM
      ? LONG_ROUTE_EXTRA_WEIGHT *
        (approxDistanceKm - LONG_ROUTE_THRESHOLD_KM) ** 1.35
      : 0;

  const fp = anchorFootprintMetrics(anchorLatLngs, preset);
  let marginBonus = 0;
  let aspectPen = 0;
  if (fp) {
    marginBonus = Math.min(
      BBOX_MARGIN_BONUS_MAX,
      BBOX_MARGIN_BONUS_SCALE * Math.max(0, fp.minEdgeMarginKm),
    );
    if (fp.aspectRatio > ASPECT_RATIO_SOFT_MAX) {
      aspectPen =
        ASPECT_RATIO_PENALTY_WEIGHT *
        (fp.aspectRatio - ASPECT_RATIO_SOFT_MAX) ** 1.05;
    }
  }

  const grid = GRID_ALIGN_WEIGHT * gridAlignmentBonus(t.rotationDeg, preset);
  return (
    200 -
    baseDistPen -
    longBloatPen -
    aspectPen +
    marginBonus +
    grid
  );
}

export function enumeratePlacementCandidates(
  preset: CityPreset,
  contour: ContourPoint[],
): PlacementTransform[] {
  const b = preset.searchBounds;
  const latSpan = b.north - b.south - 2 * MARGIN;
  const lngSpan = b.east - b.west - 2 * MARGIN;
  const latSteps = 4;
  const lngSteps = 4;
  const scales = [0.7, 0.9, 1.1, 1.35, 1.65, 2.0];
  const rotations = buildRotationAngles(contour, preset);
  const out: PlacementTransform[] = [];
  for (let li = 0; li < latSteps; li++) {
    for (let gi = 0; gi < lngSteps; gi++) {
      const lat = b.south + MARGIN + (latSpan * (li + 0.5)) / latSteps;
      const lng = b.west + MARGIN + (lngSpan * (gi + 0.5)) / lngSteps;
      const center: [number, number] = [lat, lng];
      for (const scale of scales) {
        for (const rotationDeg of rotations) {
          out.push({ center, rotationDeg, scale });
        }
      }
    }
  }
  return out;
}

/**
 * Small nudges around strong heuristic seeds (finer than the global grid).
 */
function generateDenseRefinementCandidates(
  contour: ContourPoint[],
  preset: CityPreset,
  seeds: PlacementTransform[],
): PlacementTransform[] {
  const b = preset.searchBounds;
  const latSpan = b.north - b.south - 2 * MARGIN;
  const lngSpan = b.east - b.west - 2 * MARGIN;
  const fracs = [-0.035, -0.018, 0.018, 0.035];
  const out: PlacementTransform[] = [];
  const seen = new Set<string>();
  const push = (t: PlacementTransform) => {
    const k = placementKey(t);
    if (seen.has(k)) return;
    if (!placementFeasible(contour, preset, t)) return;
    seen.add(k);
    out.push(t);
  };

  for (const base of seeds) {
    for (const f of fracs) {
      push({
        ...base,
        center: [base.center[0] + f * latSpan, base.center[1]] as [
          number,
          number,
        ],
      });
      push({
        ...base,
        center: [base.center[0], base.center[1] + f * lngSpan] as [
          number,
          number,
        ],
      });
    }
    for (const g of [0.96, 1.04]) {
      push({ ...base, scale: clampScale(base.scale * g) });
    }
    for (const r of [-6, -3, 3, 6]) {
      push({ ...base, rotationDeg: base.rotationDeg + r });
    }
  }
  return out;
}

function placementKey(p: PlacementTransform): string {
  return `${p.center[0].toFixed(5)},${p.center[1].toFixed(5)},${Math.round(p.rotationDeg)},${p.scale.toFixed(2)}`;
}

/** Coarse grid + PCA rotations + dense local refinements around top heuristic seeds. */
function buildCandidatePool(
  contour: ContourPoint[],
  preset: CityPreset,
): PlacementTransform[] {
  const base = enumeratePlacementCandidates(preset, contour);
  const scored = base
    .map((placement) => ({
      placement,
      score: scorePlacementHeuristic(contour, preset, placement),
    }))
    .filter((x) => x.score > -Infinity)
    .sort((a, b) => b.score - a.score);

  const topSeeds = scored
    .slice(0, DENSE_REFINE_TOP_SEEDS)
    .map((x) => x.placement);
  const dense = generateDenseRefinementCandidates(contour, preset, topSeeds);

  const seen = new Set<string>();
  const out: PlacementTransform[] = [];
  for (const t of [...base, ...dense]) {
    const k = placementKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function defaultPlacementFallback(preset: CityPreset): PlacementTransform {
  return {
    center: [...preset.defaultCenter] as [number, number],
    rotationDeg: 0,
    scale: 1,
  };
}

export function rankHeuristicTop(
  contour: ContourPoint[],
  preset: CityPreset,
  topK: number,
): { placement: PlacementTransform; score: number }[] {
  const pool = buildCandidatePool(contour, preset);
  const scored: { placement: PlacementTransform; score: number }[] = [];
  for (const placement of pool) {
    const s = scorePlacementHeuristic(contour, preset, placement);
    if (s === -Infinity) continue;
    scored.push({ placement, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, topK));
}

export function findBestHeuristicPlacement(
  contour: ContourPoint[],
  preset: CityPreset,
): { placement: PlacementTransform; score: number } {
  const top = rankHeuristicTop(contour, preset, 1);
  if (!top.length) {
    return {
      placement: defaultPlacementFallback(preset),
      score: -Infinity,
    };
  }
  return { placement: top[0].placement, score: top[0].score };
}

function placementFeasible(
  contour: ContourPoint[],
  preset: CityPreset,
  t: PlacementTransform,
): boolean {
  return scorePlacementHeuristic(contour, preset, t) > -Infinity;
}

function clampScale(s: number): number {
  return Math.min(3, Math.max(0.5, s));
}

/**
 * Small nudges to center / rotation / scale around a seed (for snap % hill-climb).
 */
function generateLocalNeighbors(
  contour: ContourPoint[],
  preset: CityPreset,
  base: PlacementTransform,
): PlacementTransform[] {
  const b = preset.searchBounds;
  const latSpan = b.north - b.south - 2 * MARGIN;
  const lngSpan = b.east - b.west - 2 * MARGIN;
  /** Fractions of searchable span inside bounds */
  const frac = [-0.045, -0.022, -0.012, 0.012, 0.022, 0.045];
  const rotStep = [-14, -8, -4, 4, 8, 14];
  const scaleRel = [0.93, 0.97, 1.03, 1.07];

  const out: PlacementTransform[] = [];
  const seen = new Set<string>();
  const push = (t: PlacementTransform) => {
    const k = placementKey(t);
    if (seen.has(k)) return;
    if (!placementFeasible(contour, preset, t)) return;
    seen.add(k);
    out.push(t);
  };

  for (const f of frac) {
    push({
      ...base,
      center: [base.center[0] + f * latSpan, base.center[1]] as [
        number,
        number,
      ],
    });
    push({
      ...base,
      center: [base.center[0], base.center[1] + f * lngSpan] as [
        number,
        number,
      ],
    });
  }
  for (const r of rotStep) {
    push({ ...base, rotationDeg: base.rotationDeg + r });
  }
  for (const g of scaleRel) {
    push({ ...base, scale: clampScale(base.scale * g) });
  }

  return out;
}

/**
 * Hill-climb on shape match % starting from a placement already snap-scored.
 */
async function snapLocalRefineFromSeed(
  contour: ContourPoint[],
  preset: CityPreset,
  seed: { placement: PlacementTransform; snapScore: number },
  maxCalls: number,
  retryDelayMs: number,
  anchorSource: AnchorPathSource | undefined,
): Promise<{ placement: PlacementTransform; snapScore: number }> {
  let current = seed.placement;
  let currentPct = seed.snapScore;
  let used = 0;

  for (let round = 0; round < 4 && used < maxCalls; round++) {
    const neighbors = generateLocalNeighbors(contour, preset, current);
    let bestP = current;
    let bestPct = currentPct;

    for (const n of neighbors) {
      if (used >= maxCalls) break;
      const pct = await snapMatchPercentForPlacement(
        contour,
        n,
        anchorSource,
      );
      used++;
      if (pct != null && pct > bestPct) {
        bestPct = pct;
        bestP = n;
      }
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }

    if (bestP === current) break;
    current = bestP;
    currentPct = bestPct;
  }

  return { placement: current, snapScore: currentPct };
}

/** Snap once and return shape match %, or null on failure. */
export async function snapMatchPercentForPlacement(
  contour: ContourPoint[],
  placement: PlacementTransform,
  anchorSource?: AnchorPathSource,
): Promise<number | null> {
  const { anchorLatLngs } = buildAnchorLatLngsFromContour(contour, placement);
  if (anchorLatLngs.length < 2) return null;
  let anchors: [number, number][] = anchorLatLngs.map(
    ([la, ln]) => [la, ln] as [number, number],
  );
  try {
    anchors = simplifyAnchorPathForSnap(anchors, {
      sourceKind: anchorSource ?? "default",
    });
    if (anchors.length < 2) return null;
    const route = await snapWalkingRoute(anchors, { anchorSource });
    const coords = route.coordinates as [number, number][];
    if (coords.length < 2) return null;
    return interpretationMatchPercent(anchors, coords);
  } catch {
    return null;
  }
}

/**
 * Heuristic winner first, then other top heuristic placements (deduped).
 * Returns the best snap match only if it clears {@link MIN_SNAP_MATCH_PERCENT_TO_ADOPT}.
 */
export async function bestPlacementBySnapMatch(
  contour: ContourPoint[],
  preset: CityPreset,
  options: BestPlacementBySnapMatchOptions = {},
): Promise<{
  chosen: { placement: PlacementTransform; snapScore: number } | null;
  bestAttemptPercent: number | null;
  /** Best placement after phase 1 + local snap refine (null if all snap calls failed). */
  snapBest: { placement: PlacementTransform; snapScore: number } | null;
}> {
  const maxSnapTries = Math.max(
    1,
    Math.min(options.maxSnapTries ?? MAX_SNAP_TRIES, 24),
  );
  const retryDelayMs = options.retryDelayMs ?? SNAP_RETRY_DELAY_MS;
  const anchorSource = options.anchorSource;

  const ranked =
    options.precomputedRanked ??
    rankHeuristicTop(contour, preset, 24);
  const heurPlacement =
    ranked[0]?.placement ?? defaultPlacementFallback(preset);

  const ordered: PlacementTransform[] = [];
  const seen = new Set<string>();
  const push = (p: PlacementTransform) => {
    const k = placementKey(p);
    if (seen.has(k)) return;
    seen.add(k);
    ordered.push(p);
  };

  push(heurPlacement);
  for (const row of ranked) {
    push(row.placement);
  }
  const toTry = ordered.slice(0, maxSnapTries);

  let best: { placement: PlacementTransform; snapScore: number } | null = null;

  for (const placement of toTry) {
    const pct = await snapMatchPercentForPlacement(
      contour,
      placement,
      anchorSource,
    );
    if (pct != null) {
      if (!best || pct > best.snapScore) {
        best = { placement, snapScore: pct };
      }
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  let snapBest: { placement: PlacementTransform; snapScore: number } | null =
    best;

  if (best) {
    const refined = await snapLocalRefineFromSeed(
      contour,
      preset,
      best,
      LOCAL_REFINE_MAX_SNAP_CALLS,
      retryDelayMs,
      anchorSource,
    );
    if (refined.snapScore > best.snapScore) {
      snapBest = refined;
    }
  }

  const bestAttemptPercent = snapBest?.snapScore ?? null;
  const chosen =
    snapBest && snapBest.snapScore >= MIN_SNAP_MATCH_PERCENT_TO_ADOPT
      ? snapBest
      : null;

  return { chosen, bestAttemptPercent, snapBest };
}

export type AutoFindResult = {
  placement: PlacementTransform;
  usedSnapRefine: boolean;
  snapScore?: number;
  heuristicScore: number;
  /** Best shape match among snap attempts, even when below adopt threshold. */
  bestSnapAttemptPercent?: number | null;
};

/**
 * Best heuristic placement, then optional snap evaluation across distinct
 * top candidates; adopts the winner only if street match is strong enough.
 */
export async function autoFindPlacement(
  contour: ContourPoint[],
  preset: CityPreset,
  options: { useSnapRefine?: boolean; anchorSource?: AnchorPathSource } = {},
): Promise<AutoFindResult> {
  if (!options.useSnapRefine) {
    const rankedOne = rankHeuristicTop(contour, preset, 1);
    const { placement, score: heuristicScore } = rankedOne.length
      ? { placement: rankedOne[0].placement, score: rankedOne[0].score }
      : {
          placement: defaultPlacementFallback(preset),
          score: -Infinity as number,
        };
    return {
      placement,
      usedSnapRefine: false,
      heuristicScore,
    };
  }

  const ranked = rankHeuristicTop(contour, preset, 24);
  const first = ranked[0];
  const placement = first?.placement ?? defaultPlacementFallback(preset);
  const heuristicScore = first?.score ?? -Infinity;

  const { chosen, bestAttemptPercent, snapBest } = await bestPlacementBySnapMatch(
    contour,
    preset,
    { precomputedRanked: ranked, anchorSource: options.anchorSource },
  );

  if (chosen) {
    return {
      placement: chosen.placement,
      usedSnapRefine: true,
      snapScore: chosen.snapScore,
      heuristicScore,
      bestSnapAttemptPercent: bestAttemptPercent,
    };
  }

  if (snapBest) {
    return {
      placement: snapBest.placement,
      usedSnapRefine: false,
      heuristicScore,
      bestSnapAttemptPercent: bestAttemptPercent,
    };
  }

  return {
    placement,
    usedSnapRefine: false,
    heuristicScore,
    bestSnapAttemptPercent: bestAttemptPercent,
  };
}
