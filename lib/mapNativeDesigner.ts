import type { CityPreset } from "./cityPresets";
import type { ContourPoint, PlacementTransform } from "./placementFromContour";
import { analyzeOneLinePath } from "./oneLinePathAnalysis";
import { simplifyCartesian, type Point2D } from "./douglasPeucker";
import { CURATED_MANHATTAN_RUNS, type CuratedRun } from "./curatedManhattanRuns";
import { curatedSneakerManhattanMapNativeCandidate } from "./curatedSneakerManhattanRoute";
import { curatedApple2ManhattanMapNativeCandidate } from "./curatedInterpretiveManhattanRoutes";
import { curatedKeyManhattanMapNativeCandidate } from "./curatedKeyManhattanRoute";
import { curatedMartiniDcMapNativeCandidate } from "./curatedDcMartiniRoute";
import { curatedUmbrellaManhattanMapNativeCandidate } from "./curatedUmbrellaManhattanRoute";
import { curatedTrophyManhattanMapNativeCandidate } from "./curatedTrophyManhattanRoute";

const MARGIN = 0.012;
const MIN_ROUTE_KM = 3;
const MAX_ROUTE_KM = 35;
/**
 * Block-letter wordmarks get their own, much larger ceiling. They're drawn
 * directly on avenue/street lines (routeMode "direct-grid"), so length here
 * buys legibility rather than snap-mush: the best Nike result this project
 * ever produced was "JUST DO IT" across 14th-54th Street at 50 km. Capping
 * these at 35 km made that composition impossible to generate.
 */
const MAX_WORDMARK_ROUTE_KM = 56;
/** ~0.003deg ≈ 250-330 m. See the call site in streetWordmarkCandidates. */
const WORDMARK_BOUNDS_MARGIN = 0.003;

export type MapNativeDesignDraft = {
  label: string;
  description: string;
  visualFeatures?: string[];
  points: ContourPoint[];
  designScore: number;
};

export type MapNativeCandidate = {
  placement: PlacementTransform;
  anchors: [number, number][];
  km: number;
  designIntent: string;
  kind: "street-design" | "street-wordmark";
  routeMode?: "direct-grid";
};

export type MapNativeDesignerOptions = {
  drafts: MapNativeDesignDraft[];
  preset: CityPreset;
  targetDistanceKm?: number;
  wordmarkText?: string | null;
};

function routeLengthKm(coords: [number, number][]): number {
  let meters = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lat1, lng1] = coords[i - 1]!;
    const [lat2, lng2] = coords[i]!;
    const latRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const metersPerLat = 111_320;
    const metersPerLng = metersPerLat * Math.cos(latRad);
    meters += Math.hypot(
      (lat2 - lat1) * metersPerLat,
      (lng2 - lng1) * metersPerLng,
    );
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

function rotationDegFromBearing(bearingDeg: number): number {
  let deg = 90 - bearingDeg;
  while (deg <= -180) deg += 360;
  while (deg > 180) deg -= 360;
  return deg;
}

function sourceAlignedPlacementFromAnchors(
  anchors: [number, number][],
  xBearingDeg: number,
): PlacementTransform {
  const center = placementFromAnchors(anchors, 0, 1).center;
  const xAxis = bearingUnitVector(xBearingDeg);
  const yAxis = bearingUnitVector(xBearingDeg + 90);
  const metersPerLat = 111_320;
  const metersPerLng =
    metersPerLat * Math.cos((center[0] * Math.PI) / 180);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const [lat, lng] of anchors) {
    const east = (lng - center[1]) * metersPerLng;
    const north = (lat - center[0]) * metersPerLat;
    const x = east * xAxis.east + north * xAxis.north;
    const y = east * yAxis.east + north * yAxis.north;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const spanMeters = Math.max(maxX - minX, maxY - minY, 250);
  return {
    center,
    rotationDeg: rotationDegFromBearing(xBearingDeg),
    scale: Math.max(0.12, Math.min(3.5, spanMeters / 2000)),
  };
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

function bearingUnitVector(bearingDeg: number): { east: number; north: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  return { east: Math.sin(rad), north: Math.cos(rad) };
}

function offsetLatLngMeters(
  center: [number, number],
  eastMeters: number,
  northMeters: number,
): [number, number] {
  const metersPerLat = 111_320;
  const metersPerLng =
    metersPerLat * Math.cos((center[0] * Math.PI) / 180);
  return [
    center[0] + northMeters / metersPerLat,
    center[1] + eastMeters / metersPerLng,
  ];
}

function basicLetterStroke(letter: string): ContourPoint[] {
  switch (letter) {
    case "A":
      return [
        { x: 0, y: 1 },
        { x: 0.5, y: 0 },
        { x: 1, y: 1 },
        { x: 0.78, y: 0.58 },
        { x: 0.24, y: 0.58 },
      ];
    case "C":
      return [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0.5 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ];
    case "D":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ];
    case "E":
      return [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
        { x: 0, y: 0.5 },
        { x: 0.82, y: 0.5 },
      ];
    case "F":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0.52 },
        { x: 0.78, y: 0.52 },
      ];
    case "G":
      return [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 0.58 },
        { x: 0.58, y: 0.58 },
      ];
    case "H":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0, y: 0.52 },
        { x: 1, y: 0.52 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ];
    case "I":
      return [
        { x: 0.08, y: 0 },
        { x: 0.92, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0.5, y: 1 },
        { x: 0.08, y: 1 },
        { x: 0.92, y: 1 },
      ];
    case "J":
      return [
        { x: 1, y: 0 },
        { x: 1, y: 0.82 },
        { x: 0.75, y: 1 },
        { x: 0.25, y: 1 },
        { x: 0, y: 0.82 },
      ];
    case "K":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0, y: 0.52 },
        { x: 0.55, y: 0.52 },
        { x: 0.55, y: 0 },
        { x: 1, y: 0 },
        { x: 0.55, y: 0 },
        { x: 0.55, y: 0.52 },
        { x: 0.55, y: 1 },
        { x: 0, y: 0.52 },
        { x: 1, y: 1 },
      ];
    case "L":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1.08, y: 1 },
      ];
    case "M":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0.5, y: 0.45 },
        { x: 1, y: 0.45 },
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
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ];
    case "P":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.96, y: 0 },
        { x: 0.96, y: 0.5 },
        { x: 0, y: 0.55 },
      ];
    case "R":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.96, y: 0 },
        { x: 0.96, y: 0.48 },
        { x: 0, y: 0.52 },
        { x: 0.58, y: 0.52 },
        { x: 1.08, y: 1 },
      ];
    case "S":
      return [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0.5 },
        { x: 1, y: 0.5 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
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
        { x: 0.25, y: 1 },
        { x: 0.75, y: 1 },
        { x: 1, y: 0.82 },
        { x: 1, y: 0 },
      ];
    case "V":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 0.7 },
        { x: 0.5, y: 1 },
        { x: 1, y: 0.7 },
        { x: 1, y: 0 },
      ];
    case "W":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0.5, y: 1 },
        { x: 0.5, y: 0.55 },
        { x: 1, y: 0.55 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
      ];
    case "X":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 0.45 },
        { x: 1, y: 0.45 },
        { x: 1, y: 0 },
        { x: 1, y: 0.45 },
        { x: 0, y: 0.45 },
        { x: 0, y: 1 },
        { x: 0, y: 0.55 },
        { x: 1, y: 0.55 },
        { x: 1, y: 0 },
      ];
    case "Y":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 0.45 },
        { x: 0.5, y: 0.45 },
        { x: 1, y: 0 },
        { x: 0.5, y: 0.45 },
        { x: 0.5, y: 1 },
      ];
    case "Z":
      return [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0.5 },
        { x: 0, y: 0.5 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ];
    default:
      return [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ];
  }
}

function wordmarkRawStrokePoints(word: string): ContourPoint[] {
  const letters = word
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8)
    .split("");
  const out: ContourPoint[] = [];
  const advance = 1.62;
  for (let i = 0; i < letters.length; i++) {
    const glyph = basicLetterStroke(letters[i]!).slice();
    const ox = i * advance;
    const first = glyph[0]!;
    if (Math.hypot(first.x, first.y - 1) > 0.01) {
      glyph.unshift({ x: 0, y: 1 });
    }
    const last = glyph[glyph.length - 1]!;
    if (Math.hypot(last.x - 1, last.y - 1) > 0.01) {
      glyph.push({ x: 1, y: 1 });
    }
    if (out.length > 0) {
      out.push({ x: ox, y: 1 });
    }
    for (const p of glyph) out.push({ x: ox + p.x, y: p.y });
  }
  // Glyphs are authored with y=0 at the TOP, but the anchor transform sends
  // larger y northward — so emitting them as-is drew every wordmark upside
  // down on the map. Flip once here, where both the wordmark and lockup
  // paths pick it up.
  return out.map((p) => ({ x: p.x, y: 4 - p.y }));
}

function cleanLetterStroke(letter: string): ContourPoint[] {
  switch (letter) {
    case "A":
      return [
        { x: 0, y: 1 },
        { x: 0.5, y: 0 },
        { x: 1, y: 1 },
        { x: 0.78, y: 0.56 },
        { x: 0.24, y: 0.56 },
        { x: 1, y: 1 },
      ];
    case "E":
      return [
        { x: 1, y: 1 },
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0.5 },
        { x: 0.82, y: 0.5 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ];
    case "H":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0, y: 0.52 },
        { x: 1, y: 0.52 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ];
    case "L":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 1.08, y: 1 },
      ];
    case "N":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ];
    case "P":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.96, y: 0 },
        { x: 0.96, y: 0.5 },
        { x: 0, y: 0.52 },
        { x: 0.62, y: 0.52 },
        { x: 1, y: 1 },
      ];
    case "R":
      return [
        { x: 0, y: 1 },
        { x: 0, y: 0 },
        { x: 0.96, y: 0 },
        { x: 0.96, y: 0.48 },
        { x: 0, y: 0.52 },
        { x: 0.58, y: 0.52 },
        { x: 1.08, y: 1 },
      ];
    case "U":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 0.82 },
        { x: 0.25, y: 1 },
        { x: 0.75, y: 1 },
        { x: 1, y: 0.82 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ];
    default:
      return basicLetterStroke(letter);
  }
}

function cleanWordmarkRawStrokePoints(word: string): ContourPoint[] {
  const letters = word
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8)
    .split("");
  const out: ContourPoint[] = [];
  const advance = 1.72;
  for (let i = 0; i < letters.length; i++) {
    const ox = i * advance;
    const glyph = cleanLetterStroke(letters[i]!).slice();
    const first = glyph[0]!;
    if (Math.hypot(first.x, first.y - 1) > 0.01) {
      glyph.unshift({ x: 0, y: 1 });
    }
    const last = glyph[glyph.length - 1]!;
    if (Math.hypot(last.x - 1, last.y - 1) > 0.12) {
      glyph.push({ x: 1, y: 1 });
    }
    if (out.length > 0) out.push({ x: ox, y: 1 });
    for (const p of glyph) out.push({ x: ox + p.x, y: p.y });
  }
  // Glyphs are authored with y=0 at the TOP, but the anchor transform sends
  // larger y northward — so emitting them as-is drew every wordmark upside
  // down on the map. Flip once here, where both the wordmark and lockup
  // paths pick it up.
  return out.map((p) => ({ x: p.x, y: 4 - p.y }));
}

function gridLetterStroke(letter: string): ContourPoint[] {
  switch (letter) {
    case "A":
      return [
        { x: 0, y: 3 },
        { x: 1, y: 0 },
        { x: 2, y: 3 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
        { x: 2, y: 3 },
      ];
    case "E":
      return [
        { x: 2, y: 3 },
        { x: 0, y: 3 },
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 1.5 },
        { x: 1.7, y: 1.5 },
        { x: 0, y: 3 },
        { x: 2, y: 3 },
      ];
    case "H":
      return [
        { x: 0, y: 3 },
        { x: 0, y: 0 },
        { x: 0, y: 1.5 },
        { x: 2, y: 1.5 },
        { x: 2, y: 0 },
        { x: 2, y: 3 },
      ];
    case "L":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 3 },
        { x: 2, y: 3 },
      ];
    case "N":
      return [
        { x: 0, y: 3 },
        { x: 0, y: 0 },
        { x: 2, y: 3 },
        { x: 2, y: 0 },
        { x: 2, y: 3 },
      ];
    case "P":
      return [
        { x: 0, y: 3 },
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1.5 },
        { x: 0, y: 1.5 },
        { x: 1.4, y: 1.5 },
        { x: 2, y: 3 },
      ];
    case "R":
      return [
        { x: 0, y: 3 },
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 1.5 },
        { x: 0, y: 1.5 },
        { x: 1.1, y: 1.5 },
        { x: 2.2, y: 3 },
      ];
    case "U":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 2.4 },
        { x: 0.5, y: 3 },
        { x: 1.5, y: 3 },
        { x: 2, y: 2.4 },
        { x: 2, y: 0 },
        { x: 2, y: 3 },
      ];
    default:
      return cleanLetterStroke(letter).map((p) => ({ x: p.x * 2, y: p.y * 3 }));
  }
}

function gridWordmarkRawStrokePoints(word: string): ContourPoint[] {
  const letters = word
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8)
    .split("");
  const out: ContourPoint[] = [];
  const advance = 3.2;
  for (let i = 0; i < letters.length; i++) {
    const ox = i * advance;
    const glyph = gridLetterStroke(letters[i]!).slice();
    const first = glyph[0]!;
    if (Math.hypot(first.x, first.y - 3) > 0.01) {
      glyph.unshift({ x: 0, y: 3 });
    }
    const last = glyph[glyph.length - 1]!;
    if (Math.hypot(last.x - 2, last.y - 3) > 0.12) {
      glyph.push({ x: 2, y: 3 });
    }
    if (out.length > 0) out.push({ x: ox, y: 3 });
    for (const p of glyph) out.push({ x: ox + p.x, y: p.y });
  }
  // Glyphs are authored with y=0 at the TOP, but the anchor transform sends
  // larger y northward — so emitting them as-is drew every wordmark upside
  // down on the map. Flip once here, where both the wordmark and lockup
  // paths pick it up.
  return out.map((p) => ({ x: p.x, y: 4 - p.y }));
}

/**
 * Single-stroke block letterforms on a 2.4 x 4 box (x left->right, y 0 at
 * the top). Each glyph is one continuous path; where a letterform needs a
 * stroke twice (crossbars, stems) it retraces its own ink, which is exactly
 * how these are run on the ground.
 *
 * Only nine letters used to be defined here — every other character fell
 * through to a crude fallback, so "JUST DO IT" rendered as illegible stubs
 * (about eight points per glyph). That is why the wordmark route could
 * never reproduce the reference lockup, no matter how large it was drawn.
 */
