/**
 * Photo line-mask → normalized contour (0–1 coordinates). Shared by Step 1 UI
 * and the optional Web Worker so heavy raster work can run off the main thread.
 */

import * as d3 from "d3-contour";
import { simplifyCartesian } from "./douglasPeucker";
import {
  medianMinDistBetweenRings,
  stitchNestedHoleRingsInPlace,
  weaveInnerRingIntoOuter,
} from "./contourRingStitch";
import {
  centerlinePolylineFromPreparedBinary,
  prepareTracedBinaryMask,
} from "./centerlineFromMask";
import {
  mooreContourRingsFromLineMask,
  mooreSiblingOuterRings,
} from "./mooreBoundaryFromMask";

export type NormalizedContourPoint = { x: number; y: number };

function binaryPrepToLineMask(prep: Uint8Array, len: number): Uint8Array {
  const m = new Uint8Array(len);
  const n = Math.min(len, prep.length);
  for (let i = 0; i < n; i++) {
    if (prep[i]) m[i] = 255;
  }
  return m;
}

function ringAreaAbs(ring: [number, number][]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % n]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

const MIN_RING_AREA_PX2 = 8;
const MAX_SHAPES_LISTED = 8;
const MAX_RINGS_LISTED = 8;

function extractPolygonRingGroups(
  field: Float32Array,
  level: number,
  w: number,
  h: number,
): [number, number][][][] {
  const contourGenerator = d3.contours().size([w, h]);
  const [contour] = contourGenerator.thresholds([level])(Array.from(field));
  if (!contour) return [];

  const groups: [number, number][][][] = [];
  for (const multi of contour.coordinates) {
    const rings: [number, number][][] = [];
    for (const ring of multi) {
      const r = ring as [number, number][];
      const area = ringAreaAbs(r);
      if (area < MIN_RING_AREA_PX2 || r.length < 4) continue;
      rings.push(r);
    }
    if (rings.length) groups.push(rings);
  }
  groups.sort((a, b) => ringAreaAbs(b[0] ?? []) - ringAreaAbs(a[0] ?? []));
  return groups.slice(0, MAX_SHAPES_LISTED);
}

function extractAllRingsFromField(
  field: Float32Array,
  level: number,
  w: number,
  h: number,
): [number, number][][] {
  const groups = extractPolygonRingGroups(field, level, w, h);
  const rings = groups.flat();
  rings.sort((a, b) => ringAreaAbs(b) - ringAreaAbs(a));
  return rings.slice(0, MAX_RINGS_LISTED);
}

function maskToFloatField(mask: Uint8Array): Float32Array {
  const field = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    field[i] = mask[i] / 255;
  }
  return field;
}

function buildInkEdgeMap(mask: Uint8Array, w: number, h: number): Uint8Array {
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] <= 127) continue;
      const up = y > 0 ? mask[i - w] : 0;
      const dn = y < h - 1 ? mask[i + w] : 0;
      const lf = x > 0 ? mask[i - 1] : 0;
      const rt = x < w - 1 ? mask[i + 1] : 0;
      if (up <= 127 || dn <= 127 || lf <= 127 || rt <= 127) {
        edge[i] = 1;
      }
    }
  }
  return edge;
}

function ringPolylineLength(ring: [number, number][]): number {
  const n = ring.length;
  if (n < 2) return 0;
  let len = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}

function ringInkBoundaryScore(
  edgeMap: Uint8Array,
  ring: [number, number][],
  w: number,
  h: number,
): number {
  let hits = 0;
  const step = Math.max(1, Math.floor(ring.length / 600));
  for (let k = 0; k < ring.length; k += step) {
    const xr = Math.round(ring[k]![0]);
    const yr = Math.round(ring[k]![1]);
    let seen = false;
    for (let dy = -2; dy <= 2 && !seen; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = xr + dx;
        const y = yr + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (edgeMap[y * w + x] !== 0) {
          seen = true;
          break;
        }
      }
    }
    if (seen) hits++;
  }
  return hits;
}

function sortContourRingsByInkEdges(
  mask: Uint8Array,
  rings: [number, number][][],
  w: number,
  h: number,
): void {
  if (rings.length < 2) return;
  const edge = buildInkEdgeMap(mask, w, h);
  const scored = rings.map((ring) => ({
    ring,
    s: ringInkBoundaryScore(edge, ring, w, h),
    len: ringPolylineLength(ring),
  }));
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    return b.len - a.len;
  });
  rings.length = 0;
  for (const row of scored) {
    rings.push(row.ring);
  }
}

function dedupeNearlyParallelContourRings(rings: [number, number][][]): void {
  if (rings.length < 2) return;
  const keep: [number, number][][] = [];
  for (const r of rings) {
    let merged = false;
    for (let k = 0; k < keep.length; k++) {
      const k2 = keep[k]!;
      const med = medianMinDistBetweenRings(r, k2);
      const ar = ringAreaAbs(r) / Math.max(1, ringAreaAbs(k2));
      const ar2 = ringAreaAbs(k2) / Math.max(1, ringAreaAbs(r));
      if (med < 1.85 && (ar > 0.46 || ar2 > 0.46)) {
        if (ringPolylineLength(r) >= ringPolylineLength(k2)) {
          keep[k] = r;
        }
        merged = true;
        break;
      }
    }
    if (!merged) keep.push(r);
  }
  rings.length = 0;
  for (const r of keep) rings.push(r);
}

