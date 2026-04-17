/**
 * Heuristic search for placement (center, rotation, scale), optional Mapbox snap refine.
 */

import type { CityPreset } from "./cityPresets";
import {
  buildAnchorLatLngsFromContour,
  type ContourPoint,
  type PlacementTransform,
} from "./placementFromContour";
import { shapeAccuracyPercent } from "./shapeMatchScore";
import { simplifyAnchorPathForSnap } from "./simplifyAnchorPathForSnap";
import { snapWalkingRoute } from "./snapWalkingRoute";

const MARGIN = 0.012;
const IDEAL_DISTANCE_KM = 9;
const DIST_WEIGHT = 2.2;
const GRID_ALIGN_WEIGHT = 0.35;

/**
 * Minimum `shapeAccuracyPercent` (0–100) to adopt a snap-backed placement.
 * Below this we keep the geometry-only heuristic so weak street fits don’t win.
 */
export const MIN_SNAP_MATCH_PERCENT_TO_ADOPT = 42;

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

export type BestPlacementBySnapMatchOptions = {
  maxSnapTries?: number;
  retryDelayMs?: number;
};

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
  const distPen =
    DIST_WEIGHT * Math.abs(approxDistanceKm - IDEAL_DISTANCE_KM) ** 1.15;
  const grid = GRID_ALIGN_WEIGHT * gridAlignmentBonus(t.rotationDeg, preset);
  return 200 - distPen + grid;
}

export function enumeratePlacementCandidates(
  preset: CityPreset,
): PlacementTransform[] {
  const b = preset.searchBounds;
  const latSpan = b.north - b.south - 2 * MARGIN;
  const lngSpan = b.east - b.west - 2 * MARGIN;
  const latSteps = 4;
  const lngSteps = 4;
  const scales = [0.7, 0.9, 1.1, 1.35, 1.65, 2.0];
  const rotations = [
    -75, -60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60, 75, 90, -90,
  ];
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

export function findBestHeuristicPlacement(
  contour: ContourPoint[],
  preset: CityPreset,
): { placement: PlacementTransform; score: number } {
  let best: PlacementTransform = {
    center: [...preset.defaultCenter] as [number, number],
    rotationDeg: 0,
    scale: 1,
  };
  let bestScore = -Infinity;
  for (const t of enumeratePlacementCandidates(preset)) {
    const s = scorePlacementHeuristic(contour, preset, t);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  if (bestScore === -Infinity) {
    return {
      placement: {
        center: [...preset.defaultCenter] as [number, number],
        rotationDeg: 0,
        scale: 1,
      },
      score: -Infinity,
    };
  }
  return { placement: best, score: bestScore };
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
      const pct = await snapMatchPercentForPlacement(contour, n);
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

function rankHeuristicTop(
  contour: ContourPoint[],
  preset: CityPreset,
  topK: number,
): { placement: PlacementTransform; score: number }[] {
  const scored: { placement: PlacementTransform; score: number }[] = [];
  for (const t of enumeratePlacementCandidates(preset)) {
    const s = scorePlacementHeuristic(contour, preset, t);
    if (s === -Infinity) continue;
    scored.push({ placement: t, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, topK));
}

function placementKey(p: PlacementTransform): string {
  return `${p.center[0].toFixed(5)},${p.center[1].toFixed(5)},${Math.round(p.rotationDeg)},${p.scale.toFixed(2)}`;
}

/** Snap once and return shape match %, or null on failure. */
export async function snapMatchPercentForPlacement(
  contour: ContourPoint[],
  placement: PlacementTransform,
): Promise<number | null> {
  const { anchorLatLngs } = buildAnchorLatLngsFromContour(contour, placement);
  if (anchorLatLngs.length < 2) return null;
  let anchors: [number, number][] = anchorLatLngs.map(
    ([la, ln]) => [la, ln] as [number, number],
  );
  try {
    anchors = simplifyAnchorPathForSnap(anchors);
    if (anchors.length < 2) return null;
    const route = await snapWalkingRoute(anchors);
    const coords = route.coordinates as [number, number][];
    if (coords.length < 2) return null;
    return shapeAccuracyPercent(anchors, coords);
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
  const { placement: heurPlacement } = findBestHeuristicPlacement(
    contour,
    preset,
  );
  const ranked = rankHeuristicTop(contour, preset, 24);

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
    const pct = await snapMatchPercentForPlacement(contour, placement);
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
  options: { useSnapRefine?: boolean } = {},
): Promise<AutoFindResult> {
  const { placement, score: heuristicScore } = findBestHeuristicPlacement(
    contour,
    preset,
  );

  if (!options.useSnapRefine) {
    return {
      placement,
      usedSnapRefine: false,
      heuristicScore,
    };
  }

  const { chosen, bestAttemptPercent, snapBest } = await bestPlacementBySnapMatch(
    contour,
    preset,
    {},
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