const BLOCK_LETTER_STROKES: Record<string, [number, number][]> = {
  A: [[0,4],[0,0],[2.4,0],[2.4,4],[2.4,2],[0,2]],
  B: [[0,4],[0,0],[2,0],[2,2],[0,2],[2.4,2],[2.4,4],[0,4]],
  C: [[2.4,0],[0,0],[0,4],[2.4,4]],
  D: [[0,4],[0,0],[1.8,0],[2.4,1],[2.4,3],[1.8,4],[0,4]],
  E: [[2.4,0],[0,0],[0,2],[1.8,2],[0,2],[0,4],[2.4,4]],
  F: [[2.4,0],[0,0],[0,2],[1.8,2],[0,2],[0,4]],
  G: [[2.4,0],[0,0],[0,4],[2.4,4],[2.4,2.4],[1.2,2.4]],
  H: [[0,0],[0,4],[0,2],[2.4,2],[2.4,0],[2.4,4]],
  I: [[0.4,0],[2,0],[1.2,0],[1.2,4],[0.4,4],[2,4]],
  J: [[0.4,0],[2.4,0],[1.6,0],[1.6,4],[0,4],[0,2.8]],
  K: [[0,0],[0,4],[0,2],[2.4,2],[2.4,0],[2.4,2],[2.4,4]],
  L: [[0,0],[0,4],[2.4,4]],
  M: [[0,4],[0,0],[1.2,0],[1.2,2],[1.2,0],[2.4,0],[2.4,4]],
  N: [[0,4],[0,0],[1.2,0],[1.2,2],[2.4,2],[2.4,0],[2.4,4]],
  O: [[0.6,0],[2.4,0],[2.4,4],[0,4],[0,0],[0.6,0]],
  P: [[0,4],[0,0],[2.4,0],[2.4,2],[0,2]],
  Q: [[0.6,0],[2.4,0],[2.4,4],[0,4],[0,0],[0.6,0],[1.4,2.6],[1.4,4],[2.4,4]],
  R: [[0,4],[0,0],[2.4,0],[2.4,2],[0,2],[1.4,2],[1.4,4],[2.4,4]],
  S: [[2.4,0],[0,0],[0,2],[2.4,2],[2.4,4],[0,4]],
  T: [[0,0],[2.4,0],[1.2,0],[1.2,4]],
  U: [[0,0],[0,4],[2.4,4],[2.4,0]],
  V: [[0,0],[0.6,4],[1.8,4],[2.4,0]],
  W: [[0,0],[0,4],[1.2,4],[1.2,1.6],[1.2,4],[2.4,4],[2.4,0]],
  X: [[0,0],[0,1.4],[2.4,2.6],[2.4,4],[2.4,2.6],[0,2.6],[0,4]],
  Y: [[0,0],[0,1.6],[1.2,1.6],[2.4,1.6],[2.4,0],[2.4,1.6],[1.2,1.6],[1.2,4]],
  Z: [[0,0],[2.4,0],[2.4,2],[0,2],[0,4],[2.4,4]],
};

/**
 * Force a glyph stroke to begin AND end on the baseline (y=4 in author
 * space) by retracing its own ink. The inter-letter travel slides along the
 * baseline and then rises vertically to the glyph's first point — for any
 * glyph that starts mid-air that vertical is NEW ink welded onto the
 * letterform (it turned S into a "9" and T into a gate). Retraced segments
 * overlap the glyph exactly, so they cost a little distance and zero
 * legibility.
 */
function baselineNormalizedGlyph(glyph: ContourPoint[]): ContourPoint[] {
  const atBase = (p: ContourPoint) => Math.abs(p.y - 4) < 0.01;
  if (glyph.length < 2) return glyph;
  let pts = glyph;
  if (!atBase(pts[0]!) && atBase(pts[pts.length - 1]!)) {
    pts = [...pts].reverse();
  }
  if (!pts.some(atBase)) return pts;
  if (!atBase(pts[pts.length - 1]!)) {
    const backtrack: ContourPoint[] = [];
    for (let i = pts.length - 2; i >= 0; i--) {
      backtrack.push(pts[i]!);
      if (atBase(pts[i]!)) break;
    }
    pts = [...pts, ...backtrack];
  }
  if (!atBase(pts[0]!)) {
    const lead: ContourPoint[] = [];
    for (let i = 1; i < pts.length; i++) {
      lead.push(pts[i]!);
      if (atBase(pts[i]!)) break;
    }
    pts = [...lead.reverse(), ...pts];
  }
  return pts;
}

function blockLetterStroke(letter: string): ContourPoint[] {
  const glyph = BLOCK_LETTER_STROKES[letter.toUpperCase()];
  if (glyph) {
    return baselineNormalizedGlyph(glyph.map(([x, y]) => ({ x, y })));
  }
  return baselineNormalizedGlyph(
    gridLetterStroke(letter).map((p) => ({
      x: p.x * 1.2,
      y: (p.y / 3) * 4,
    })),
  );
}

/**
 * Split a raw glyph polyline into its strokes at backtracks (glyphs like T
 * retrace along a bar to reach the stem — inflating across a reversal makes
 * a degenerate ring).
 */
function splitGlyphStrokes(glyph: ContourPoint[]): ContourPoint[][] {
  const strokes: ContourPoint[][] = [];
  let current: ContourPoint[] = [glyph[0]!];
  for (let i = 1; i < glyph.length; i++) {
    const p = glyph[i]!;
    const prev = glyph[i - 1]!;
    if (current.length >= 2) {
      const back = current[current.length - 2]!;
      const d1x = prev.x - back.x;
      const d1y = prev.y - back.y;
      const d2x = p.x - prev.x;
      const d2y = p.y - prev.y;
      const dot = d1x * d2x + d1y * d2y;
      const m1 = Math.hypot(d1x, d1y) || 1;
      const m2 = Math.hypot(d2x, d2y) || 1;
      if (dot / (m1 * m2) < -0.85) {
        strokes.push(current);
        current = [prev];
      }
    }
    current.push(p);
  }
  if (current.length >= 2) strokes.push(current);
  return strokes;
}

/**
 * Inflate a stroke polyline into a closed outline ring of the given half
 * width — the difference between hairline letters that vanish at map scale
 * and the fat outline letterforms of the reference JUST DO IT (nikegood):
 * every stroke becomes a band drawn around both rails.
 */
function inflateStrokeToRing(stroke: ContourPoint[], half: number): ContourPoint[] {
  const n = stroke.length;
  if (n < 2) return [];
  const normals: ContourPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = stroke[Math.max(0, i - 1)]!;
    const b = stroke[Math.min(n - 1, i + 1)]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const m = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / m, y: dx / m });
  }
  const left = stroke.map((p, i) => ({ x: p.x + normals[i]!.x * half, y: p.y + normals[i]!.y * half }));
  const right = stroke.map((p, i) => ({ x: p.x - normals[i]!.x * half, y: p.y - normals[i]!.y * half }));
  const ring = [...left, ...right.reverse()];
  ring.push({ ...ring[0]! });
  return ring;
}

/** Rotate a closed ring to start (and end) at its baseline-most vertex. */
function rotateRingToBaseline(ring: ContourPoint[]): ContourPoint[] {
  if (ring.length < 3) return ring;
  const open = ring.slice(0, -1);
  let best = 0;
  for (let i = 1; i < open.length; i++) {
    if (open[i]!.y > open[best]!.y + 1e-9) best = i;
  }
  const rotated = [...open.slice(best), ...open.slice(0, best)];
  rotated.push({ ...rotated[0]! });
  return rotated;
}

const LETTER_STROKE_HALF_WIDTH = 0.34;

/**
 * Multi-word STACKED layout — the arrangement of the reference sheet Ralph
 * holds up as the bar (nikegood.jpeg): "JUST" over "DO IT", real words with
 * their spaces, each row's letters twice the size a crammed single line
 * would allow. Words pack greedily into rows of at most `maxRowLetters`.
 */
function packWordsIntoRows(word: string, maxRowLetters = 5): string[][] {
  const words = word
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const rows: string[][] = [];
  let current: string[] = [];
  let letters = 0;
  for (const w of words) {
    if (current.length && letters + w.length > maxRowLetters) {
      rows.push(current);
      current = [];
      letters = 0;
    }
    current.push(w.slice(0, maxRowLetters));
    letters += w.length;
    if (rows.length === 3) break; // at most 3 text rows
  }
  if (current.length && rows.length < 3) rows.push(current);
  return rows;
}

function blockWordmarkRawStrokePoints(word: string): ContourPoint[] {
  const rows = packWordsIntoRows(word);
  if (!rows.length) return [];
  const out: ContourPoint[] = [];
  const advance = 3.55;
  const wordGap = 1.9; // extra space between words on the same row
  const rowHeight = 4;
  const rowGap = 1.8;

  const rowWidth = (row: string[]) =>
    row.reduce((s, w) => s + w.length * advance, 0) + (row.length - 1) * wordGap;
  const maxWidth = Math.max(...rows.map(rowWidth));

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const yOff = r * (rowHeight + rowGap); // author space: y grows downward
    const baseline = yOff + rowHeight;
    let ox = (maxWidth - rowWidth(row)) / 2; // center each row
    for (let w = 0; w < row.length; w++) {
      const letters = row[w]!.split("");
      for (const letter of letters) {
        const glyph = blockLetterStroke(letter);
        if (!glyph.length) {
          ox += advance;
          continue;
        }
        // OUTLINE letterforms: each glyph stroke inflated into a closed
        // band, drawn ring by ring. Rings start/end on their baseline-most
        // vertex, so travel is baseline hops — never welded through a form.
        // Dedupe strokes the baseline-normalization retraces duplicated —
        // inflating a stroke twice drew doubled, slightly offset outlines.
        const seenStrokes = new Set<string>();
        const strokes = splitGlyphStrokes(glyph).filter((s) => {
          const a = s[0]!;
          const b = s[s.length - 1]!;
          const f = `${a.x.toFixed(2)},${a.y.toFixed(2)}-${b.x.toFixed(2)},${b.y.toFixed(2)}`;
          const r = `${b.x.toFixed(2)},${b.y.toFixed(2)}-${a.x.toFixed(2)},${a.y.toFixed(2)}`;
          if (seenStrokes.has(f) || seenStrokes.has(r)) return false;
          seenStrokes.add(f);
          return true;
        });
        const rings = strokes
          .map((s) => inflateStrokeToRing(s, LETTER_STROKE_HALF_WIDTH))
          .filter((ring) => ring.length >= 4)
          .map(rotateRingToBaseline);
        for (const ring of rings) {
          if (out.length > 0) {
            const prev = out[out.length - 1]!;
            const entry = { x: ox + ring[0]!.x, y: yOff + ring[0]!.y };
            const rowChange = Math.abs(prev.y - baseline) > rowHeight * 0.75;
            if (rowChange) {
              // travel between text rows around the RIGHT EDGE of the block
              // — a straight drop at prev.x would slash through the lower
              // row's letterforms.
              const edgeX = maxWidth + 1.4;
              out.push({ x: edgeX, y: prev.y });
              out.push({ x: edgeX, y: baseline });
              out.push({ x: entry.x, y: baseline });
            } else if (
              Math.abs(prev.y - baseline) > 0.6 ||
              Math.abs(entry.y - baseline) > 0.6
            ) {
              // same row: hop via the baseline
              out.push({ x: prev.x, y: baseline });
              out.push({ x: entry.x, y: baseline });
            }
          }
          for (const p of ring) out.push({ x: ox + p.x, y: yOff + p.y });
        }
        ox += advance;
      }
      ox += wordGap;
    }
  }
  // Glyphs are authored with y=0 at the TOP, but the anchor transform sends
  // larger y northward — so emitting them as-is drew every wordmark upside
  // down on the map. Flip once here, where both the wordmark and lockup
  // paths pick it up.
  const totalH = rows.length * rowHeight + (rows.length - 1) * rowGap;
  return out.map((p) => ({ x: p.x, y: totalH - p.y }));
}

function gridWalkWordmarkPoints(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 2) return points;
  const out: ContourPoint[] = [points[0]!];
  let preferHorizontal = true;

  const push = (p: ContourPoint) => {
    const prev = out[out.length - 1]!;
    if (Math.hypot(prev.x - p.x, prev.y - p.y) > 0.01) {
      out.push(p);
    }
  };

  for (let i = 1; i < points.length; i++) {
    const from = out[out.length - 1]!;
    const to = points[i]!;
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);

    if (dx > 0.01 && dy > 0.01) {
      const elbow = preferHorizontal
        ? { x: to.x, y: from.y }
        : { x: from.x, y: to.y };
      push(elbow);
      preferHorizontal = !preferHorizontal;
    }
    push(to);
  }

  return out;
}

function localGridPolylineLengthMeters(
  points: ContourPoint[],
  xStepMeters: number,
  yStepMeters: number,
): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    d += Math.hypot(
      (b.x - a.x) * xStepMeters,
      (b.y - a.y) * yStepMeters,
    );
  }
  return d;
}