/**
 * Simplify a closed pixel-space ring using the shared DP utility.
 * Re-closes the ring if DP opens the endpoint gap beyond 0.6 px.
 * `dense` flag selects tighter tolerances for Moore boundary traces,
 * which are noisier (pixel-grid staircase) than d3-contour output.
 */
function simplifyRingPx(
  ring: [number, number][],
  dense = false,
): [number, number][] {
  if (ring.length < 5) return ring;
  let tolerancePx: number;
  if (dense) {
    tolerancePx = ring.length > 3200 ? 0.35 : ring.length > 1600 ? 0.22 : 0.12;
  } else {
    tolerancePx = ring.length > 900 ? 0.9 : 0.5;
  }
  const coords = simplifyCartesian(ring, tolerancePx);
  if (coords.length < 3) return ring;
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.6) {
    return [...coords, first];
  }
  return coords;
}

function computeSortedContourRings(
  mask: Uint8Array,
  level: number,
  w: number,
  h: number,
): [number, number][][] {
  const field = maskToFloatField(mask);
  const rings = extractAllRingsFromField(field, level, w, h);
  dedupeNearlyParallelContourRings(rings);
  stitchNestedHoleRingsInPlace(rings);
  if (rings.length > 1) {
    sortContourRingsByInkEdges(mask, rings, w, h);
  }
  return rings;
}

function curvatureAdaptiveSample(
  ring: [number, number][],
  targetCount: number,
): [number, number][] {
  const n = ring.length;
  if (targetCount >= n) return ring;

  const weights: number[] = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n]!;
    const curr = ring[i]!;
    const next = ring[(i + 1) % n]!;

    const v1x = curr[0] - prev[0];
    const v1y = curr[1] - prev[1];
    const v2x = next[0] - curr[0];
    const v2y = next[1] - curr[1];

    const dot = v1x * v2x + v1y * v2y;
    const mag1 = Math.hypot(v1x, v1y) || 1;
    const mag2 = Math.hypot(v2x, v2y) || 1;
    const cosTheta = Math.min(1, Math.max(-1, dot / (mag1 * mag2)));
    const angle = Math.acos(cosTheta);

    const segmentLen = mag2;
    const curvatureWeight = 1 + 4 * (angle / Math.PI);
    weights[i] = segmentLen * curvatureWeight;
  }

  const cumulative: number[] = new Array(n + 1);
  cumulative[0] = 0;
  for (let i = 0; i < n; i++) {
    cumulative[i + 1] = cumulative[i] + weights[i]!;
  }
  const total = cumulative[n]!;
  if (total === 0) return ring;

  const sampled: [number, number][] = [];
  for (let k = 0; k < targetCount; k++) {
    const t = (k / targetCount) * total;
    let idx = binarySearchCumulative(cumulative, t);
    if (idx >= n) idx = n - 1;
    sampled.push(ring[idx]!);
  }

  return sampled;
}

function binarySearchCumulative(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid]! < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1 >= 0 ? lo - 1 : 0;
}

export function extractNormalizedContourFromLineMask(
  mask: Uint8Array,
  level: number,
  w: number,
  h: number,
): NormalizedContourPoint[] | null {
  let ring: [number, number][] | null = null;
  let usedMoore = false;
  let usedCenterline = false;

  const prep = prepareTracedBinaryMask(mask, w, h);
  const traceMask = prep ? binaryPrepToLineMask(prep, mask.length) : null;

  if (prep) {
    const center = centerlinePolylineFromPreparedBinary(prep, w, h);
    if (center && center.length >= 4) {
      ring = center;
      usedCenterline = true;
    }
  }

  if (!ring && traceMask) {
    const mooreRings = mooreContourRingsFromLineMask(traceMask, w, h);
    if (mooreRings?.length) {
      usedMoore = true;
      const rings = mooreRings.map((r) => r.slice());
      stitchNestedHoleRingsInPlace(rings);
      let combined = rings[0] ?? null;

      // Bridge disconnected sibling components into one continuous path.
      // Lets a user upload an image with two separate letters (or any shape
      // that broke into multiple pieces during line-art extraction) without
      // having to hand-draw a connector in Step 1.
      if (combined) {
        const siblings = mooreSiblingOuterRings(traceMask, w, h);
        for (const sib of siblings) {
          combined = weaveInnerRingIntoOuter(combined, sib);
        }
      }
      ring = combined;
    }
  }
  if (!ring) {
    const rings = computeSortedContourRings(traceMask ?? mask, level, w, h);
    ring = rings[0] ?? null;
  }
  if (ring === null || ring.length < 4) return null;

  const useLightSimplify = usedMoore || usedCenterline;
  const smoothed =
    usedCenterline && ring.length < 900
      ? ring
      : simplifyRingPx(ring, useLightSimplify);
  const target = useLightSimplify
    ? Math.min(560, Math.max(320, Math.floor(smoothed.length * 0.62)))
    : Math.min(200, Math.max(120, Math.floor(smoothed.length / 3)));
  const sampled = curvatureAdaptiveSample(smoothed, target);
  return sampled.map(([x, y]) => ({
    x: x / w,
    y: y / h,
  }));
}
