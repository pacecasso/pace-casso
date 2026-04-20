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
import { principalAxisAngleDeg } from "./autoFindPlacement";
import {
  simplifyAnchorPathForSnap,
  type AnchorPathSource,
} from "./simplifyAnchorPathForSnap";
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

const MARGIN = 0.012;
const MIN_PERIMETER_KM = 3;
/**
 * Accommodates hero-scale placements (e.g. an island-sized heart on Manhattan,
 * perimeter ≈ 28–32 km). The snap-ratio filter + vision rank still weed out
 * candidates that don't read at that size, so widening here only expands the
 * candidate *pool*, not the output quality bar.
 */
const MAX_PERIMETER_KM = 35;
const CANDIDATES_TO_SNAP = 20;
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
  /** Snapped walking-route geometry (`[lat, lng]` pairs). */
  routeCoords: [number, number][];
  /** Image URL for the preview tile. Usually a Mapbox Static Images URL showing
   *  the route on a real map backdrop; falls back to a pure-outline data-URL
   *  if the static map can't be built (missing token, etc.). */
  previewDataUrl: string;
  distanceKm: number;
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

async function snapOne(
  anchors: [number, number][],
  anchorSource: AnchorPathSource | undefined,
): Promise<{ coords: [number, number][]; snappedKm: number } | null> {
  try {
    const simplified = simplifyAnchorPathForSnap(anchors, {
      sourceKind: anchorSource ?? "default",
    });
    if (simplified.length < 2) return null;
    const route = await snapWalkingRoute(simplified, { anchorSource });
    const coords = route.coordinates as [number, number][];
    if (coords.length < 2) return null;
    const snappedKm = (route.distanceMeters ?? 0) / 1000;
    return { coords, snappedKm };
  } catch {
    return null;
  }
}

type SnappedCandidate = {
  placement: PlacementTransform;
  coords: [number, number][];
  /** Snapped walking distance in km (what Mapbox returned). */
  km: number;
};

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

        return {
          placement: c.placement,
          coords: r.coords,
          km: r.snappedKm,
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
      ? order.filter((i) => i >= 0 && i < snapped.length).slice(0, topK)
      : snapped.slice(0, topK).map((_, i) => i);
  const out: Top5Pick[] = [];
  for (const i of indices) {
    const s = snapped[i]!;
    out.push({
      placement: s.placement,
      routeCoords: s.coords,
      previewDataUrl: pickPreviewUrl(s.coords),
      distanceKm: s.km,
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

  const raw = enumerateCandidates(
    contour,
    preset,
    hint,
    options.anchorAround,
    options.targetDistanceKm,
  );

  const valid: ValidCandidate[] = [];
  for (const p of raw) {
    const v = sanityFilter(contour, preset, p);
    if (v) valid.push(v);
  }
  if (valid.length === 0) {
    return { picks: [], visionUsed: false, hint: hint ?? undefined };
  }

  const subset = diverseSubsample(valid, snapCount, preset);
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