function localPolylineLength(points: ContourPoint[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    d += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return d;
}

function turnStrength(
  prev: ContourPoint,
  cur: ContourPoint,
  next: ContourPoint,
): number {
  const ax = prev.x - cur.x;
  const ay = prev.y - cur.y;
  const bx = next.x - cur.x;
  const by = next.y - cur.y;
  const al = Math.hypot(ax, ay);
  const bl = Math.hypot(bx, by);
  if (al < 1e-6 || bl < 1e-6) return 0;
  const dot = (ax * bx + ay * by) / (al * bl);
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  return Math.abs(Math.PI - angle);
}

export function boldSketchPoints(
  points: ContourPoint[],
  maxPoints = 14,
): ContourPoint[] {
  if (points.length <= maxPoints) return points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const closed = Math.hypot(first.x - last.x, first.y - last.y) < 0.04;
  const keep = new Set<number>([0, points.length - 1]);
  const turns = points
    .slice(1, -1)
    .map((p, offset) => ({
      idx: offset + 1,
      score: turnStrength(points[offset]!, p, points[offset + 2]!),
    }))
    .sort((a, b) => b.score - a.score);

  for (const t of turns) {
    if (keep.size >= maxPoints - (closed ? 1 : 0)) break;
    if (t.score <= 0.08) continue;
    keep.add(t.idx);
  }

  if (keep.size < Math.min(maxPoints, 6)) {
    const stride = (points.length - 1) / (Math.min(maxPoints, points.length) - 1);
    for (let i = 1; i < maxPoints - 1; i++) {
      keep.add(Math.round(i * stride));
    }
  }

  const out = [...keep]
    .sort((a, b) => a - b)
    .map((idx) => points[idx]!)
    .filter((p, idx, arr) => {
      const prev = arr[idx - 1];
      return !prev || Math.hypot(prev.x - p.x, prev.y - p.y) > 0.015;
    });
  if (closed && out.length >= 3) {
    const start = out[0]!;
    const end = out[out.length - 1]!;
    if (Math.hypot(start.x - end.x, start.y - end.y) > 0.04) {
      out.push(start);
    }
  }
  return out.length >= 2 ? out : points;
}

function gridEtchSketchPoints(
  points: ContourPoint[],
  firstAxis: "x" | "y",
  maxPoints = 22,
): ContourPoint[] {
  const base = boldSketchPoints(points, Math.max(8, Math.floor(maxPoints / 2)));
  if (base.length < 2) return base;
  const out: ContourPoint[] = [base[0]!];
  let axis = firstAxis;

  for (let i = 1; i < base.length; i++) {
    const from = out[out.length - 1]!;
    const to = base[i]!;
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    if (dx > 0.035 && dy > 0.035) {
      const elbow =
        axis === "x"
          ? { x: to.x, y: from.y }
          : { x: from.x, y: to.y };
      if (Math.hypot(elbow.x - from.x, elbow.y - from.y) > 0.02) {
        out.push(elbow);
      }
      axis = axis === "x" ? "y" : "x";
    }
    if (Math.hypot(to.x - out[out.length - 1]!.x, to.y - out[out.length - 1]!.y) > 0.02) {
      out.push(to);
    }
  }

  const first = out[0]!;
  const last = out[out.length - 1]!;
  const sourceFirst = base[0]!;
  const sourceLast = base[base.length - 1]!;
  const sourceClosed =
    Math.hypot(sourceFirst.x - sourceLast.x, sourceFirst.y - sourceLast.y) < 0.04;
  if (sourceClosed && Math.hypot(first.x - last.x, first.y - last.y) > 0.04) {
    if (Math.abs(first.x - last.x) > 0.035 && Math.abs(first.y - last.y) > 0.035) {
      out.push(firstAxis === "x" ? { x: first.x, y: last.y } : { x: last.x, y: first.y });
    }
    out.push(first);
  }

  return out.slice(0, maxPoints);
}

function streetDraftVariants(
  draft: MapNativeDesignDraft,
): MapNativeDesignDraft[] {
  const bold = boldSketchPoints(draft.points);
  const variants: MapNativeDesignDraft[] =
    bold.length >= draft.points.length - 1
      ? [draft]
      : [
          {
            ...draft,
            label: `Bold ${draft.label}`.slice(0, 40),
            description:
              `Fewer long map-native strokes: ${draft.description}`.slice(0, 180),
            points: bold,
            designScore: draft.designScore + 3,
          },
          draft,
        ];
  const etchedX = gridEtchSketchPoints(draft.points, "x");
  const etchedY = gridEtchSketchPoints(draft.points, "y");
  if (etchedX.length >= 3) {
    variants.unshift({
      ...draft,
      label: `Grid-etched ${draft.label}`.slice(0, 40),
      description:
        `Etch-a-sketch street-grid version with deliberate avenue/street turns: ${draft.description}`.slice(
          0,
          180,
        ),
      visualFeatures: [
        ...(draft.visualFeatures ?? []),
        "street grid",
        "readable outline",
        "runnable turns",
      ],
      points: etchedX,
      designScore: draft.designScore + 5,
    });
  }
  if (etchedY.length >= 3 && JSON.stringify(etchedY) !== JSON.stringify(etchedX)) {
    variants.unshift({
      ...draft,
      label: `Alt grid-etched ${draft.label}`.slice(0, 40),
      description:
        `Alternate etch-a-sketch street-grid version with the opposite first turn: ${draft.description}`.slice(
          0,
          180,
        ),
      visualFeatures: [
        ...(draft.visualFeatures ?? []),
        "street grid",
        "readable outline",
        "runnable turns",
      ],
      points: etchedY,
      designScore: draft.designScore + 4,
    });
  }

  if (isSweepingCurveDraft(draft)) {
    const needsTaperedOutline = isTaperedOutlineDraft(draft);
    variants.unshift(
      {
        ...draft,
        label: `Ribbon sweep ${draft.label}`.slice(0, 40),
        description:
          `Long low ribbon sweep with a sharp rising tip, designed to read as a mark instead of a vertical zigzag: ${draft.description}`.slice(
            0,
            180,
          ),
        visualFeatures: [
          ...(draft.visualFeatures ?? []),
          "ribbon sweep",
          "long curve",
          "sharp tip",
        ].slice(0, 8),
        points: ribbonSweepPoints(),
        designScore: draft.designScore + 12,
      },
    );
    if (!needsTaperedOutline) {
      variants.unshift(
      {
        ...draft,
        label: `Street sweep ${draft.label}`.slice(0, 40),
        description:
          `Map-native sweeping curve with a long diagonal body and rising tail: ${draft.description}`.slice(
            0,
            180,
          ),
        visualFeatures: [
          ...(draft.visualFeatures ?? []),
          "sweeping curve",
          "diagonal body",
          "rising tail",
        ].slice(0, 8),
        points: sweepingCurvePoints(),
        designScore: draft.designScore + 8,
      },
      {
        ...draft,
        label: `Broad sweep ${draft.label}`.slice(0, 40),
        description:
          `Broad street-scale arc that favors recognizable curve direction over tracing tiny outline detail: ${draft.description}`.slice(
            0,
            180,
          ),
        visualFeatures: [
          ...(draft.visualFeatures ?? []),
          "broad arc",
          "curve",
          "tail",
        ].slice(0, 8),
        points: broadArcPoints(),
        designScore: draft.designScore + 5,
      },
      );
    }
  }

  return variants;
}

function isSweepingCurveDraft(draft: MapNativeDesignDraft): boolean {
  const text =
    `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`.toLowerCase();
  return /\b(curve|curved|arc|sweep|sweeping|tail|wing|ribbon|wave|diagonal|slash|checkmark|check-mark|hook|swoosh)\b/.test(
    text,
  );
}

function isTaperedOutlineDraft(draft: MapNativeDesignDraft): boolean {
  const text =
    `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`.toLowerCase();
  return /\b(taper|tapered|outline|wide heel|broad heel|curved belly|thin rising tip)\b/.test(
    text,
  );
}

function isBoltDraft(draft: MapNativeDesignDraft): boolean {
  const text =
    `${draft.label} ${draft.description} ${(draft.visualFeatures ?? []).join(" ")}`.toLowerCase();
  return /\b(lightning|bolt|thunderbolt|zigzag|zig-zag|middle notch|pointed bottom)\b/.test(
    text,
  );
}

function sweepingCurvePoints(): ContourPoint[] {
  return [
    { x: 0.04, y: 0.74 },
    { x: 0.2, y: 0.72 },
    { x: 0.4, y: 0.62 },
    { x: 0.62, y: 0.46 },
    { x: 0.86, y: 0.22 },
    { x: 0.98, y: 0.1 },
    { x: 0.9, y: 0.24 },
    { x: 0.72, y: 0.44 },
    { x: 0.5, y: 0.62 },
    { x: 0.28, y: 0.74 },
    { x: 0.08, y: 0.78 },
  ];
}

function ribbonSweepPoints(): ContourPoint[] {
  return [
    { x: 0.03, y: 0.64 },
    { x: 0.18, y: 0.62 },
    { x: 0.36, y: 0.56 },
    { x: 0.56, y: 0.44 },
    { x: 0.78, y: 0.26 },
    { x: 0.99, y: 0.08 },
    { x: 0.91, y: 0.2 },
    { x: 0.72, y: 0.38 },
    { x: 0.5, y: 0.54 },
    { x: 0.28, y: 0.64 },
    { x: 0.08, y: 0.68 },
    { x: 0.03, y: 0.64 },
  ];
}

function broadArcPoints(): ContourPoint[] {
  return [
    { x: 0.05, y: 0.68 },
    { x: 0.24, y: 0.72 },
    { x: 0.46, y: 0.66 },
    { x: 0.68, y: 0.48 },
    { x: 0.9, y: 0.24 },
    { x: 0.98, y: 0.14 },
    { x: 0.78, y: 0.34 },
    { x: 0.56, y: 0.52 },
    { x: 0.32, y: 0.64 },
    { x: 0.12, y: 0.66 },
  ];
}

function manhattanRibbonSweepAnchors(
  recipe: {
    start: [number, number];
    upper: [number, number][];
    lower: [number, number][];
  },
): [number, number][] {
  return [recipe.start, ...recipe.upper, ...recipe.lower, recipe.start];
}

function manhattanRibbonSweepCandidates(
  draft: MapNativeDesignDraft,
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  if (preset.id !== "manhattan") return [];
  const recipes: Array<{
    start: [number, number];
    upper: [number, number][];
    lower: [number, number][];
    rotation: number;
    scale: number;
    label: string;
  }> = [
    {
      label: "lower-to-midtown",
      start: [40.714, -74.006],
      upper: [
        [40.724, -74.001],
        [40.739, -73.993],
        [40.758, -73.982],
        [40.778, -73.972],
      ],
      lower: [
        [40.766, -73.975],
        [40.746, -73.986],
        [40.727, -74.000],
      ],
      rotation: 34,
      scale: 1.3,
    },
    {
      label: "chelsea-to-upper-east",
      start: [40.735, -74.004],
      upper: [
        [40.744, -73.997],
        [40.758, -73.988],
        [40.776, -73.978],
        [40.796, -73.971],
      ],
      lower: [
        [40.783, -73.974],
        [40.764, -73.986],
        [40.746, -73.998],
      ],
      rotation: 32,
      scale: 1.15,
    },
    {
      label: "soho-to-midtown",
      start: [40.721, -74.005],
      upper: [
        [40.729, -74.000],
        [40.743, -73.991],
        [40.761, -73.981],
        [40.780, -73.972],
      ],
      lower: [
        [40.768, -73.976],
        [40.748, -73.988],
        [40.731, -73.999],
      ],
      rotation: 35,
      scale: 1.2,
    },
    {
      label: "flat-crosstown",
      start: [40.735, -74.006],
      upper: [
        [40.740, -73.999],
        [40.748, -73.989],
        [40.759, -73.980],
        [40.772, -73.972],
      ],
      lower: [
        [40.765, -73.976],
        [40.751, -73.988],
        [40.739, -73.999],
      ],
      rotation: 25,
      scale: 1.1,
    },
  ];

  const out: MapNativeCandidate[] = [];
  for (const recipe of recipes) {
    const anchors = manhattanRibbonSweepAnchors(recipe);
    if (!candidateStaysInBounds(anchors, preset)) continue;
    const km = routeLengthKm(anchors);
    if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) continue;
    if (
      targetDistanceKm != null &&
      Number.isFinite(targetDistanceKm) &&
      (km < targetDistanceKm * 0.55 || km > targetDistanceKm * 1.85)
    ) {
      continue;
    }
    out.push({
      placement: placementFromAnchors(anchors, recipe.rotation, recipe.scale),
      anchors,
      km,
      designIntent: `Manhattan corridor ribbon sweep (${recipe.label}) for ${draft.label}: broad low curve, belly, and rising tip. Features: ${(draft.visualFeatures ?? []).join(", ")}, ribbon sweep, long curve, sharp tip.`,
      kind: "street-design",
    });
  }
  return out;
}

function manhattanTaperedSwooshCandidates(
  draft: MapNativeDesignDraft,
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  if (preset.id !== "manhattan") return [];
  const recipes: Array<{
    label: string;
    anchors: [number, number][];
    rotation: number;
    scale: number;
  }> = [
    {
      label: "lower-manhattan-taper",
      anchors: [
        [40.724, -74.006],
        [40.727, -73.999],
        [40.734, -73.990],
        [40.746, -73.980],
        [40.760, -73.971],
        [40.752, -73.975],
        [40.738, -73.986],
        [40.727, -73.998],
        [40.724, -74.006],
      ],
      rotation: 32,
      scale: 1.15,
    },
    {
      label: "village-flat-taper",
      anchors: [
        [40.731, -74.006],
        [40.733, -73.999],
        [40.741, -73.989],
        [40.754, -73.978],
        [40.768, -73.971],
        [40.759, -73.974],
        [40.745, -73.984],
        [40.734, -73.997],
        [40.731, -74.006],
      ],
      rotation: 31,
      scale: 1.12,
    },
    {
      label: "chelsea-long-taper",
      anchors: [
        [40.741, -74.006],
        [40.744, -73.997],
        [40.752, -73.988],
        [40.766, -73.978],
        [40.782, -73.971],
        [40.771, -73.974],
        [40.756, -73.984],
        [40.745, -73.997],
        [40.741, -74.006],
      ],
      rotation: 31,
      scale: 1.1,
    },
  ];

  const out: MapNativeCandidate[] = [];
  for (const recipe of recipes) {
    if (!candidateStaysInBounds(recipe.anchors, preset)) continue;
    const km = routeLengthKm(recipe.anchors);
    if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) continue;
    if (
      targetDistanceKm != null &&
      Number.isFinite(targetDistanceKm) &&
      (km < targetDistanceKm * 0.6 || km > targetDistanceKm * 1.85)
    ) {
      continue;
    }
    out.push({
      placement: placementFromAnchors(recipe.anchors, recipe.rotation, recipe.scale),
      anchors: recipe.anchors,
      km,
      designIntent: `Human-grade Manhattan tapered swoosh outline (${recipe.label}) for ${draft.label}: wide heel, thin rising tip, and two close edges so it reads as a Nike-style swoosh rather than a plain line. Features: ${(draft.visualFeatures ?? []).join(", ")}, swoosh, tapered outline, curve, rising tail.`,
      kind: "street-design",
    });
  }
  return out;
}

function manhattanBoltCandidates(
  draft: MapNativeDesignDraft,
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  if (preset.id !== "manhattan") return [];
  const recipes: Array<{
    label: string;
    anchors: [number, number][];
    rotation: number;
    scale: number;
  }> = [
    {
      label: "soho-readable-zigzag",
      anchors: [
        [40.741, -73.996],
        [40.731, -74.006],
        [40.733, -73.993],
        [40.717, -74.000],
        [40.729, -73.982],
        [40.715, -73.991],
      ],
      rotation: 23,
      scale: 0.96,
    },
    {
      label: "chelsea-zigzag",
      anchors: [
        [40.768, -73.977],
        [40.751, -74.000],
        [40.755, -73.981],
        [40.733, -74.006],
        [40.744, -73.972],
        [40.722, -73.992],
      ],
      rotation: 18,
      scale: 1.05,
    },
    {
      label: "village-bolt",
      anchors: [
        [40.748, -73.981],
        [40.733, -74.004],
        [40.736, -73.986],
        [40.718, -74.008],
        [40.731, -73.976],
        [40.711, -73.993],
      ],
      rotation: 20,
      scale: 1,
    },
    {
      label: "midtown-notch",
      anchors: [
        [40.779, -73.971],
        [40.760, -73.996],
        [40.764, -73.976],
        [40.742, -74.001],
        [40.755, -73.966],
        [40.735, -73.985],
      ],
      rotation: 18,
      scale: 1.08,
    },
  ];

  const out: MapNativeCandidate[] = [];
  for (const recipe of recipes) {
    if (!candidateStaysInBounds(recipe.anchors, preset)) continue;
    const km = routeLengthKm(recipe.anchors);
    if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) continue;
    if (
      targetDistanceKm != null &&
      Number.isFinite(targetDistanceKm) &&
      (km < targetDistanceKm * 0.55 || km > targetDistanceKm * 1.75)
    ) {
      continue;
    }
    out.push({
      placement: placementFromAnchors(recipe.anchors, recipe.rotation, recipe.scale),
      anchors: recipe.anchors,
      km,
      designIntent: `Human-grade Manhattan lightning bolt (${recipe.label}) for ${draft.label}: sharp top, middle notch, lower zigzag, and pointed bottom on walkable streets. Features: ${(draft.visualFeatures ?? []).join(", ")}, bolt, zigzag, middle notch, pointed bottom.`,
      kind: "street-design",
    });
  }
  return out;
}

