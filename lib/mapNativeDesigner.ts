import type { CityPreset } from "./cityPresets";
import type { ContourPoint, PlacementTransform } from "./placementFromContour";

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
  return out;
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
  return out;
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
  return out;
}

function blockLetterStroke(letter: string): ContourPoint[] {
  switch (letter) {
    case "A":
      return [
        { x: 0, y: 4 },
        { x: 0, y: 0 },
        { x: 2.4, y: 0 },
        { x: 2.4, y: 4 },
        { x: 2.4, y: 2 },
        { x: 0, y: 2 },
        { x: 0, y: 4 },
      ];
    case "E":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 4 },
        { x: 2.4, y: 4 },
        { x: 0, y: 4 },
        { x: 0, y: 2 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
        { x: 0, y: 0 },
        { x: 2.4, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 4 },
        { x: 2.4, y: 4 },
      ];
    case "H":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 4 },
        { x: 0, y: 2 },
        { x: 2.4, y: 2 },
        { x: 2.4, y: 0 },
        { x: 2.4, y: 4 },
      ];
    case "L":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 4 },
        { x: 2.4, y: 4 },
      ];
    case "N":
      return [
        { x: 0, y: 4 },
        { x: 0, y: 0 },
        { x: 0.6, y: 0 },
        { x: 0.6, y: 1 },
        { x: 1.2, y: 1 },
        { x: 1.2, y: 2 },
        { x: 1.8, y: 2 },
        { x: 1.8, y: 3 },
        { x: 2.4, y: 3 },
        { x: 2.4, y: 0 },
        { x: 2.4, y: 4 },
      ];
    case "M":
      return [
        { x: 0, y: 4 },
        { x: 0, y: 0 },
        { x: 0.6, y: 0 },
        { x: 0.6, y: 1.6 },
        { x: 1.2, y: 1.6 },
        { x: 1.2, y: 0 },
        { x: 1.8, y: 0 },
        { x: 1.8, y: 1.6 },
        { x: 2.4, y: 1.6 },
        { x: 2.4, y: 0 },
        { x: 2.4, y: 4 },
      ];
    case "P":
      return [
        { x: 0, y: 4 },
        { x: 0, y: 0 },
        { x: 2.4, y: 0 },
        { x: 2.4, y: 2 },
        { x: 0, y: 2 },
        { x: 0, y: 4 },
        { x: 2.4, y: 4 },
      ];
    case "R":
      return [
        { x: 0, y: 4 },
        { x: 0, y: 0 },
        { x: 2.4, y: 0 },
        { x: 2.4, y: 2 },
        { x: 0, y: 2 },
        { x: 1.2, y: 2 },
        { x: 1.2, y: 3 },
        { x: 1.8, y: 3 },
        { x: 1.8, y: 4 },
        { x: 2.4, y: 4 },
      ];
    case "U":
      return [
        { x: 0, y: 0 },
        { x: 0, y: 3.2 },
        { x: 0.4, y: 4 },
        { x: 2, y: 4 },
        { x: 2.4, y: 3.2 },
        { x: 2.4, y: 0 },
      ];
    default:
      return gridLetterStroke(letter).map((p) => ({
        x: p.x * 1.2,
        y: (p.y / 3) * 4,
      }));
  }
}

function blockWordmarkRawStrokePoints(word: string): ContourPoint[] {
  const letters = word
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 8)
    .split("");
  const out: ContourPoint[] = [];
  const advance = 3.35;
  for (let i = 0; i < letters.length; i++) {
    const ox = i * advance;
    const glyph = blockLetterStroke(letters[i]!).slice();
    const first = glyph[0]!;
    if (Math.hypot(first.x, first.y - 4) > 0.01) {
      glyph.unshift({ x: 0, y: 4 });
    }
    const last = glyph[glyph.length - 1]!;
    if (Math.hypot(last.x - 2.4, last.y - 4) > 0.15) {
      glyph.push({ x: 2.4, y: 4 });
    }
    if (out.length > 0) out.push({ x: ox, y: 4 });
    for (const p of glyph) out.push({ x: ox + p.x, y: p.y });
  }
  return out;
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
  const yAxis = bearingUnitVector(xBearingDeg + 90);

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
          if (anchors.length < 2 || !candidateStaysInBounds(anchors, preset)) {
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

export function manhattanRouteLibraryCandidates(
  drafts: MapNativeDesignDraft[],
  preset: CityPreset,
  targetDistanceKm?: number,
): MapNativeCandidate[] {
  if (preset.id !== "manhattan") return [];
  const text = draftSearchText(drafts);
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

  return recipes
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
    .filter((candidate): candidate is MapNativeCandidate => candidate != null);
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
    .replace(/[^A-Z]/g, "")
    .slice(0, 8);
  if (cleanWord.length < 2) return [];
  const letterSequence = cleanWord.split("").join(" ");

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
          if (anchors.length < 2 || !candidateStaysInBounds(anchors, preset)) {
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
  const routeLibraryRoutes = manhattanRouteLibraryCandidates(
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
      [...gasGridRoutes, ...routeLibraryRoutes],
      Math.min(32, gasGridRoutes.length + routeLibraryRoutes.length),
      preset,
    );
  }
  return [
    ...routeLibraryRoutes,
    ...monogramRoutes,
    ...wordmarkRoutes,
    ...cityGridSketchCandidates(drafts, preset, targetDistanceKm),
  ];
}