function manhattanOpenSweepCandidates(
  draft: MapNativeDesignDraft,
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  if (preset.id !== "manhattan") return [];
  const recipes: Array<{
    label: string;
    anchors: [number, number][];
    rotation: number;
    scale: number;
  }> = [
    {
      label: "short-logo-check",
      anchors: [
        [40.738, -74.003],
        [40.732, -73.997],
        [40.741, -73.988],
        [40.755, -73.979],
        [40.769, -73.972],
      ],
      rotation: 31,
      scale: 1,
    },
    {
      label: "chelsea-hook-check",
      anchors: [
        [40.745, -74.006],
        [40.738, -73.999],
        [40.736, -73.991],
        [40.748, -73.981],
        [40.768, -73.971],
      ],
      rotation: 31,
      scale: 1,
    },
    {
      label: "flat-logo-swoosh",
      anchors: [
        [40.732, -74.006],
        [40.728, -73.999],
        [40.734, -73.991],
        [40.749, -73.981],
        [40.771, -73.971],
      ],
      rotation: 31,
      scale: 1,
    },
    {
      label: "compact-village-belly",
      anchors: [
        [40.733, -74.006],
        [40.727, -74.000],
        [40.724, -73.994],
        [40.727, -73.988],
        [40.735, -73.982],
        [40.746, -73.976],
      ],
      rotation: 119,
      scale: 1,
    },
    {
      label: "compact-downtown-check",
      anchors: [
        [40.721, -74.006],
        [40.716, -74.000],
        [40.714, -73.994],
        [40.720, -73.987],
        [40.730, -73.981],
        [40.742, -73.976],
      ],
      rotation: 119,
      scale: 1,
    },
    {
      label: "chelsea-belly-rising-tail",
      anchors: [
        [40.746, -74.006],
        [40.738, -73.999],
        [40.731, -73.990],
        [40.734, -73.982],
        [40.746, -73.975],
        [40.764, -73.971],
      ],
      rotation: 119,
      scale: 1.18,
    },
    {
      label: "village-check-sweep",
      anchors: [
        [40.736, -74.006],
        [40.729, -73.998],
        [40.724, -73.990],
        [40.733, -73.982],
        [40.747, -73.975],
        [40.760, -73.971],
      ],
      rotation: 119,
      scale: 1.12,
    },
    {
      label: "midtown-hooked-tail",
      anchors: [
        [40.752, -74.004],
        [40.743, -73.997],
        [40.737, -73.989],
        [40.742, -73.981],
        [40.755, -73.974],
        [40.771, -73.971],
      ],
      rotation: 119,
      scale: 1.15,
    },
    {
      label: "west-village-to-midtown",
      anchors: [
        [40.732, -74.005],
        [40.735, -73.996],
        [40.740, -73.989],
        [40.749, -73.982],
        [40.761, -73.974],
        [40.772, -73.971],
      ],
      rotation: 32,
      scale: 1.05,
    },
    {
      label: "chelsea-rising-tip",
      anchors: [
        [40.741, -74.004],
        [40.739, -73.996],
        [40.742, -73.988],
        [40.751, -73.981],
        [40.764, -73.973],
        [40.782, -73.971],
      ],
      rotation: 31,
      scale: 1.1,
    },
    {
      label: "downtown-low-sweep",
      anchors: [
        [40.712, -74.006],
        [40.716, -74.002],
        [40.722, -73.996],
        [40.731, -73.989],
        [40.744, -73.982],
        [40.758, -73.974],
      ],
      rotation: 34,
      scale: 1.08,
    },
    {
      label: "flat-checkmark",
      anchors: [
        [40.734, -74.004],
        [40.738, -73.996],
        [40.735, -73.988],
        [40.744, -73.982],
        [40.758, -73.974],
        [40.776, -73.971],
      ],
      rotation: 29,
      scale: 1,
    },
  ];

  const out: MapNativeCandidate[] = [];
  for (const recipe of recipes) {
    if (!candidateStaysInBounds(recipe.anchors, preset)) continue;
    const km = routeLengthKm(recipe.anchors);
    if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) continue;
    if (
      targetDistanceKm != null &&
      Number.isFinite(targetDistanceKm) &&
      (km < targetDistanceKm * 0.45 || km > targetDistanceKm * 1.65)
    ) {
      continue;
    }
    out.push({
      placement: placementFromAnchors(recipe.anchors, recipe.rotation, recipe.scale),
      anchors: recipe.anchors,
      km,
      designIntent: `Human-grade Manhattan open sweep (${recipe.label}) for ${draft.label}: one clean rising curve with a low belly and sharp tip. Features: ${(draft.visualFeatures ?? []).join(", ")}, swoosh, curve, rising tail, checkmark.`,
      kind: "street-design",
    });
  }
  return out;
}

function streetWordmarkAnchors(
  raw: ContourPoint[],
  center: [number, number],
  xStepMeters: number,
  yStepMeters: number,
  xBearingDeg: number,
): [number, number][] {
  if (raw.length < 2) return [];

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
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const xAxis = bearingUnitVector(xBearingDeg);
  // +y must point NORTH of the +x reading direction, or every wordmark draws
  // upside-down on the map. For the crosstown bearings this module uses
  // (~101-118°, reading west→east), that is bearing MINUS 90 (≈11-28°, NNE).
  // bearing+90 pointed SSW, which flipped glyph tops southward — the letters
  // were composed correctly but rendered inverted on every candidate.
  const yAxis = bearingUnitVector(xBearingDeg - 90);

  return raw.map((p) => {
    const localX = (p.x - cx) * xStepMeters;
    const localY = (p.y - cy) * yStepMeters;
    const east = localX * xAxis.east + localY * yAxis.east;
    const north = localX * xAxis.north + localY * yAxis.north;
    return offsetLatLngMeters(center, east, north);
  });
}

function candidateStaysInBounds(
  anchors: [number, number][],
  preset: CityPreset,
  margin: number = MARGIN,
): boolean {
  const b = preset.searchBounds;
  const innerS = b.south + margin;
  const innerN = b.north - margin;
  const innerW = b.west + margin;
  const innerE = b.east - margin;
  return anchors.every(
    ([lat, lng]) =>
      lat >= innerS && lat <= innerN && lng >= innerW && lng <= innerE,
  );
}

function draftSearchText(drafts: MapNativeDesignDraft[]): string {
  return drafts
    .flatMap((draft) => [
      draft.label,
      draft.description,
      ...(draft.visualFeatures ?? []),
    ])
    .join(" ")
    .toLowerCase();
}

export function isGasLogoDraftSet(drafts: MapNativeDesignDraft[]): boolean {
  const text = draftSearchText(drafts);
  return (
    /\b(gas|pump|fuel|nozzle)\b/.test(text) &&
    /\b(person|human|figure|head|body|legs|headphones|hose)\b/.test(text)
  );
}

/** Etch-a-sketch pump + hose + headphone person as Manhattan grid strokes. */
function gasPumpGridStrokePoints(): ContourPoint[] {
  const raw: ContourPoint[] = [
    { x: 0.1, y: 0.9 },
    { x: 0.1, y: 0.14 },
    { x: 0.36, y: 0.14 },
    { x: 0.36, y: 0.5 },
    { x: 0.14, y: 0.2 },
    { x: 0.32, y: 0.2 },
    { x: 0.32, y: 0.34 },
    { x: 0.14, y: 0.34 },
    { x: 0.14, y: 0.2 },
    { x: 0.36, y: 0.5 },
    { x: 0.36, y: 0.9 },
    { x: 0.1, y: 0.9 },
    { x: 0.36, y: 0.54 },
    { x: 0.44, y: 0.54 },
    { x: 0.44, y: 0.68 },
    { x: 0.52, y: 0.72 },
    { x: 0.64, y: 0.24 },
    { x: 0.72, y: 0.18 },
    { x: 0.8, y: 0.24 },
    { x: 0.8, y: 0.34 },
    { x: 0.72, y: 0.4 },
    { x: 0.64, y: 0.34 },
    { x: 0.64, y: 0.24 },
    { x: 0.72, y: 0.4 },
    { x: 0.72, y: 0.56 },
    { x: 0.66, y: 0.56 },
    { x: 0.66, y: 0.88 },
    { x: 0.72, y: 0.56 },
    { x: 0.78, y: 0.56 },
    { x: 0.78, y: 0.88 },
    { x: 0.72, y: 0.48 },
    { x: 0.8, y: 0.36 },
    { x: 0.86, y: 0.26 },
  ];
  return gridWalkWordmarkPoints(raw);
}

export function streetGasLogoCandidates(
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  if (preset.id !== "manhattan") return [];

  const families = [
    {
      id: "chelsea-gas-icon",
      points: gasPumpGridStrokePoints(),
      xStepMeters: 480,
      yStepMeters: 300,
      intent:
        "blocky pump body, display window, hose loop, headphone head, torso, split legs, and raised nozzle arm",
    },
    {
      id: "ev-gas-icon-wide",
      points: gasPumpGridStrokePoints(),
      xStepMeters: 540,
      yStepMeters: 280,
      intent:
        "wider etch-a-sketch gas logo with clearer separation between pump and person",
    },
    {
      id: "midtown-gas-icon-tall",
      points: gasPumpGridStrokePoints(),
      xStepMeters: 420,
      yStepMeters: 340,
      intent:
        "taller pump + person silhouette for a more readable Strava thumbnail",
    },
  ];

  const targetKm =
    targetDistanceKm != null && Number.isFinite(targetDistanceKm)
      ? targetDistanceKm
      : 10;
  const centers: [number, number][] = [
    [40.724, -73.996],
    [40.728, -73.992],
    [40.732, -73.988],
    [40.738, -73.987],
    [40.742, -73.993],
    [40.748, -73.986],
  ];
  const bearings = [101, 107, 112, 118];
  const out: MapNativeCandidate[] = [];

  for (const family of families) {
    const baseMeters = localGridPolylineLengthMeters(
      family.points,
      family.xStepMeters,
      family.yStepMeters,
    );
    if (baseMeters <= 0) continue;
    const distanceScale = Math.max(
      1.55,
      Math.min(2.9, (targetKm * 1050) / baseMeters),
    );
    for (const center of centers) {
      for (const bearing of bearings) {
        for (const m of [
          distanceScale,
          distanceScale * 0.88,
          distanceScale * 1.06,
          distanceScale * 1.18,
        ]) {
          const anchors = streetWordmarkAnchors(
            family.points,
            center,
            family.xStepMeters * m,
            family.yStepMeters * m,
            bearing,
          );
          if (
            anchors.length < 2 ||
            !candidateStaysInBounds(anchors, preset)
          ) {
            continue;
          }
          const km = routeLengthKm(anchors);
          if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) continue;
          if (
            targetDistanceKm != null &&
            Number.isFinite(targetDistanceKm) &&
            (km < targetDistanceKm * 0.7 || km > targetDistanceKm * 1.75)
          ) {
            continue;
          }
          out.push({
            placement: sourceAlignedPlacementFromAnchors(anchors, bearing),
            anchors,
            km,
            designIntent: `Human-grade Manhattan gas logo (${family.id}): ${family.intent}. Features: pump, window, hose loop, headphones, person, body, legs, nozzle.`,
            kind: "street-design",
            routeMode: "direct-grid",
          });
        }
      }
    }
  }

  return diverseSubsample(out, Math.min(28, out.length), preset);
}

function targetAllowsKm(km: number, targetDistanceKm?: number): boolean {
  if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) return false;
  if (targetDistanceKm == null || !Number.isFinite(targetDistanceKm)) {
    return true;
  }
  return km >= targetDistanceKm * 0.55 && km <= targetDistanceKm * 1.85;
}

function routeLibraryCandidate({
  label,
  anchors,
  rotationDeg,
  scale,
  tags,
  preset,
  targetDistanceKm,
}: {
  label: string;
  anchors: [number, number][];
  rotationDeg: number;
  scale: number;
  tags: string[];
  preset: CityPreset;
  targetDistanceKm?: number;
}): MapNativeCandidate | null {
  if (!candidateStaysInBounds(anchors, preset)) return null;
  const km = routeLengthKm(anchors);
  if (!targetAllowsKm(km, targetDistanceKm)) return null;
  return {
    placement: placementFromAnchors(anchors, rotationDeg, scale),
    anchors,
    km,
    designIntent: `Route-library Manhattan ${label}: real-street-first primitive built from Manhattan avenues, crosstown streets, Broadway-like diagonals, park edges, and waterfront constraints. Features: ${tags.join(", ")}.`,
    kind: "street-design",
  };
}

function verifiedRouteAllowsKm(
  km: number,
  targetDistanceKm?: number,
): boolean {
  if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) return false;
  if (targetDistanceKm == null || !Number.isFinite(targetDistanceKm)) {
    return true;
  }
  return km >= targetDistanceKm * 0.35 && km <= targetDistanceKm * 2.4;
}

function curatedRunTags(run: CuratedRun): string[] {
  switch (run.id) {
    case "chelsea-turtle":
      return ["turtle", "shell", "legs", "head", "tail", "animal"];
    case "chelsea-robot":
      return ["robot", "head", "antenna", "visor", "mouth", "face"];
    case "midtown-sailboat":
      return ["sailboat", "boat", "hull", "mast", "mainsail", "jib"];
    case "east-village-tulip":
      return ["tulip", "flower", "petals", "stem", "leaves"];
    case "les-duck":
      return ["duck", "bird", "beak", "head", "body", "tail"];
    case "les-heart":
      return ["heart", "love", "lobes", "bottom point"];
    default:
      return [run.title.toLowerCase()];
  }
}

function textMatchesCuratedRun(text: string, run: CuratedRun): boolean {
  switch (run.id) {
    case "chelsea-turtle":
      return /\b(turtle|tortoise|shell|reptile)\b/.test(text);
    case "chelsea-robot":
      return /\b(robot|android|bot|antenna|visor)\b/.test(text);
    case "midtown-sailboat":
      return /\b(sailboat|sail boat|sailing|sail|boat|yacht|ship)\b/.test(text);
    case "east-village-tulip":
      return /\b(tulip|flower|floral|petal|petals|stem|plant)\b/.test(text);
    case "les-duck":
      return /\b(duck|duckling|bird|beak)\b/.test(text);
    case "les-heart":
      return /\b(heart|love|valentine|lobes|lobe)\b/.test(text);
    default:
      return false;
  }
}

function curatedManhattanRunCandidate(
  run: CuratedRun,
  targetDistanceKm?: number,
): MapNativeCandidate | null {
  const anchors = run.coords;
  const km = routeLengthKm(anchors);
  if (!verifiedRouteAllowsKm(km, targetDistanceKm)) return null;
  return {
    placement: placementFromAnchors(anchors, 29, 1),
    anchors,
    km,
    designIntent: `Verified route-library Manhattan ${run.title}: ${run.blurb} Features: ${curatedRunTags(run).join(", ")}.`,
    kind: "street-design",
    routeMode: "direct-grid",
  };
}

// The three verified-bank source routes, embedded verbatim when their
// gallery entries were retired (July 28) — the bank must keep serving them.
const LEGACY_VERIFIED_RUNS: CuratedRun[] = [
  { id: "les-heart", title: "Lower East Side Heart", icon: "❤️", area: "Lower East Side · Canal St → E Houston St", blurb: "A pixel heart on the finest street grid in Manhattan — domed lobes, a V-dip, and a pointed tip. One closed loop, no retracing.", distanceKm: 4.47, coords: [[40.714676,-73.991128],[40.714697,-73.991200],[40.714886,-73.991831],[40.714903,-73.991887],[40.714979,-73.991849],[40.715565,-73.991549],[40.715983,-73.991336],[40.716032,-73.991312],[40.716050,-73.991373],[40.716153,-73.991715],[40.716176,-73.991792],[40.716231,-73.991763],[40.716836,-73.991444],[40.717016,-73.991349],[40.717110,-73.991299],[40.717196,-73.991254],[40.717275,-73.991212],[40.717297,-73.991283],[40.717305,-73.991310],[40.717381,-73.991272],[40.717434,-73.991246],[40.717455,-73.991235],[40.717468,-73.991279],[40.717479,-73.991316],[40.717484,-73.991330],[40.717509,-73.991415],[40.717526,-73.991467],[40.717533,-73.991491],[40.717722,-73.992118],[40.717729,-73.992140],[40.717740,-73.992180],[40.717753,-73.992228],[40.717761,-73.992251],[40.717972,-73.992963],[40.717953,-73.992972],[40.717905,-73.992998],[40.717927,-73.993073],[40.717960,-73.993056],[40.718002,-73.993034],[40.718745,-73.992655],[40.718793,-73.992631],[40.718845,-73.992604],[40.718865,-73.992670],[40.718899,-73.992779],[40.719026,-73.993196],[40.719046,-73.993261],[40.719049,-73.993272],[40.719080,-73.993373],[40.719121,-73.993491],[40.719134,-73.993526],[40.719349,-73.994241],[40.719359,-73.994272],[40.719467,-73.994395],[40.719532,-73.994365],[40.719591,-73.994341],[40.719822,-73.994246],[40.720079,-73.994218],[40.720254,-73.994148],[40.720343,-73.994113],[40.720465,-73.994065],[40.720522,-73.994042],[40.720807,-73.993932],[40.720930,-73.993884],[40.720975,-73.993865],[40.721030,-73.993842],[40.721075,-73.993822],[40.721607,-73.993611],[40.721656,-73.993595],[40.721703,-73.993577],[40.721747,-73.993561],[40.722341,-73.993341],[40.722383,-73.993326],[40.722442,-73.993305],[40.722490,-73.993287],[40.722831,-73.993165],[40.722806,-73.993034],[40.722783,-73.992926],[40.722473,-73.991850],[40.722455,-73.991786],[40.722421,-73.991670],[40.722471,-73.991645],[40.722517,-73.991622],[40.722682,-73.991537],[40.723129,-73.991306],[40.723425,-73.991155],[40.723472,-73.991130],[40.723516,-73.991108],[40.723602,-73.991075],[40.723727,-73.991032],[40.723682,-73.990890],[40.723663,-73.990827],[40.723518,-73.990364],[40.723479,-73.990243],[40.723450,-73.990150],[40.723428,-73.990079],[40.723353,-73.989840],[40.723202,-73.989347],[40.723039,-73.988814],[40.722984,-73.988627],[40.722929,-73.988440],[40.722919,-73.988404],[40.722906,-73.988357],[40.722847,-73.988159],[40.722785,-73.987954],[40.722758,-73.987861],[40.722644,-73.987918],[40.722557,-73.987961],[40.722503,-73.987990],[40.721831,-73.988327],[40.721512,-73.988490],[40.721463,-73.988516],[40.721444,-73.988453],[40.721422,-73.988381],[40.721254,-73.987829],[40.721235,-73.987764],[40.721183,-73.987791],[40.720133,-73.988332],[40.720079,-73.988360],[40.720060,-73.988299],[40.719867,-73.987661],[40.719831,-73.987544],[40.719887,-73.987514],[40.720937,-73.986974],[40.720988,-73.986948],[40.720954,-73.986834],[40.720770,-73.986229],[40.720748,-73.986157],[40.720802,-73.986128],[40.721790,-73.985612],[40.721850,-73.985580],[40.721921,-73.985545],[40.722036,-73.985484],[40.722013,-73.985407],[40.721984,-73.985306],[40.721943,-73.985167],[40.721811,-73.984729],[40.721785,-73.984644],[40.721757,-73.984547],[40.721751,-73.984528],[40.721734,-73.984475],[40.721678,-73.984296],[40.721561,-73.983903],[40.721529,-73.983799],[40.721500,-73.983701],[40.721437,-73.983487],[40.721278,-73.982968],[40.721163,-73.983027],[40.721137,-73.982939],[40.720906,-73.982181],[40.720825,-73.982223],[40.719768,-73.982775],[40.719724,-73.982797],[40.719706,-73.982735],[40.719633,-73.982501],[40.719487,-73.982025],[40.719462,-73.981942],[40.719414,-73.981964],[40.719180,-73.982082],[40.718676,-73.982334],[40.718356,-73.982499],[40.718314,-73.982521],[40.718260,-73.982548],[40.717427,-73.982978],[40.717219,-73.983103],[40.717168,-73.983141],[40.717126,-73.983170],[40.717097,-73.983178],[40.716690,-73.983389],[40.716580,-73.983365],[40.716524,-73.983390],[40.716292,-73.983548],[40.716172,-73.983618],[40.716138,-73.983639],[40.716180,-73.983789],[40.716196,-73.983847],[40.716287,-73.984172],[40.716397,-73.984535],[40.716630,-73.985309],[40.716698,-73.985531],[40.716881,-73.986137],[40.716898,-73.986194],[40.716841,-73.986223],[40.716045,-73.986627],[40.716038,-73.986633],[40.716002,-73.986666],[40.715975,-73.986694],[40.716008,-73.986787],[40.716092,-73.987071],[40.716107,-73.987122],[40.716132,-73.987232],[40.716186,-73.987481],[40.716200,-73.987530],[40.716218,-73.987592],[40.716434,-73.988307],[40.716455,-73.988377],[40.716477,-73.988450],[40.716552,-73.988676],[40.716673,-73.989041],[40.716712,-73.989149],[40.716623,-73.989196],[40.716568,-73.989224],[40.715598,-73.989729],[40.715561,-73.989748],[40.715494,-73.989782],[40.715100,-73.989987],[40.714774,-73.990155],[40.714594,-73.990220],[40.714497,-73.990232],[40.714421,-73.990228],[40.714447,-73.990373],[40.714533,-73.990663],[40.714656,-73.991064],[40.714676,-73.991128]] },
  { id: "chelsea-turtle", title: "Chelsea Turtle", icon: "🐢", area: "Chelsea · 18th–28th St, 11th–5th Ave", blurb: "Top-down turtle: shell, four stubby legs, head poking east toward Fifth, tail to the Hudson. One continuous loop.", distanceKm: 6.08, coords: [[40.749611,-74.002775],[40.749657,-74.002741],[40.749744,-74.002678],[40.750155,-74.002369],[40.750229,-74.002314],[40.750273,-74.002282],[40.750776,-74.001919],[40.750828,-74.001882],[40.750772,-74.001748],[40.750343,-74.000723],[40.749723,-73.999240],[40.749697,-73.999178],[40.749644,-73.999217],[40.749600,-73.999107],[40.749123,-73.999454],[40.748951,-73.999577],[40.748789,-73.999696],[40.748518,-73.999893],[40.748474,-73.999925],[40.748430,-73.999957],[40.748370,-73.999791],[40.748128,-73.999217],[40.748063,-73.999059],[40.747880,-73.998629],[40.747686,-73.998172],[40.747663,-73.998116],[40.747619,-73.998008],[40.747599,-73.997963],[40.747344,-73.997356],[40.747304,-73.997273],[40.747279,-73.997222],[40.747217,-73.997085],[40.747154,-73.996952],[40.746466,-73.995315],[40.746203,-73.994694],[40.746068,-73.994372],[40.746018,-73.994253],[40.746065,-73.994217],[40.746205,-73.994115],[40.746562,-73.993854],[40.746618,-73.993813],[40.746688,-73.993762],[40.746880,-73.993622],[40.747180,-73.993403],[40.747236,-73.993362],[40.747185,-73.993240],[40.746094,-73.990651],[40.746038,-73.990518],[40.745979,-73.990561],[40.745846,-73.990657],[40.745483,-73.990923],[40.745421,-73.990968],[40.745363,-73.991010],[40.745233,-73.991108],[40.744871,-73.991369],[40.744819,-73.991409],[40.744753,-73.991456],[40.744253,-73.991822],[40.744186,-73.991871],[40.744137,-73.991907],[40.744039,-73.991978],[40.743642,-73.992266],[40.743568,-73.992318],[40.743518,-73.992199],[40.743444,-73.992022],[40.742454,-73.989658],[40.742345,-73.989403],[40.742323,-73.989353],[40.742271,-73.989356],[40.742252,-73.989358],[40.742044,-73.989391],[40.741966,-73.989447],[40.741701,-73.989637],[40.741672,-73.989659],[40.741600,-73.989712],[40.741531,-73.989763],[40.741506,-73.989782],[40.740994,-73.990154],[40.740984,-73.990131],[40.740945,-73.990042],[40.740886,-73.990083],[40.740934,-73.990197],[40.741428,-73.991375],[40.742177,-73.993158],[40.742233,-73.993292],[40.742181,-73.993329],[40.741680,-73.993694],[40.741629,-73.993732],[40.741562,-73.993780],[40.741528,-73.993805],[40.741461,-73.993854],[40.741090,-73.994124],[40.741031,-73.994167],[40.741087,-73.994300],[40.741115,-73.994366],[40.742179,-73.996888],[40.742234,-73.997002],[40.742174,-73.997046],[40.741709,-73.997385],[40.741642,-73.997434],[40.741592,-73.997470],[40.741246,-73.997720],[40.741117,-73.997817],[40.741056,-73.997862],[40.740997,-73.997721],[40.739919,-73.995157],[40.739860,-73.995018],[40.739920,-73.994974],[40.740292,-73.994703],[40.740394,-73.994628],[40.740442,-73.994593],[40.740502,-73.994550],[40.740939,-73.994233],[40.740980,-73.994203],[40.741031,-73.994167],[40.741087,-73.994300],[40.741115,-73.994366],[40.742179,-73.996888],[40.742234,-73.997002],[40.742295,-73.997125],[40.742321,-73.997185],[40.743379,-73.999713],[40.743429,-73.999850],[40.743483,-73.999993],[40.743508,-74.000052],[40.744568,-74.002563],[40.744639,-74.002732],[40.744583,-74.002774],[40.744112,-74.003113],[40.744056,-74.003155],[40.743991,-74.003204],[40.743850,-74.003301],[40.743527,-74.003543],[40.743476,-74.003581],[40.743517,-74.003678],[40.743736,-74.004204],[40.743770,-74.004286],[40.743957,-74.004733],[40.744000,-74.004837],[40.744597,-74.006266],[40.744646,-74.006385],[40.744717,-74.006332],[40.745173,-74.006002],[40.745231,-74.005960],[40.745297,-74.005912],[40.745642,-74.005662],[40.745724,-74.005602],[40.745753,-74.005581],[40.745817,-74.005534],[40.745880,-74.005487],[40.746309,-74.005170],[40.746346,-74.005142],[40.746410,-74.005098],[40.746465,-74.005059],[40.746971,-74.004690],[40.747023,-74.004653],[40.747088,-74.004609],[40.747611,-74.004229],[40.747703,-74.004164],[40.747761,-74.004303],[40.747935,-74.004719],[40.748809,-74.006807],[40.748837,-74.006873],[40.748891,-74.007003],[40.748941,-74.006979],[40.748961,-74.006967],[40.748991,-74.006947],[40.749043,-74.006911],[40.749238,-74.006770],[40.749429,-74.006631],[40.749471,-74.006599],[40.749531,-74.006576],[40.749471,-74.006599],[40.749438,-74.006474],[40.749428,-74.006444],[40.749083,-74.005568],[40.748557,-74.004303],[40.748515,-74.004206],[40.748366,-74.003862],[40.748301,-74.003724],[40.748355,-74.003684],[40.748426,-74.003632],[40.748921,-74.003274],[40.748974,-74.003236],[40.749044,-74.003185],[40.749499,-74.002859],[40.749533,-74.002833],[40.749611,-74.002775]] },
  { id: "midtown-sailboat", title: "Midtown Sailboat", icon: "⛵", area: "Garment District · 34th–46th St, 10th–5th Ave", blurb: "Trapezoid hull, thin mast up Eighth Avenue, and a stair-stepped mainsail with a jib. Sails right past Times Square.", distanceKm: 8.51, coords: [[40.756480,-73.997767],[40.756427,-73.997639],[40.755988,-73.996593],[40.755893,-73.996339],[40.755869,-73.996280],[40.755767,-73.996033],[40.755732,-73.995950],[40.755720,-73.995921],[40.755534,-73.995479],[40.755355,-73.995064],[40.755325,-73.994994],[40.755297,-73.994930],[40.755233,-73.994781],[40.755108,-73.994492],[40.755060,-73.994378],[40.754149,-73.992216],[40.754143,-73.992202],[40.754091,-73.992079],[40.754036,-73.991948],[40.753886,-73.991593],[40.752948,-73.989369],[40.752895,-73.989243],[40.752843,-73.989118],[40.752229,-73.987626],[40.752198,-73.987557],[40.752190,-73.987537],[40.752169,-73.987488],[40.752110,-73.987350],[40.752096,-73.987318],[40.752042,-73.987192],[40.751759,-73.986537],[40.751700,-73.986399],[40.751642,-73.986267],[40.751554,-73.986065],[40.751512,-73.985969],[40.751376,-73.985644],[40.750395,-73.983303],[40.750341,-73.983175],[40.750270,-73.983226],[40.749786,-73.983575],[40.749728,-73.983617],[40.749662,-73.983665],[40.749163,-73.984028],[40.749105,-73.984071],[40.749154,-73.984188],[40.749454,-73.984909],[40.750351,-73.987036],[40.750412,-73.987177],[40.750457,-73.987287],[40.750405,-73.987326],[40.750283,-73.987414],[40.749882,-73.987699],[40.749801,-73.987746],[40.749846,-73.987852],[40.749863,-73.987892],[40.749934,-73.988060],[40.750029,-73.988286],[40.750394,-73.989151],[40.750424,-73.989224],[40.750456,-73.989300],[40.750961,-73.990498],[40.751009,-73.990612],[40.751068,-73.990753],[40.751540,-73.991868],[40.751577,-73.991957],[40.751611,-73.992040],[40.751884,-73.992686],[40.752148,-73.993330],[40.752199,-73.993458],[40.752257,-73.993607],[40.752634,-73.994522],[40.752666,-73.994600],[40.752700,-73.994682],[40.752899,-73.995155],[40.752932,-73.995229],[40.752964,-73.995299],[40.753126,-73.995641],[40.753161,-73.995724],[40.753192,-73.995796],[40.753344,-73.996159],[40.753408,-73.996318],[40.753495,-73.996256],[40.753705,-73.996103],[40.754010,-73.995887],[40.754071,-73.995843],[40.754119,-73.995954],[40.754335,-73.996464],[40.754533,-73.996923],[40.754589,-73.997063],[40.754630,-73.997161],[40.754660,-73.997229],[40.754733,-73.997406],[40.754880,-73.997766],[40.755200,-73.998525],[40.755257,-73.998659],[40.755315,-73.998616],[40.755464,-73.998508],[40.755535,-73.998454],[40.755809,-73.998256],[40.755874,-73.998209],[40.755933,-73.998165],[40.756010,-73.998110],[40.756115,-73.998033],[40.756189,-73.997979],[40.756430,-73.997804],[40.756480,-73.997767],[40.756427,-73.997639],[40.755988,-73.996593],[40.755893,-73.996339],[40.755869,-73.996280],[40.755767,-73.996033],[40.755732,-73.995950],[40.755720,-73.995921],[40.755534,-73.995479],[40.755355,-73.995064],[40.755325,-73.994994],[40.755297,-73.994930],[40.755233,-73.994781],[40.755108,-73.994492],[40.755060,-73.994378],[40.754149,-73.992216],[40.754143,-73.992202],[40.754091,-73.992079],[40.754157,-73.992031],[40.754650,-73.991674],[40.754707,-73.991633],[40.754772,-73.991585],[40.754940,-73.991462],[40.755267,-73.991223],[40.755330,-73.991177],[40.755390,-73.991134],[40.755346,-73.991009],[40.755837,-73.990622],[40.755889,-73.990586],[40.755958,-73.990540],[40.756451,-73.990180],[40.756508,-73.990137],[40.756568,-73.990093],[40.757083,-73.989719],[40.757177,-73.989658],[40.757264,-73.989601],[40.757279,-73.989603],[40.757331,-73.989720],[40.757721,-73.989435],[40.757852,-73.989340],[40.757912,-73.989296],[40.757977,-73.989249],[40.758482,-73.988880],[40.758532,-73.988843],[40.758592,-73.988800],[40.758820,-73.988633],[40.759103,-73.988427],[40.759160,-73.988386],[40.759223,-73.988339],[40.759508,-73.988132],[40.759731,-73.987969],[40.759787,-73.987928],[40.759732,-73.987797],[40.759572,-73.987420],[40.759501,-73.987252],[40.759197,-73.986516],[40.758886,-73.985770],[40.758767,-73.985492],[40.758743,-73.985435],[40.758640,-73.985185],[40.758597,-73.985079],[40.758524,-73.985132],[40.758367,-73.985244],[40.758035,-73.985482],[40.757963,-73.985534],[40.757892,-73.985589],[40.757419,-73.985952],[40.757342,-73.986012],[40.757279,-73.986056],[40.756845,-73.986363],[40.756795,-73.986398],[40.756710,-73.986458],[40.756667,-73.986356],[40.756639,-73.986288],[40.756585,-73.986159],[40.756532,-73.986034],[40.756516,-73.985996],[40.756502,-73.985963],[40.756425,-73.985781],[40.756246,-73.985356],[40.756139,-73.985102],[40.755572,-73.983758],[40.755516,-73.983624],[40.755455,-73.983669],[40.754960,-73.984031],[40.754938,-73.984047],[40.754842,-73.984118],[40.754757,-73.984179],[40.754407,-73.984432],[40.754236,-73.984554],[40.754177,-73.984596],[40.754119,-73.984637],[40.753691,-73.984945],[40.753619,-73.984996],[40.753558,-73.985040],[40.753503,-73.984909],[40.752259,-73.981951],[40.752205,-73.981824],[40.752143,-73.981868],[40.751693,-73.982195],[40.751649,-73.982226],[40.751581,-73.982276],[40.751526,-73.982316],[40.751032,-73.982674],[40.750960,-73.982726],[40.751009,-73.982844],[40.751209,-73.983318],[40.751335,-73.983617],[40.751361,-73.983678],[40.752080,-73.985384],[40.752262,-73.985816],[40.752317,-73.985947],[40.752375,-73.986084],[40.752818,-73.987182],[40.752887,-73.987344],[40.752934,-73.987458],[40.753450,-73.988673],[40.753503,-73.988798],[40.753557,-73.988923],[40.754647,-73.991488],[40.754707,-73.991633],[40.754772,-73.991585],[40.754940,-73.991462],[40.755267,-73.991223],[40.755330,-73.991177],[40.755390,-73.991134],[40.755346,-73.991009],[40.755837,-73.990622],[40.755889,-73.990586],[40.755958,-73.990540],[40.756451,-73.990180],[40.756508,-73.990137],[40.756568,-73.990093],[40.757083,-73.989719],[40.757177,-73.989658],[40.757264,-73.989601],[40.757279,-73.989603],[40.757331,-73.989720],[40.757721,-73.989435],[40.757852,-73.989340],[40.757912,-73.989296],[40.757977,-73.989249],[40.758482,-73.988880],[40.758532,-73.988843],[40.758594,-73.988989],[40.758799,-73.989475],[40.759167,-73.990351],[40.759284,-73.990628],[40.759673,-73.991552],[40.759728,-73.991684],[40.759673,-73.991724],[40.759165,-73.992094],[40.759104,-73.992138],[40.759054,-73.992018],[40.758992,-73.992062],[40.758475,-73.992422],[40.758373,-73.992496],[40.758285,-73.992561],[40.757843,-73.992881],[40.757756,-73.992944],[40.757663,-73.993012],[40.757646,-73.993045],[40.757380,-73.993241],[40.757158,-73.993404],[40.757099,-73.993449],[40.757039,-73.993495],[40.756540,-73.993853],[40.756483,-73.993893],[40.756532,-73.994018],[40.756473,-73.994061],[40.756105,-73.994330],[40.755972,-73.994428],[40.755904,-73.994475],[40.755855,-73.994341],[40.754910,-73.992112],[40.754766,-73.991771],[40.754756,-73.991748],[40.754707,-73.991633]] },
];

/**
 * Aug 11 re-verification: the LES heart, Chelsea turtle, and Midtown
 * sailboat all failed the blind instrument twice over and were demoted —
 * no legacy curated run is currently verified.
 */
const VERIFIED_CURATED_RUN_IDS = new Set<string>([]);

function verifiedRouteBankCandidatesFromText(
  text: string,
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  /**
   * Aug 11 re-verification: only the apple survived the blind instrument
   * twice over (raw verdicts: tmp-gas-commission/reverify/). Sneaker,
   * key, DC martini, umbrella, trophy, LES heart, turtle, and sailboat
   * all failed and may no longer be offered as verified candidates —
   * their branches were removed, matching the demotions in
   * verifiedRouteBankManifest.ts.
   */
  const out: MapNativeCandidate[] = [];
  if (preset.id === "manhattan" && /\b(apple|fruit|bite|leaf|stem)\b/.test(text)) {
    const apple = curatedApple2ManhattanMapNativeCandidate();
    if (verifiedRouteAllowsKm(apple.km, targetDistanceKm)) out.push(apple);
  }
  if (preset.id === "manhattan") {
    for (const run of [...CURATED_MANHATTAN_RUNS, ...LEGACY_VERIFIED_RUNS]) {
      if (!VERIFIED_CURATED_RUN_IDS.has(run.id)) continue;
      if (!textMatchesCuratedRun(text, run)) continue;
      const candidate = curatedManhattanRunCandidate(run, targetDistanceKm);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

export function verifiedRouteBankCandidates(
  drafts: MapNativeDesignDraft[],
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  return verifiedRouteBankCandidatesFromText(
    draftSearchText(drafts),
    preset,
    targetDistanceKm,
  );
}

export function manhattanRouteLibraryCandidates(
  drafts: MapNativeDesignDraft[],
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  const text = draftSearchText(drafts);
  const verifiedRoutes = verifiedRouteBankCandidatesFromText(text, preset, targetDistanceKm);
  if (preset.id !== "manhattan") return [];
  const wants = {
    star: /\b(star|five[-\s]?point|spark|asterisk)\b/.test(text),
    heart: /\b(heart|love|lobe|valentine)\b/.test(text),
    gasPump:
      /\b(gas|pump|fuel|nozzle)\b/.test(text) &&
      /\b(person|human|figure|head|body|legs|headphones|hose)\b/.test(text),
    sweep: /\b(swoosh|sweep|curve|curved|ribbon|wing|slash|checkmark|tail|comet|wave)\b/.test(text),
    bolt: /\b(bolt|lightning|zigzag|zig-zag|thunder)\b/.test(text),
    block:
      /\b(block|badge|shield|diamond|house|building|rectangle|square|frame|logo|icon)\b/.test(
        text,
      ),
    letter: /\b(letter|letters|wordmark|monogram|initial|type|typography)\b/.test(text),
  };

  const recipes: Array<{
    enabled: boolean;
    label: string;
    tags: string[];
    rotationDeg: number;
    scale: number;
    anchors: [number, number][];
  }> = [
    {
      enabled: wants.gasPump,
      label: "east village gas pump + person",
      tags: [
        "pump",
        "window",
        "hose loop",
        "headphones",
        "person",
        "body",
        "legs",
        "nozzle",
      ],
      rotationDeg: 29,
      scale: 1.08,
      anchors: [
        [40.718, -73.998],
        [40.718, -73.988],
        [40.742, -73.988],
        [40.742, -73.994],
        [40.724, -73.994],
        [40.724, -73.990],
        [40.736, -73.990],
        [40.736, -73.994],
        [40.724, -73.994],
        [40.742, -73.994],
        [40.742, -73.998],
        [40.718, -73.998],
        [40.742, -73.996],
        [40.748, -73.996],
        [40.748, -73.992],
        [40.754, -73.990],
        [40.760, -73.984],
        [40.764, -73.980],
        [40.768, -73.984],
        [40.768, -73.988],
        [40.764, -73.992],
        [40.760, -73.988],
        [40.756, -73.984],
        [40.760, -73.988],
        [40.760, -73.996],
        [40.756, -73.996],
        [40.756, -74.002],
        [40.760, -73.996],
        [40.764, -73.996],
        [40.764, -74.002],
        [40.760, -73.990],
        [40.766, -73.986],
        [40.770, -73.978],
      ],
    },
    {
      enabled: wants.star,
      label: "midtown five-point star",
      tags: ["star", "five points", "sharp tips", "closed outline", "midtown grid"],
      rotationDeg: 29,
      scale: 1.25,
      anchors: [
        [40.762, -73.986],
        [40.752, -73.982],
        [40.751, -73.971],
        [40.744, -73.979],
        [40.731, -73.974],
        [40.738, -73.986],
        [40.731, -73.998],
        [40.744, -73.993],
        [40.751, -74.002],
        [40.752, -73.990],
        [40.762, -73.986],
      ],
    },
    {
      enabled: wants.heart,
      label: "central park south heart",
      tags: ["heart", "left lobe", "right lobe", "bottom point", "closed outline"],
      rotationDeg: 14,
      scale: 1.35,
      anchors: [
        [40.736, -73.995],
        [40.752, -74.003],
        [40.768, -73.996],
        [40.771, -73.984],
        [40.762, -73.974],
        [40.751, -73.977],
        [40.744, -73.966],
        [40.730, -73.969],
        [40.720, -73.981],
        [40.724, -73.993],
        [40.736, -73.995],
      ],
    },
    {
      enabled: wants.sweep,
      label: "west-side tapered sweep",
      tags: ["swoosh", "tapered outline", "wide heel", "curved belly", "thin rising tip"],
      rotationDeg: 31,
      scale: 1.15,
      anchors: [
        [40.724, -74.006],
        [40.729, -74.000],
        [40.742, -73.990],
        [40.760, -73.978],
        [40.782, -73.971],
        [40.770, -73.974],
        [40.750, -73.986],
        [40.731, -73.999],
        [40.724, -74.006],
      ],
    },
    {
      enabled: wants.bolt,
      label: "midtown vertical lightning bolt",
      tags: ["lightning", "bolt", "zigzag", "middle notch", "pointed bottom"],
      rotationDeg: 4,
      scale: 0.88,
      anchors: [
        [40.764, -73.990],
        [40.755, -73.974],
        [40.755, -73.987],
        [40.739, -73.976],
        [40.744, -73.991],
        [40.725, -73.982],
      ],
    },
    {
      enabled: wants.bolt,
      label: "downtown lightning bolt",
      tags: ["lightning", "bolt", "zigzag", "middle notch", "pointed bottom"],
      rotationDeg: 23,
      scale: 0.96,
      anchors: [
        [40.741, -73.996],
        [40.731, -74.006],
        [40.733, -73.993],
        [40.717, -74.000],
        [40.729, -73.982],
        [40.715, -73.991],
      ],
    },
    {
      enabled: wants.block,
      label: "chelsea block badge",
      tags: ["block", "badge", "corners", "inner detail", "closed outline"],
      rotationDeg: 29,
      scale: 1.05,
      anchors: [
        [40.735, -74.004],
        [40.765, -73.988],
        [40.758, -73.970],
        [40.728, -73.986],
        [40.735, -74.004],
        [40.744, -73.995],
        [40.751, -73.983],
        [40.740, -73.986],
      ],
    },
    {
      enabled: wants.letter,
      label: "midtown monogram scaffold",
      tags: ["letters", "monogram", "upright strokes", "diagonal connector", "reading order"],
      rotationDeg: 29,
      scale: 1.05,
      anchors: [
        [40.727, -74.002],
        [40.778, -73.992],
        [40.735, -73.982],
        [40.789, -73.970],
        [40.760, -73.977],
        [40.784, -73.964],
        [40.760, -73.977],
        [40.741, -73.990],
      ],
    },
  ];

  return [
    ...verifiedRoutes,
    ...recipes
      .filter((recipe) => recipe.enabled)
      .map((recipe) =>
        routeLibraryCandidate({
          label: recipe.label,
          anchors: recipe.anchors,
          rotationDeg: recipe.rotationDeg,
          scale: recipe.scale,
          tags: recipe.tags,
          preset,
          targetDistanceKm,
        }),
      )
      .filter((candidate): candidate is MapNativeCandidate => candidate != null),
  ];
}

function diverseSubsample<T extends { placement: PlacementTransform }>(
  valid: T[],
  count: number,
  preset: CityPreset,
): T[] {
  if (count <= 0) return [];
  if (valid.length <= count) return valid;
  const b = preset.searchBounds;
  const latRange = b.north - b.south || 1;
  const lngRange = b.east - b.west || 1;

  const keys = valid.map((v) => {
    const p = v.placement;
    return [
      ((p.center[0] - b.south) / latRange) * 2,
      ((p.center[1] - b.west) / lngRange) * 2,
      ((p.scale - 0.5) / 3) * 0.7,
      (((p.rotationDeg + 180) % 360) / 360) * 0.7,
    ];
  });

  const distanceBetween = (a: number[], b: number[]) =>
    Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]!) ** 2, 0));
  const pickedIdx = new Set<number>([0]);
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

export function streetWordmarkCandidates(
  word: string | null | undefined,
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  if (preset.id !== "manhattan" || !word) return [];
  const cleanWord = word
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12);
  if (cleanWord.replace(/ /g, "").length < 2) return [];
  const letterSequence = cleanWord.replace(/ /g, "").split("").join(" ");

  const rawFamilies = [
    {
      id: "block-letter-tall",
      points: gridWalkWordmarkPoints(blockWordmarkRawStrokePoints(cleanWord)),
      xStepMeters: cleanWord.length >= 6 ? 112 : cleanWord.length >= 5 ? 128 : 146,
      yStepMeters: cleanWord.length >= 6 ? 220 : cleanWord.length >= 5 ? 240 : 270,
      routeMode: "direct-grid" as const,
      intent:
        "tall block-letter wordmark with simple rectangular strokes and stronger letter height",
    },
    {
      id: "block-letter-compact",
      points: gridWalkWordmarkPoints(blockWordmarkRawStrokePoints(cleanWord)),
      xStepMeters: cleanWord.length >= 6 ? 96 : cleanWord.length >= 5 ? 112 : 132,
      yStepMeters: cleanWord.length >= 6 ? 180 : cleanWord.length >= 5 ? 205 : 235,
      routeMode: "direct-grid" as const,
      intent:
        "compact block-letter wordmark using only orthogonal avenue/street strokes",
    },
    {
      id: "block-letter-wide",
      points: gridWalkWordmarkPoints(blockWordmarkRawStrokePoints(cleanWord)),
      xStepMeters: cleanWord.length >= 6 ? 136 : cleanWord.length >= 5 ? 155 : 180,
      yStepMeters: cleanWord.length >= 6 ? 190 : cleanWord.length >= 5 ? 215 : 250,
      routeMode: "direct-grid" as const,
      intent:
        "wide block-letter wordmark with clearer spacing between letters",
    },
    {
      id: "billboard-grid",
      points: gridWalkWordmarkPoints(gridWordmarkRawStrokePoints(cleanWord)),
      xStepMeters: cleanWord.length >= 6 ? 155 : cleanWord.length >= 5 ? 172 : 192,
      yStepMeters: cleanWord.length >= 6 ? 72 : cleanWord.length >= 5 ? 80 : 92,
      routeMode: "direct-grid" as const,
      intent:
        "large readable billboard wordmark using tall avenue strokes and full crosstown rows",
    },
    {
      id: "street-grid",
      points: gridWalkWordmarkPoints(gridWordmarkRawStrokePoints(cleanWord)),
      xStepMeters: cleanWord.length >= 6 ? 128 : cleanWord.length >= 5 ? 145 : 165,
      yStepMeters: cleanWord.length >= 6 ? 62 : cleanWord.length >= 5 ? 70 : 82,
      routeMode: "direct-grid" as const,
      intent:
        "human-picked block-grid wordmark using whole street rows and columns instead of mid-block glyph points",
    },
  ];
  const targetKm =
    targetDistanceKm != null && Number.isFinite(targetDistanceKm)
      ? targetDistanceKm
      : 9;
  const centers: [number, number][] = [
    [40.720, -74.000],
    [40.724, -73.996],
    [40.728, -73.992],
    [40.735, -73.992],
    [40.738, -73.987],
    [40.744, -73.986],
  ];
  const bearings = [101, 107, 112, 118];
  const out: MapNativeCandidate[] = [];

  for (const family of rawFamilies) {
    const baseMeters = localGridPolylineLengthMeters(
      family.points,
      family.xStepMeters,
      family.yStepMeters,
    );
    if (baseMeters <= 0) continue;
    // Ceiling raised from 1.62: letters have to be several blocks thick to
    // read from map altitude, and the multipliers below explore genuinely
    // billboard-scale versions (the 14th-54th Street kind) alongside the
    // modest ones, instead of only ever offering small.
    const distanceScale = Math.max(
      0.82,
      Math.min(2.9, (targetKm * 1050) / baseMeters),
    );
    for (const center of centers) {
      for (const bearing of bearings) {
        for (const m of [
          distanceScale,
          distanceScale * 0.86,
          distanceScale * 1.08,
          distanceScale * 1.2,
          distanceScale * 1.55,
          distanceScale * 2.0,
        ]) {
          const anchors = streetWordmarkAnchors(
            family.points,
            center,
            family.xStepMeters * m,
            family.yStepMeters * m,
            bearing,
          );
          // Tighter margin than the default 0.012deg (~1 km per side): on an
          // island only ~5 km wide that buffer left a 3.2 km-wide canvas,
          // which silently capped every wordmark at roughly half the size of
          // the one that actually reads. These routes are drawn on real
          // avenue/street lines, so they can't stray into the river the way
          // a snapped silhouette can.
          if (
            anchors.length < 2 ||
            !candidateStaysInBounds(anchors, preset, WORDMARK_BOUNDS_MARGIN)
          ) {
            continue;
          }
          const km = routeLengthKm(anchors);
          if (km < MIN_ROUTE_KM || km > MAX_WORDMARK_ROUTE_KM) continue;
          // Only hold a wordmark to a requested distance when the user
          // actually asked for one. Otherwise the band silently discarded
          // every billboard-scale version in favour of small, cramped
          // lettering — which is the version that doesn't read.
          if (
            targetDistanceKm != null &&
            Number.isFinite(targetDistanceKm) &&
            (km < targetDistanceKm * 0.6 || km > targetDistanceKm * 3.0)
          ) {
            continue;
          }
          out.push({
            placement: sourceAlignedPlacementFromAnchors(anchors, bearing),
            anchors,
            km,
            designIntent: `Street-native ${cleanWord} wordmark (${family.id}): ${family.intent} composed on Manhattan cross-street and avenue corridors before snapping. Features: letters, ${letterSequence}, text logo, upright legibility, reading order, baseline, full wordmark.`,
            kind: "street-wordmark",
            routeMode: family.routeMode,
          });
        }
      }
    }
  }

  return diverseSubsample(out, Math.min(24, out.length), preset);

}
/**
 * Compose a LOCKUP: the uploaded symbol drawn large above its wordmark in
 * block letters, as one continuous route — the arrangement of the best Nike
 * result this project has produced (swoosh over "JUST DO IT", 14th-54th St).
 *
 * Tracing a lockup as a single outline can't work: glyph strokes are far
 * smaller than a city block, so the words dissolve. Drawing the symbol from
 * the traced contour and *setting* the text as block letters keeps both
 * legible, and joining them with one vertical connector keeps it runnable.
 *
 * `symbol` is the traced contour in normalized 0..1 space (y down, as the
 * trace screen produces it).
 */
/**
 * Keep only the dominant traced component (largest ink bounding box). The
 * tracer keeps every component of an upload on purpose — that is its job —
 * but the lockup RE-SETS the words as block letters, so only the symbol may
 * ride in from the trace. Without this cut the slogan appears twice: once as
 * unreadable traced scribble glued to the symbol, once as the set type below.
 */
function dominantTracedComponent(symbol: ContourPoint[]): ContourPoint[] {
  const { connectorSegmentIndices } = analyzeOneLinePath(symbol);
  if (!connectorSegmentIndices.length) return symbol;
  const cuts = new Set(connectorSegmentIndices);
  const components: ContourPoint[][] = [];
  let current: ContourPoint[] = [symbol[0]!];
  for (let i = 1; i < symbol.length; i++) {
    if (cuts.has(i - 1)) {
      if (current.length >= 3) components.push(current);
      current = [];
    }
    current.push(symbol[i]!);
  }
  if (current.length >= 3) components.push(current);
  if (!components.length) return symbol;
  let best = components[0]!;
  let bestArea = -1;
  for (const c of components) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of c) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area > bestArea) {
      bestArea = area;
      best = c;
    }
  }
  return best;
}

/**
 * A raw trace carries hundreds of points; grid-walking them at lockup scale
 * turns the symbol into dense blocky rectangles. Simplify until the symbol
 * is a handful of bold strokes, so the walker produces the big readable
 * staircase of the reference sheet instead.
 */
function simplifiedSymbol(symbol: ContourPoint[]): ContourPoint[] {
  let tolerance = 0.012;
  let pts: Point2D[] = symbol.map((p) => [p.x, p.y]);
  for (let i = 0; i < 6 && pts.length > 28; i++) {
    pts = simplifyCartesian(pts, tolerance);
    tolerance *= 1.6;
  }
  return pts.map(([x, y]) => ({ x, y }));
}

export function buildLockupStrokePoints(
  rawSymbol: ContourPoint[],
  word: string,
): ContourPoint[] {
  // Glyphs are already orthogonal; running the grid walker over them only
  // re-corners strokes and destroys the letterforms.
  const wordPoints = blockWordmarkRawStrokePoints(word);
  if (wordPoints.length < 2) return [];
  if (rawSymbol.length < 3) return wordPoints;
  const symbol = simplifiedSymbol(dominantTracedComponent(rawSymbol));
  if (symbol.length < 3) return wordPoints;

  let wMinX = Infinity;
  let wMaxX = -Infinity;
  let wMinY = Infinity;
  let wMaxY = -Infinity;
  for (const p of wordPoints) {
    wMinX = Math.min(wMinX, p.x);
    wMaxX = Math.max(wMaxX, p.x);
    wMinY = Math.min(wMinY, p.y);
    wMaxY = Math.max(wMaxY, p.y);
  }
  const wordWidth = Math.max(1e-6, wMaxX - wMinX);
  const wordHeight = Math.max(1e-6, wMaxY - wMinY);

  let sMinX = Infinity;
  let sMaxX = -Infinity;
  let sMinY = Infinity;
  let sMaxY = -Infinity;
  for (const p of symbol) {
    sMinX = Math.min(sMinX, p.x);
    sMaxX = Math.max(sMaxX, p.x);
    sMinY = Math.min(sMinY, p.y);
    sMaxY = Math.max(sMaxY, p.y);
  }
  const sw = Math.max(1e-6, sMaxX - sMinX);
  const sh = Math.max(1e-6, sMaxY - sMinY);

  // Symbol spans the wordmark's width and reads as the dominant mark (the
  // reference sheet's swoosh dwarfs its slogan). Height keys on the WIDTH,
  // not the text-block height — a stacked two-row block would otherwise
  // balloon the symbol beyond any distance cap.
  const targetW = wordWidth;
  const targetH = Math.min(wordHeight * 2.4, wordWidth * 0.5);
  const scale = Math.min(targetW / sw, targetH / sh);
  const gap = wordHeight * 0.55;

  // Which side of the word is "above" depends on the axis convention used by
  // streetWordmarkAnchors; place the symbol beyond wMaxY and let the caller
  // flip bearing if needed. Symbol y is inverted here because the traced
  // contour uses screen coordinates (y down).
  const placed: ContourPoint[] = symbol.map((p) => ({
    x: wMinX + (p.x - sMinX) * scale + (wordWidth - sw * scale) / 2,
    y: wMaxY + gap + (sMaxY - p.y) * scale,
  }));

  // Enter the word at its first point, having come from the symbol's end:
  // travel ACROSS at symbol height to the word's left edge, then drop —
  // dropping at the symbol's own x slashed a vertical line through the
  // middle letters.
  const symbolEnd = placed[placed.length - 1]!;
  const wordStart = wordPoints[0]!;
  const connector: ContourPoint[] = [
    { x: symbolEnd.x, y: symbolEnd.y },
    { x: wordStart.x, y: symbolEnd.y },
    { x: wordStart.x, y: wordStart.y },
  ];

  // Resample the symbol's segments to ~1.4 glyph units before grid-walking:
  // the walker emits ONE elbow per segment, so a long diagonal kept whole
  // becomes a single giant L that destroys the silhouette, while the same
  // diagonal in short pieces becomes the multi-step staircase that made the
  // reference sheet's swoosh read.
  const resampled: ContourPoint[] = [];
  const STEP = 1.4;
  for (let i = 0; i < placed.length; i++) {
    const b = placed[i]!;
    if (i === 0) {
      resampled.push(b);
      continue;
    }
    const a = placed[i - 1]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.round(d / STEP));
    for (let s = 1; s <= steps; s++) {
      resampled.push({
        x: a.x + ((b.x - a.x) * s) / steps,
        y: a.y + ((b.y - a.y) * s) / steps,
      });
    }
  }

  // Grid-walk ONLY the symbol and connector. wordPoints are already walked,
  // and running the walker over them a second time collapses the glyph
  // strokes into illegible stubs.
  return [...gridWalkWordmarkPoints([...resampled, ...connector]), ...wordPoints];
}

export function streetLockupCandidates(
  symbol: ContourPoint[],
  word: string | null | undefined,
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  if (preset.id !== "manhattan" || !word) return [];
  const cleanWord = word
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12);
  if (cleanWord.replace(/ /g, "").length < 2) return [];
  if (cleanWord.length < 2) return [];
  const points = buildLockupStrokePoints(symbol, cleanWord);
  if (points.length < 8) return [];

  const targetKm =
    targetDistanceKm != null && Number.isFinite(targetDistanceKm)
      ? targetDistanceKm
      : 18;
  const out: MapNativeCandidate[] = [];
  const centers: [number, number][] = [
    [40.744, -73.99],
    [40.752, -73.988],
    [40.758, -73.985],
  ];
  // Same cross-street bearings the wordmark families use.
  const bearings = [107, 112, 118];
  const baseSteps = [
    { x: 132, y: 150 },
    { x: 155, y: 178 },
    { x: 178, y: 205 },
  ];

  for (const step of baseSteps) {
    for (const center of centers) {
      for (const bearing of bearings) {
        // Outline letterforms roughly double the drawn length per letter, so
        // smaller physical scales must exist for the km caps to accept —
        // and outlines stay readable smaller than hairline strokes did.
        for (const m of [0.4, 0.5, 0.62, 0.8] ) {
          const anchors = streetWordmarkAnchors(
            points,
            center,
            step.x * m,
            step.y * m,
            bearing,
          );
          if (
            anchors.length < 2 ||
            !candidateStaysInBounds(anchors, preset, WORDMARK_BOUNDS_MARGIN)
          ) {
            continue;
          }
          const km = routeLengthKm(anchors);
          if (km < MIN_ROUTE_KM || km > MAX_WORDMARK_ROUTE_KM) continue;
          if (
            Number.isFinite(targetKm) &&
            (km < targetKm * 0.5 || km > targetKm * 3.2)
          ) {
            continue;
          }
          out.push({
            placement: sourceAlignedPlacementFromAnchors(anchors, bearing),
            anchors,
            km,
            designIntent: `Street-native ${cleanWord} lockup: the uploaded symbol drawn large above ${cleanWord} in block letters, joined as one route. Features: letters, ${cleanWord.split("").join(" ")}, symbol, logo lockup, reading order, baseline, full wordmark.`,
            kind: "street-wordmark",
            routeMode: "direct-grid",
          });
        }
      }
    }
  }
  return diverseSubsample(out, Math.min(12, out.length), preset);
}

export function streetMonogramCandidates(
  word: string | null | undefined,
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  if (preset.id !== "manhattan" || !word) return [];
  const cleanWord = word
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8);
  const initial = cleanWord[0];
  if (!initial) return [];

  const points = gridLetterStroke(initial);
  const centers: [number, number][] = [
    [40.728, -73.995],
    [40.735, -73.992],
    [40.742, -73.989],
    [40.748, -73.985],
    [40.755, -73.982],
  ];
  const bearings = [104, 110, 116];
  const targetKm =
    targetDistanceKm != null && Number.isFinite(targetDistanceKm)
      ? targetDistanceKm
      : 8;
  const baseXStepMeters = 340;
  const baseYStepMeters = 430;
  const baseMeters = localGridPolylineLengthMeters(
    points,
    baseXStepMeters,
    baseYStepMeters,
  );
  if (baseMeters <= 0) return [];
  const baseScale = Math.max(0.82, Math.min(2.05, (targetKm * 920) / baseMeters));
  const out: MapNativeCandidate[] = [];

  for (const center of centers) {
    for (const bearing of bearings) {
      for (const m of [baseScale, baseScale * 0.88, baseScale * 1.08]) {
        const anchors = streetWordmarkAnchors(
          points,
          center,
          baseXStepMeters * m,
          baseYStepMeters * m,
          bearing,
        );
        if (anchors.length < 2 || !candidateStaysInBounds(anchors, preset)) {
          continue;
        }
        const km = routeLengthKm(anchors);
        if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) continue;
        if (
          targetDistanceKm != null &&
          Number.isFinite(targetDistanceKm) &&
          (km < targetDistanceKm * 0.32 || km > targetDistanceKm * 1.5)
        ) {
          continue;
        }
        out.push({
          placement: sourceAlignedPlacementFromAnchors(anchors, bearing),
          anchors,
          km,
          designIntent: `Street-native ${cleanWord} monogram (${initial}): large first-letter route for wordmark uploads, using tall avenue strokes and crosstown shelves when the full name would become unreadable. Features: letters, initial, monogram, reading order, baseline.`,
          kind: "street-wordmark",
        });
      }
    }
  }

  return diverseSubsample(out, Math.min(12, out.length), preset);
}

function sketchAnchorsOnCityGrid(
  points: ContourPoint[],
  center: [number, number],
  unitMeters: number,
  xBearingDeg: number,
  stretch: { x: number; y: number } = { x: 1, y: 1 },
): [number, number][] {
  const clean = points.filter(
    (p) =>
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      p.x >= 0 &&
      p.x <= 1 &&
      p.y >= 0 &&
      p.y <= 1,
  );
  if (clean.length < 2) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of clean) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const maxDim = Math.max(width, height);
  const cx = minX + width / 2;
  const cy = minY + height / 2;
  const xAxis = bearingUnitVector(xBearingDeg);
  const yAxis = bearingUnitVector(xBearingDeg + 90);

  return clean.map((p) => {
    const localX = ((p.x - cx) / maxDim) * unitMeters * stretch.x;
    const localY = (-(p.y - cy) / maxDim) * unitMeters * stretch.y;
    const east = localX * xAxis.east + localY * yAxis.east;
    const north = localX * xAxis.north + localY * yAxis.north;
    return offsetLatLngMeters(center, east, north);
  });
}

type LearnedGpsArtRecipe = {
  id: string;
  points: Array<[number, number]>;
  stretch: { x: number; y: number };
  intent: string;
};

const LEARNED_SWOOSH_GPS_ART_RECIPES: LearnedGpsArtRecipe[] = [
  {
    id: "broad-ribbon-heel",
    points: [
      [-1.18, -0.44],
      [-1.12, -0.1],
      [-0.96, 0.12],
      [-0.66, 0.18],
      [-0.2, 0.12],
      [0.36, 0.24],
      [1.08, 0.48],
      [1.28, 0.6],
      [0.62, 0.02],
      [0.06, -0.28],
      [-0.52, -0.46],
      [-0.96, -0.54],
      [-1.18, -0.44],
    ],
    stretch: { x: 1.38, y: 0.9 },
    intent:
      "broad heel, parallel lower return stroke, curved belly, and thin rising tip",
  },
  {
    id: "long-low-ribbon",
    points: [
      [-1.22, -0.38],
      [-1.04, -0.16],
      [-0.74, -0.04],
      [-0.34, 0.04],
      [0.16, 0.18],
      [0.78, 0.42],
      [1.24, 0.66],
      [0.86, 0.28],
      [0.24, -0.1],
      [-0.38, -0.32],
      [-0.9, -0.46],
      [-1.22, -0.38],
    ],
    stretch: { x: 1.55, y: 0.78 },
    intent:
      "long low street-scale sweep with a readable wide base and raised tail",
  },
  {
    id: "open-tail-ribbon",
    points: [
      [-1.18, -0.42],
      [-1.02, -0.18],
      [-0.74, -0.04],
      [-0.38, 0.04],
      [0.08, 0.16],
      [0.62, 0.34],
      [1.2, 0.64],
      [0.7, 0.18],
      [0.08, -0.18],
      [-0.58, -0.42],
      [-0.98, -0.5],
    ],
    stretch: { x: 1.45, y: 0.82 },
    intent:
      "open GPS-art sweep using out-and-back thickness instead of a literal closed outline",
  },
];

function routeUnitLength(points: Array<[number, number]>): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return length;
}

function localGpsArtRecipeAnchors(
  recipe: LearnedGpsArtRecipe,
  center: [number, number],
  metersPerUnit: number,
  xBearingDeg: number,
): [number, number][] {
  const xAxis = bearingUnitVector(xBearingDeg);
  const yAxis = bearingUnitVector(xBearingDeg + 90);
  return recipe.points.map(([x, y]) => {
    const localX = x * metersPerUnit * recipe.stretch.x;
    const localY = y * metersPerUnit * recipe.stretch.y;
    const east = localX * xAxis.east + localY * yAxis.east;
    const north = localX * xAxis.north + localY * yAxis.north;
    return offsetLatLngMeters(center, east, north);
  });
}

function isLearnedSwooshGpsArtDraft(drafts: MapNativeDesignDraft[]): boolean {
  const text = draftSearchText(drafts);
  return /\b(nike|swoosh|checkmark|check-mark|check mark|tick|wing|sweep|sweeping|ribbon|rising tail)\b/.test(
    text,
  );
}

function learnedSweepBearings(preset: CityPreset): number[] {
  const bearings = preset.dominantGridBearingsDeg ?? [];
  if (bearings.length <= 1) return bearings;
  const ordered = bearings
    .slice()
    .sort(
      (a, b) =>
        Math.abs(bearingUnitVector(b).east) -
        Math.abs(bearingUnitVector(a).east),
    );
  const best = Math.abs(bearingUnitVector(ordered[0]!).east);
  const floor = Math.max(0.55, best * 0.72);
  return ordered.filter((bearing) => Math.abs(bearingUnitVector(bearing).east) >= floor);
}

export function learnedGpsArtGrammarCandidates(
  drafts: MapNativeDesignDraft[],
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  const bearings = learnedSweepBearings(preset);
  if (drafts.length === 0 || bearings.length === 0) return [];
  if (!isLearnedSwooshGpsArtDraft(drafts)) return [];

  const targetKm =
    targetDistanceKm != null && Number.isFinite(targetDistanceKm)
      ? targetDistanceKm
      : 10;
  const centers = cityFocusCenters(preset).slice(
    0,
    preset.id === "manhattan" ? 8 : 10,
  );
  const boundsMargin = preset.id === "manhattan" ? 0.003 : MARGIN;
  const out: MapNativeCandidate[] = [];

  for (const recipe of LEARNED_SWOOSH_GPS_ART_RECIPES) {
    const unitLength = routeUnitLength(recipe.points);
    if (unitLength <= 0) continue;
    const baseMeters = Math.max(
      680,
      Math.min(1900, (targetKm * 1000) / unitLength),
    );
    for (const center of centers) {
      for (const bearing of bearings) {
        for (const scale of [0.86, 1, 1.16]) {
          const anchors = localGpsArtRecipeAnchors(
            recipe,
            center,
            baseMeters * scale,
            bearing,
          );
          if (
            anchors.length < 2 ||
            !candidateStaysInBounds(anchors, preset, boundsMargin)
          ) {
            continue;
          }
          const km = routeLengthKm(anchors);
          if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) continue;
          if (
            targetDistanceKm != null &&
            Number.isFinite(targetDistanceKm) &&
            (km < targetDistanceKm * 0.55 || km > targetDistanceKm * 1.95)
          ) {
            continue;
          }
          out.push({
            placement: sourceAlignedPlacementFromAnchors(anchors, bearing),
            anchors,
            km,
            designIntent: `Learned GPS-art swoosh grammar (${recipe.id}): ${recipe.intent}. Built as runnable street-scale art, then Mapbox-snapped; no direct-grid bypass.`,
            kind: "street-design",
          });
        }
      }
    }
  }

  return diverseSubsample(out, Math.min(18, out.length), preset);
}

export function cityGridSketchCandidates(
  drafts: MapNativeDesignDraft[],
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  const bearings = preset.dominantGridBearingsDeg ?? [];
  if (drafts.length === 0 || bearings.length === 0) return [];

  const centers = cityFocusCenters(preset);
  const out: MapNativeCandidate[] = [];
  const prioritySweepRoutes: MapNativeCandidate[] = [];
  const targetKm =
    targetDistanceKm != null && Number.isFinite(targetDistanceKm)
      ? targetDistanceKm
      : 10;

  const variants = drafts.slice(0, 6).flatMap(streetDraftVariants);
  for (const draft of variants) {
    if (isBoltDraft(draft) && !isSweepingCurveDraft(draft)) {
      out.push(...manhattanBoltCandidates(draft, preset, targetDistanceKm));
    }
    if (isSweepingCurveDraft(draft)) {
      prioritySweepRoutes.push(
        ...manhattanOpenSweepCandidates(draft, preset, targetDistanceKm),
      );
      out.push(
        ...manhattanTaperedSwooshCandidates(draft, preset, targetDistanceKm),
        ...manhattanRibbonSweepCandidates(draft, preset, targetDistanceKm),
      );
    }
    const unitLength = localPolylineLength(draft.points);
    if (unitLength <= 0) continue;
    const sweepLike = isSweepingCurveDraft(draft);
    const taperedOutlineLike = isTaperedOutlineDraft(draft);
    const baseUnitMeters = Math.max(
      sweepLike ? 620 : 520,
      Math.min(sweepLike ? 1900 : 1600, (targetKm * 1000) / unitLength),
    );
    for (const center of centers.slice(0, 8)) {
      for (const bearing of bearings) {
        const shapeScales = sweepLike
          ? taperedOutlineLike
            ? [
                { m: 0.82, stretch: { x: 1.62, y: 0.82 } },
                { m: 0.92, stretch: { x: 1.45, y: 0.96 } },
                { m: 1.02, stretch: { x: 1.28, y: 1.1 } },
                { m: 0.94, stretch: { x: 1.12, y: 1.24 } },
              ]
            : [
                { m: 0.82, stretch: { x: 1.75, y: 0.46 } },
                { m: 0.95, stretch: { x: 1.5, y: 0.56 } },
                { m: 1.08, stretch: { x: 1.25, y: 0.68 } },
                { m: 1, stretch: { x: 1, y: 1 } },
              ]
          : [
              { m: 0.9, stretch: { x: 1, y: 1 } },
              { m: 1, stretch: { x: 1, y: 1 } },
              { m: 1.12, stretch: { x: 1, y: 1 } },
            ];
        for (const { m, stretch } of shapeScales) {
          const anchors = sketchAnchorsOnCityGrid(
            draft.points,
            center,
            baseUnitMeters * m,
            bearing,
            stretch,
          );
          if (
            anchors.length < 2 ||
            !candidateStaysInBounds(anchors, preset)
          ) {
            continue;
          }
          const km = routeLengthKm(anchors);
          if (km < MIN_ROUTE_KM || km > MAX_ROUTE_KM) continue;
          if (
            targetDistanceKm != null &&
            Number.isFinite(targetDistanceKm) &&
            (km < targetDistanceKm * 0.6 || km > targetDistanceKm * 1.6)
          ) {
            continue;
          }
          out.push({
            placement: sourceAlignedPlacementFromAnchors(anchors, bearing),
            anchors,
            km,
            designIntent: `Street-native ${draft.label}: ${draft.description}${
              draft.visualFeatures?.length
                ? ` Features: ${draft.visualFeatures.join(", ")}.`
                : ""
            }`,
            kind: "street-design",
          });
        }
      }
    }
  }

  if (prioritySweepRoutes.length > 0) {
    const priority = prioritySweepRoutes.slice(0, Math.min(8, prioritySweepRoutes.length));
    const restBudget = Math.max(0, 24 - priority.length);
    return [
      ...priority,
      ...diverseSubsample(out, Math.min(restBudget, out.length), preset),
    ];
  }

  return diverseSubsample(out, Math.min(24, out.length), preset);
}

export function generateMapNativeCandidates({
  drafts,
  preset,
  targetDistanceKm,
  wordmarkText,
}: MapNativeDesignerOptions): MapNativeCandidate[] {
  const gasLogo = isGasLogoDraftSet(drafts);
  const gasGridRoutes = gasLogo
    ? streetGasLogoCandidates(preset, targetDistanceKm)
    : [];
  const verifiedBankRoutes = preset.id === "manhattan"
    ? []
    : verifiedRouteBankCandidates(drafts, preset, targetDistanceKm);
  const routeLibraryRoutes = preset.id === "manhattan"
    ? manhattanRouteLibraryCandidates(drafts, preset, targetDistanceKm)
    : [];
  const learnedGrammarRoutes = learnedGpsArtGrammarCandidates(
    drafts,
    preset,
    targetDistanceKm,
  );
  const monogramRoutes = streetMonogramCandidates(
    wordmarkText,
    preset,
    targetDistanceKm,
  );
  const wordmarkRoutes = streetWordmarkCandidates(
    wordmarkText,
    preset,
    targetDistanceKm,
  );
  if (wordmarkText && wordmarkRoutes.length > 0) {
    return wordmarkRoutes;
  }
  if (gasLogo && gasGridRoutes.length > 0) {
    return diverseSubsample(
      [...verifiedBankRoutes, ...gasGridRoutes, ...routeLibraryRoutes],
      Math.min(32, verifiedBankRoutes.length + gasGridRoutes.length + routeLibraryRoutes.length),
      preset,
    );
  }
  return [
    ...verifiedBankRoutes,
    ...routeLibraryRoutes,
    ...learnedGrammarRoutes,
    ...monogramRoutes,
    ...wordmarkRoutes,
    ...cityGridSketchCandidates(drafts, preset, targetDistanceKm),
  ];
}





