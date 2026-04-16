"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import * as d3 from "d3-contour";
import * as turf from "@turf/turf";
import {
  medianMinDistBetweenRings,
  stitchNestedHoleRingsInPlace,
} from "../lib/contourRingStitch";
import { fillLineMaskPrimaryPlusEnclosedHoles } from "../lib/inkMaskUnionEnclosed";

export type NormalizedPoint = { x: number; y: number };

const BOX_SIZE = 300;
/** Supersample factor for luminance (2×2 min-pool preserves hole counters vs AA blur). */
const LUM_SAMPLE_SUPER = 2;
const LUM_SAMPLE_PX = BOX_SIZE * LUM_SAMPLE_SUPER;
const DEFAULT_BRUSH = 6;
const MAX_LINE_UNDO = 28;
const DEFAULT_CONTOUR_LEVEL = 0.22;

type UploadedImage = {
  url: string;
  file: File;
};

type Step1ImageUploadProps = {
  onComplete: (normalizedContour: NormalizedPoint[]) => void;
  /** Back to source picker (image vs freehand). */
  onBack?: () => void;
};

type Tool = "draw" | "erase";

/** Same hex as contour stroke; line-art raster uses these RGB values (no drift). */
const CONTOUR_STROKE = "#404040";
const OUTLINE_RGB = (() => {
  const h = CONTOUR_STROKE.slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  } as const;
})();

/** Pen nib hotspot (px) in 32×32 SVG — tip at lower-left. */
const PEN_HOTSPOT_X = 4;
const PEN_HOTSPOT_Y = 28;

/** CSS px ≈ displayed canvas width — keep in sync with panel canvas max width classes. */
const CURSOR_DISPLAY_PX = 236;

function lineArtCursorCss(tool: Tool, brushRadius: number): string {
  const rCss = Math.round(
    Math.max(4, Math.min(46, (brushRadius / BOX_SIZE) * CURSOR_DISPLAY_PX)),
  );

  if (tool === "erase") {
    const pad = 3;
    const size = Math.min(128, Math.max(14, 2 * (rCss + pad)));
    const c = size / 2;
    const r = Math.min(rCss, c - pad);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#fb923c" stroke-width="2"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(c)} ${Math.round(c)}, crosshair`;
  }

  const t = (brushRadius - 2) / 20;
  const penPx = Math.round(22 + Math.max(0, Math.min(1, t)) * 20);
  const hx = Math.round((PEN_HOTSPOT_X * penPx) / 32);
  const hy = Math.round((PEN_HOTSPOT_Y * penPx) / 32);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${penPx}" height="${penPx}" viewBox="0 0 32 32"><path d="M4 26 L10 20 L22 8 L26 12 L14 24 L8 28 Z" fill="#e5e5e5" stroke="#171717" stroke-width="1.2" stroke-linejoin="round"/><path d="M22 8 L24 6 L27 9 L25 11 Z" fill="#a3a3a3" stroke="#171717" stroke-width="1"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, crosshair`;
}

/** Ink strength 0 = paper, 1 = black (matches Step1 luminance convention). */
function luminanceFromRgba(data: Uint8ClampedArray, idx: number): number {
  const a = data[idx + 3];
  if (a < 128) return 0;
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  const gray = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return 1 - gray;
}

/**
 * Downsample supersampled ImageData to BOX_SIZE using a 2×2 min on ink strength.
 * Any subpixel that is still paper white keeps the cell below threshold, so
 * anti-aliased hole interiors don’t “fill in” as one solid blob.
 */
function buildLuminanceMinPool2x2(
  imageData: ImageData,
  superW: number,
): Float32Array {
  const data = imageData.data;
  const lum = new Float32Array(BOX_SIZE * BOX_SIZE);
  for (let y = 0; y < BOX_SIZE; y++) {
    for (let x = 0; x < BOX_SIZE; x++) {
      let minL = 1;
      for (let dy = 0; dy < LUM_SAMPLE_SUPER; dy++) {
        for (let dx = 0; dx < LUM_SAMPLE_SUPER; dx++) {
          const sx = x * LUM_SAMPLE_SUPER + dx;
          const sy = y * LUM_SAMPLE_SUPER + dy;
          const idx = (sy * superW + sx) * 4;
          const l = luminanceFromRgba(data, idx);
          if (l < minL) minL = l;
        }
      }
      lum[y * BOX_SIZE + x] = minL;
    }
  }
  return lum;
}

/** Shoelace area (pixel²); prefers outer boundary over inner “double line” loops. */
function ringAreaAbs(ring: [number, number][]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

/** Ignore dust rings from contour noise (px²). Holes can be small—keep low. */
const MIN_RING_AREA_PX2 = 8;
const MAX_SHAPES_LISTED = 8;
const MAX_RINGS_LISTED = 8;

/**
 * d3-contour returns GeoJSON MultiPolygon: each entry is [outer, ...holes].
 * A letter like R is one polygon with two rings (outline + hole counter)—we
 * must stroke all of them when seeding line art, not only the largest ring.
 */
function extractPolygonRingGroups(
  field: Float32Array,
  level: number,
): [number, number][][][] {
  const contourGenerator = d3.contours().size([BOX_SIZE, BOX_SIZE]);
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

/**
 * Flattened rings at this threshold (largest ring first). Used for the blurred
 * line mask → final contour step.
 */
function extractAllRingsFromField(
  field: Float32Array,
  level: number,
): [number, number][][] {
  const groups = extractPolygonRingGroups(field, level);
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

/** Ink pixels that touch background (true boundary of the line art). */
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

/**
 * d3 iso-rings on a blurred field favor a smooth “outer shell” and can miss
 * narrow bridges. On the binary mask, re-rank rings so index 0 follows real
 * ink edges (bridges, inner loops) before area alone.
 */
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

/**
 * Marching squares on thick ink often yields two almost-parallel iso-loops
 * (inner vs outer edge of the same brush). Keep one ring per such pair.
 */
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

function simplifyRingPx(ring: [number, number][]): [number, number][] {
  if (ring.length < 5) return ring;
  const tolerancePx = ring.length > 900 ? 0.62 : 0.36;
  const ls = turf.lineString(ring.map(([x, y]) => [x, y]));
  const out = turf.simplify(ls, {
    tolerance: tolerancePx,
    highQuality: true,
  });
  const coords = out.geometry.coordinates as [number, number][];
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
  const rings = extractAllRingsFromField(field, level);
  dedupeNearlyParallelContourRings(rings);
  stitchNestedHoleRingsInPlace(rings);
  if (rings.length > 1) {
    sortContourRingsByInkEdges(mask, rings, w, h);
  }
  return rings;
}

/** 4-connected foreground components (label 1…n, 0 = background). */
function labelConnectedComponents4(
  binary: Uint8Array,
  w: number,
  h: number,
): Int32Array {
  const labels = new Int32Array(w * h);
  let nextLabel = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (binary[i] === 0 || labels[i] !== 0) continue;
      nextLabel++;
      const stack: number[] = [i];
      while (stack.length) {
        const j = stack.pop()!;
        if (labels[j] !== 0) continue;
        if (binary[j] === 0) continue;
        labels[j] = nextLabel;
        const jx = j % w;
        const jy = (j / w) | 0;
        if (jx > 0) stack.push(j - 1);
        if (jx < w - 1) stack.push(j + 1);
        if (jy > 0) stack.push(j - w);
        if (jy < h - 1) stack.push(j + w);
      }
    }
  }
  return labels;
}

function componentEntriesSorted(
  labels: Int32Array,
  maxLabel: number,
): { label: number; count: number }[] {
  if (maxLabel <= 0) return [];
  const counts = new Array<number>(maxLabel + 1).fill(0);
  for (let i = 0; i < labels.length; i++) {
    const L = labels[i];
    if (L > 0) counts[L]++;
  }
  const out: { label: number; count: number }[] = [];
  for (let L = 1; L <= maxLabel; L++) {
    if (counts[L] > 0) out.push({ label: L, count: counts[L] });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/** Binarize luminance at threshold and label 4-connected ink blobs. */
function buildPhotoComponents(
  lum: Float32Array,
  threshold: number,
): {
  labels: Int32Array;
  entries: { label: number; count: number }[];
} {
  const binary = new Uint8Array(BOX_SIZE * BOX_SIZE);
  for (let i = 0; i < binary.length; i++) {
    binary[i] = lum[i] >= threshold ? 1 : 0;
  }
  const labels = labelConnectedComponents4(binary, BOX_SIZE, BOX_SIZE);
  let maxLabel = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] > maxLabel) maxLabel = labels[i];
  }
  const entries = componentEntriesSorted(labels, maxLabel);
  return { labels, entries };
}

export default function Step1ImageUpload({
  onComplete,
  onBack,
}: Step1ImageUploadProps) {
  const traceFileInputId = useId();
  const [uploadedImage, setUploadedImage] = useState<UploadedImage | null>(
    null,
  );
  const [threshold, setThreshold] = useState(0.5);
  const [contourLevel, setContourLevel] = useState(DEFAULT_CONTOUR_LEVEL);
  const [tool, setTool] = useState<Tool>("draw");
  const [brushRadius, setBrushRadius] = useState(DEFAULT_BRUSH);
  const [imageReady, setImageReady] = useState(false);
  const [contourBuilt, setContourBuilt] = useState(false);
  const [normalizedContour, setNormalizedContour] = useState<
    NormalizedPoint[] | null
  >(null);
  const [undoCount, setUndoCount] = useState(0);
  /** Which disconnected shape (polygon) from the photo seeds line art. */
  const [photoShapeIndex, setPhotoShapeIndex] = useState(0);
  const [photoShapeCount, setPhotoShapeCount] = useState(0);
  /** Which ring from the blurred line mask becomes the final route. */
  const [lineRingIndex, setLineRingIndex] = useState(0);
  /** Bumps when line mask bytes change so contour preview can refresh. */
  const [lineMaskVersion, setLineMaskVersion] = useState(0);
  /** Mirrors lineArtDirtyRef for UI (ring picker disabled after edits). */
  const [lineArtDirty, setLineArtDirty] = useState(false);

  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lineArtCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const contourCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const luminanceRef = useRef<Float32Array | null>(null);
  const lineMaskRef = useRef<Uint8Array | null>(null);
  const lineArtDirtyRef = useRef(false);
  const paintingRef = useRef(false);
  const strokeDirtyRef = useRef(false);

  const lineUndoStackRef = useRef<Uint8Array[]>([]);
  const lineUndoIndexRef = useRef(-1);
  const lastPhotoSeedKeyRef = useRef<string>("");
  const prevContourBuiltRef = useRef(false);

  const bumpLineMaskVersion = useCallback(() => {
    setLineMaskVersion((v) => v + 1);
  }, []);

  const drawLineMaskToCanvas = useCallback(() => {
    const canvas = lineArtCanvasRef.current;
    const lineMask = lineMaskRef.current;
    if (!canvas || !lineMask) return;
    const ctx = canvas.getContext("2d", { colorSpace: "srgb" });
    if (!ctx) return;
    const img = ctx.createImageData(BOX_SIZE, BOX_SIZE);
    const { r, g, b } = OUTLINE_RGB;
    for (let i = 0; i < BOX_SIZE * BOX_SIZE; i++) {
      const ink = lineMask[i] > 80;
      const o = i * 4;
      if (ink) {
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      } else {
        img.data[o] = 0;
        img.data[o + 1] = 0;
        img.data[o + 2] = 0;
        img.data[o + 3] = 0;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, []);

  const replaceLineUndoWithCurrent = useCallback(() => {
    const m = lineMaskRef.current;
    if (!m) return;
    lineUndoStackRef.current = [new Uint8Array(m)];
    lineUndoIndexRef.current = 0;
    setUndoCount(0);
  }, []);

  const pushLineUndo = useCallback(() => {
    const m = lineMaskRef.current;
    if (!m) return;
    const copy = new Uint8Array(m);
    const stack = lineUndoStackRef.current;
    const idx = lineUndoIndexRef.current;
    lineUndoStackRef.current = stack.slice(0, idx + 1);
    lineUndoStackRef.current.push(copy);
    lineUndoIndexRef.current = lineUndoStackRef.current.length - 1;
    while (lineUndoStackRef.current.length > MAX_LINE_UNDO) {
      lineUndoStackRef.current.shift();
      lineUndoIndexRef.current--;
    }
    setUndoCount(lineUndoIndexRef.current);
  }, []);

  const contourPointsFromLineMask = useCallback(
    (level: number): NormalizedPoint[] | null => {
      void lineMaskVersion;
      const mask = lineMaskRef.current;
      if (!mask) return null;
      const rings = computeSortedContourRings(mask, level, BOX_SIZE, BOX_SIZE);
      const ri = Math.min(lineRingIndex, Math.max(0, rings.length - 1));
      const ring = rings[ri] ?? null;
      if (ring === null || ring.length < 4) return null;
      const smoothed = simplifyRingPx(ring);
      const target = Math.min(
        200,
        Math.max(120, Math.floor(smoothed.length / 3)),
      );
      const sampled = curvatureAdaptiveSample(smoothed, target);
      return sampled.map(([x, y]) => ({
        x: x / BOX_SIZE,
        y: y / BOX_SIZE,
      }));
    },
    [lineRingIndex, lineMaskVersion],
  );

  const drawContourPreview = useCallback((points: NormalizedPoint[]) => {
    const canvas = contourCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, BOX_SIZE, BOX_SIZE);
    ctx.strokeStyle = CONTOUR_STROKE;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    points.forEach((p, idx) => {
      const x = p.x * BOX_SIZE;
      const y = p.y * BOX_SIZE;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }, []);

  const drawContourPlaceholder = useCallback(() => {
    const canvas = contourCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, BOX_SIZE, BOX_SIZE);
  }, []);

  const applyContourToCanvas = useCallback(
    (pts: NormalizedPoint[] | null) => {
      if (pts?.length) {
        drawContourPreview(pts);
      } else {
        drawContourPlaceholder();
      }
    },
    [drawContourPreview, drawContourPlaceholder],
  );

  const undoLineArt = useCallback(() => {
    const idx = lineUndoIndexRef.current;
    if (idx <= 0) return;
    lineUndoIndexRef.current = idx - 1;
    const prev = lineUndoStackRef.current[idx - 1];
    lineMaskRef.current?.set(prev);
    lineArtDirtyRef.current = true;
    setLineArtDirty(true);
    drawLineMaskToCanvas();
    setUndoCount(lineUndoIndexRef.current);
    if (contourBuilt) {
      const pts = contourPointsFromLineMask(contourLevel);
      setNormalizedContour(pts);
      requestAnimationFrame(() => applyContourToCanvas(pts));
    }
  }, [
    contourBuilt,
    contourLevel,
    contourPointsFromLineMask,
    applyContourToCanvas,
    drawLineMaskToCanvas,
  ]);

  useEffect(() => {
    drawContourPlaceholder();
  }, [drawContourPlaceholder]);

  useEffect(() => {
    if (!uploadedImage) return;

    const img = new Image();
    img.onload = () => {
      const imageCanvas = imageCanvasRef.current;
      if (!imageCanvas) return;
      const imageCtx = imageCanvas.getContext("2d");
      if (!imageCtx) return;

      const iw = img.width;
      const ih = img.height;

      const off = document.createElement("canvas");
      off.width = LUM_SAMPLE_PX;
      off.height = LUM_SAMPLE_PX;
      const octx = off.getContext("2d", { colorSpace: "srgb" });
      if (!octx) return;
      octx.imageSmoothingEnabled = false;

      const scaleHi = Math.min(LUM_SAMPLE_PX / iw, LUM_SAMPLE_PX / ih);
      const drawWHi = iw * scaleHi;
      const drawHHi = ih * scaleHi;
      const offsetXHi = (LUM_SAMPLE_PX - drawWHi) / 2;
      const offsetYHi = (LUM_SAMPLE_PX - drawHHi) / 2;
      octx.clearRect(0, 0, LUM_SAMPLE_PX, LUM_SAMPLE_PX);
      octx.drawImage(img, offsetXHi, offsetYHi, drawWHi, drawHHi);

      const hiData = octx.getImageData(0, 0, LUM_SAMPLE_PX, LUM_SAMPLE_PX);
      const lum = buildLuminanceMinPool2x2(hiData, LUM_SAMPLE_PX);
      luminanceRef.current = lum;
      setThreshold(0.5);

      imageCtx.imageSmoothingEnabled = false;
      const scale = Math.min(BOX_SIZE / iw, BOX_SIZE / ih);
      const drawW = iw * scale;
      const drawH = ih * scale;
      const offsetX = (BOX_SIZE - drawW) / 2;
      const offsetY = (BOX_SIZE - drawH) / 2;

      imageCtx.clearRect(0, 0, BOX_SIZE, BOX_SIZE);
      imageCtx.drawImage(img, offsetX, offsetY, drawW, drawH);
      lineMaskRef.current = new Uint8Array(BOX_SIZE * BOX_SIZE);

      setNormalizedContour(null);
      setContourBuilt(false);
      setContourLevel(DEFAULT_CONTOUR_LEVEL);
      setLineRingIndex(0);
      setImageReady(true);

      requestAnimationFrame(() => {
        drawContourPlaceholder();
      });
    };
    img.src = uploadedImage.url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadedImage]);

  useEffect(() => {
    if (!luminanceRef.current || !lineMaskRef.current || !imageReady) return;
    if (lineArtDirtyRef.current) return;
    const lum = luminanceRef.current;
    const lineMask = lineMaskRef.current;
    const { labels, entries } = buildPhotoComponents(lum, threshold);
    const nComp = entries.length;
    setPhotoShapeCount(nComp);
    const key = `${threshold}|${uploadedImage?.url ?? ""}`;
    const keyChanged = lastPhotoSeedKeyRef.current !== key;
    lastPhotoSeedKeyRef.current = key;
    const idx = keyChanged
      ? 0
      : Math.min(photoShapeIndex, Math.max(0, nComp - 1));
    if (keyChanged && photoShapeIndex !== 0) {
      setPhotoShapeIndex(0);
    }
    if (nComp === 0) {
      lineMask.fill(0);
    } else {
      fillLineMaskPrimaryPlusEnclosedHoles(
        labels,
        entries,
        idx,
        lineMask,
        BOX_SIZE,
        BOX_SIZE,
      );
    }
    lineArtDirtyRef.current = false;
    setLineArtDirty(false);
    replaceLineUndoWithCurrent();
    bumpLineMaskVersion();
    requestAnimationFrame(() => drawLineMaskToCanvas());
  }, [
    threshold,
    imageReady,
    photoShapeIndex,
    uploadedImage?.url,
    replaceLineUndoWithCurrent,
    bumpLineMaskVersion,
    drawLineMaskToCanvas,
  ]);

  useEffect(() => {
    if (!contourBuilt || !imageReady) return;
    const pts = contourPointsFromLineMask(contourLevel);
    setNormalizedContour(pts);
    requestAnimationFrame(() => applyContourToCanvas(pts));
  }, [
    contourLevel,
    contourBuilt,
    imageReady,
    contourPointsFromLineMask,
    applyContourToCanvas,
    lineMaskVersion,
  ]);

  useEffect(() => {
    if (contourBuilt && !prevContourBuiltRef.current) {
      setLineRingIndex(0);
    }
    prevContourBuiltRef.current = contourBuilt;
  }, [contourBuilt]);

  useEffect(() => {
    if (!contourBuilt || !lineMaskRef.current) return;
    const rings = computeSortedContourRings(
      lineMaskRef.current,
      contourLevel,
      BOX_SIZE,
      BOX_SIZE,
    );
    setLineRingIndex((i) => Math.min(i, Math.max(0, rings.length - 1)));
  }, [contourBuilt, contourLevel, lineMaskVersion]);

  function handleDone() {
    setContourBuilt(true);
    const pts = contourPointsFromLineMask(contourLevel);
    setNormalizedContour(pts);
    requestAnimationFrame(() => applyContourToCanvas(pts));
  }

  function handleStartOver() {
    setNormalizedContour(null);
    setContourBuilt(false);
    setContourLevel(DEFAULT_CONTOUR_LEVEL);
    setLineRingIndex(0);
    lineArtDirtyRef.current = false;
    setLineArtDirty(false);
    setPhotoShapeIndex(0);
    lastPhotoSeedKeyRef.current = "";
    const lum = luminanceRef.current;
    const lineMask = lineMaskRef.current;
    if (!lum || !lineMask) return;
    const { labels, entries } = buildPhotoComponents(lum, threshold);
    setPhotoShapeCount(entries.length);
    if (entries.length === 0) {
      lineMask.fill(0);
    } else {
      fillLineMaskPrimaryPlusEnclosedHoles(
        labels,
        entries,
        0,
        lineMask,
        BOX_SIZE,
        BOX_SIZE,
      );
    }
    replaceLineUndoWithCurrent();
    bumpLineMaskVersion();
    requestAnimationFrame(() => {
      drawLineMaskToCanvas();
      drawContourPlaceholder();
    });
  }

  function applyBrush(cx: number, cy: number) {
    const lineMask = lineMaskRef.current;
    if (!lineMask) return;
    lineArtDirtyRef.current = true;
    setLineArtDirty(true);
    strokeDirtyRef.current = true;
    const r = brushRadius;
    const r2 = r * r;
    const v = tool === "draw" ? 255 : 0;
    for (let y = Math.max(0, cy - r) | 0; y < Math.min(BOX_SIZE, cy + r + 1); y++) {
      for (let x = Math.max(0, cx - r) | 0; x < Math.min(BOX_SIZE, cx + r + 1); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        lineMask[y * BOX_SIZE + x] = v;
      }
    }
  }

  const handleLineArtPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!imageReady || !lineMaskRef.current) return;
    strokeDirtyRef.current = false;
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = BOX_SIZE / rect.width;
    const sy = BOX_SIZE / rect.height;
    const cx = Math.floor((e.clientX - rect.left) * sx);
    const cy = Math.floor((e.clientY - rect.top) * sy);
    paintingRef.current = true;
    applyBrush(cx, cy);
    drawLineMaskToCanvas();
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleLineArtPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!paintingRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = BOX_SIZE / rect.width;
    const sy = BOX_SIZE / rect.height;
    const cx = Math.floor((e.clientX - rect.left) * sx);
    const cy = Math.floor((e.clientY - rect.top) * sy);
    applyBrush(cx, cy);
    drawLineMaskToCanvas();
  };

  const handleLineArtPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!paintingRef.current) return;
    paintingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    drawLineMaskToCanvas();
    if (strokeDirtyRef.current) {
      pushLineUndo();
      strokeDirtyRef.current = false;
      if (contourBuilt) {
        const pts = contourPointsFromLineMask(contourLevel);
        setNormalizedContour(pts);
        requestAnimationFrame(() => applyContourToCanvas(pts));
      }
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImageReady(false);
    setUploadedImage({ url, file });
  };

  const canUndoLine = undoCount > 0;
  const panelCanvasClass =
    "mx-auto block h-[196px] w-[196px] max-w-[min(100vw-1rem,228px)] border border-pace-line bg-pace-white shadow-sm sm:h-[208px] sm:w-[208px] md:h-[220px] md:w-[220px] lg:h-[236px] lg:w-[236px]";

  const lineArtCursor = useMemo(
    () => lineArtCursorCss(tool, brushRadius),
    [tool, brushRadius],
  );

  const contourRingCount = useMemo(() => {
    void lineMaskVersion;
    if (!contourBuilt || !lineMaskRef.current) return 0;
    return computeSortedContourRings(
      lineMaskRef.current,
      contourLevel,
      BOX_SIZE,
      BOX_SIZE,
    ).length;
  }, [contourBuilt, contourLevel, lineMaskVersion]);

  const columnTitleClass =
    "mb-0.5 flex w-full flex-col items-center justify-center text-center";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-2 pb-1.5 pt-0.5 sm:px-2.5 sm:pb-2 sm:pt-1">
      {onBack ? (
        <div className="mb-0.5 flex w-full justify-start sm:mb-1">
          <button type="button" onClick={onBack} className="pace-link-back">
            ← Back
          </button>
        </div>
      ) : null}

      <p className="mb-1 max-w-xl text-center font-dm text-[10px] leading-snug text-pace-muted sm:mb-1.5 sm:text-[11px]">
        Your photo is traced in the browser—we don’t upload the image to our
        servers. Use <span className="whitespace-nowrap">Photo threshold</span>{" "}
        so the letter hole stays clear; if the loop fills in, raise the
        threshold slightly. Extra ink drawn{" "}
        <em className="not-italic">inside</em> a letter (a separate blob) is
        kept automatically when it sits in a closed hole of the main shape.
        When we detect a letter hole (inner loop much smaller than the outer
        loop), we stitch it into one path automatically. If the outline still
        looks wrong, try <span className="whitespace-nowrap">Route outline</span>{" "}
        below.
      </p>

      <div className="pace-card mb-1 w-full max-w-4xl p-1.5 sm:p-2">
        <div className="pace-card-editorial flex w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto py-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <input
            id={traceFileInputId}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="sr-only"
          />
          <label
            htmlFor={traceFileInputId}
            aria-describedby="pace-trace-file-status"
            className="font-dm inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap border border-pace-line bg-pace-white px-1.5 py-1 text-[11px] text-pace-ink hover:border-pace-yellow/50 sm:gap-1.5 sm:text-xs"
          >
            <span className="shrink-0 rounded-sm bg-pace-yellow/15 px-1.5 py-0.5 text-[10px] font-semibold text-pace-ink sm:text-[10px]">
              Choose file
            </span>
            <span
              id="pace-trace-file-status"
              className="max-w-[5.5rem] truncate text-[10px] leading-tight text-pace-muted sm:max-w-[6.5rem]"
              title={
                uploadedImage ? uploadedImage.file.name : "No file selected yet"
              }
            >
              {uploadedImage ? uploadedImage.file.name : "NO FILE YET"}
            </span>
          </label>
          <label className="font-dm flex shrink-0 items-center gap-1.5 pr-0.5 text-[11px] text-pace-ink sm:gap-2 sm:text-xs">
            <span className="whitespace-nowrap">Photo threshold</span>
            <input
              type="range"
              min={0.1}
              max={0.9}
              step={0.05}
              value={threshold}
              onChange={(e) => setThreshold(parseFloat(e.target.value))}
              className="w-[72px] accent-pace-yellow sm:w-[84px]"
            />
            <span className="w-7 shrink-0 text-right text-[10px] tabular-nums text-pace-muted sm:text-[11px]">
              {threshold.toFixed(2)}
            </span>
          </label>
          {photoShapeCount > 1 && !lineArtDirty ? (
            <label className="font-dm flex shrink-0 items-center gap-1 text-[10px] text-pace-ink sm:gap-1.5 sm:text-[11px]">
              <span className="whitespace-nowrap">Shape</span>
              <select
                value={Math.min(
                  photoShapeIndex,
                  Math.max(0, photoShapeCount - 1),
                )}
                onChange={(e) => setPhotoShapeIndex(Number(e.target.value))}
                className="max-w-[5rem] rounded border border-pace-line bg-pace-white py-0.5 pl-1 pr-6 text-[10px] sm:max-w-[6rem] sm:text-[11px]"
                aria-label="Which separate blob from the photo to trace"
              >
                {Array.from({ length: photoShapeCount }, (_, i) => (
                  <option key={i} value={i}>
                    {i === 0 ? "1 (largest)" : `${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-x-1 pl-1">
            <span className="shrink-0 font-bebas text-[10px] tracking-[0.1em] text-pace-muted sm:text-[11px]">
              Line art
            </span>
            <div className="inline-flex shrink-0 rounded-full border border-pace-line bg-pace-panel p-0.5">
              <button
                type="button"
                onClick={() => setTool("draw")}
                className={`rounded-full px-2 py-0.5 font-bebas text-[11px] tracking-wide sm:px-2.5 sm:py-1 sm:text-xs ${
                  tool === "draw"
                    ? "bg-pace-white text-pace-ink shadow-sm"
                    : "text-pace-muted"
                }`}
              >
                Draw
              </button>
              <button
                type="button"
                onClick={() => setTool("erase")}
                className={`rounded-full px-2 py-0.5 font-bebas text-[11px] tracking-wide sm:px-2.5 sm:py-1 sm:text-xs ${
                  tool === "erase"
                    ? "bg-pace-yellow text-pace-ink shadow-sm"
                    : "text-pace-muted"
                }`}
              >
                Erase
              </button>
            </div>
            <button
              type="button"
              disabled={!imageReady || !canUndoLine}
              onClick={undoLineArt}
              className="pace-toolbar-btn shrink-0 px-2 py-0.5 text-[11px] disabled:opacity-40 sm:px-2.5 sm:py-1 sm:text-xs"
            >
              Undo
            </button>
            <label className="font-dm flex shrink-0 items-center gap-1 text-[10px] text-pace-muted sm:gap-1.5 sm:text-[11px]">
              <span className="whitespace-nowrap">Brush</span>
              <input
                type="range"
                min={2}
                max={22}
                step={1}
                value={brushRadius}
                onChange={(e) => setBrushRadius(Number(e.target.value))}
                className="w-11 accent-pace-yellow sm:w-12"
              />
              <span className="w-4 tabular-nums sm:w-5">{brushRadius}</span>
            </label>
            <button
              type="button"
              disabled={!imageReady}
              onClick={handleDone}
              className="pace-toolbar-btn-primary shrink-0 px-2 py-0.5 text-[11px] disabled:opacity-40 sm:px-2.5 sm:py-1 sm:text-xs"
            >
              Done
            </button>
          </div>
        </div>
      </div>

      <div className="w-full overflow-x-auto overflow-y-visible pb-0.5 [-webkit-overflow-scrolling:touch]">
        <div className="mx-auto min-w-[min(100%,720px)] max-w-[880px] px-0 sm:min-w-[740px] sm:px-0">
          <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
            <div className="flex min-w-0 flex-col items-center">
              <div className={columnTitleClass}>
                <span className="font-bebas text-[10px] tracking-[0.12em] text-pace-muted sm:text-xs">
                  1 · Original
                </span>
              </div>
              <canvas
                ref={imageCanvasRef}
                width={BOX_SIZE}
                height={BOX_SIZE}
                className={panelCanvasClass}
              />
            </div>

            <div className="flex min-w-0 flex-col items-center">
              <div className={columnTitleClass}>
                <span className="font-bebas text-[10px] tracking-[0.12em] text-pace-muted sm:text-xs">
                  2 · Line art
                </span>
              </div>
              <canvas
                ref={lineArtCanvasRef}
                width={BOX_SIZE}
                height={BOX_SIZE}
                style={imageReady ? { cursor: lineArtCursor } : undefined}
                className={`${panelCanvasClass} touch-none ${
                  !imageReady ? "pointer-events-none cursor-not-allowed" : ""
                }`}
                onPointerDown={handleLineArtPointerDown}
                onPointerMove={handleLineArtPointerMove}
                onPointerUp={handleLineArtPointerUp}
                onPointerCancel={handleLineArtPointerUp}
                onPointerLeave={handleLineArtPointerUp}
              />
            </div>

            <div className="flex min-w-0 flex-col items-center">
              <div className={columnTitleClass}>
                <span className="font-bebas text-[10px] tracking-[0.12em] text-pace-muted sm:text-xs">
                  3 · Final contour
                </span>
              </div>
              <canvas
                ref={contourCanvasRef}
                width={BOX_SIZE}
                height={BOX_SIZE}
                className={panelCanvasClass}
              />
            </div>
          </div>

          <div className="mt-1 grid grid-cols-3 gap-1.5 sm:gap-2">
            <div className="min-w-0" />
            <div className="min-w-0" />
            <div className="flex min-w-0 flex-col items-center px-1">
              <div className="w-full max-w-[280px]">
                <label
                  className={`font-dm flex flex-col gap-1 text-[11px] ${
                    contourBuilt ? "text-pace-muted" : "text-pace-muted/60"
                  }`}
                >
                  <span className="flex justify-between gap-2 font-medium">
                    <span>Contour level</span>
                    <span className="tabular-nums text-pace-muted">
                      {contourLevel.toFixed(2)}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0.08}
                    max={0.48}
                    step={0.02}
                    value={contourLevel}
                    disabled={!contourBuilt}
                    onChange={(e) => setContourLevel(parseFloat(e.target.value))}
                    className="w-full accent-pace-yellow disabled:opacity-40"
                  />
                  <span className="text-[10px] leading-snug text-pace-muted">
                    {contourBuilt
                      ? "Adjust until the outline looks right."
                      : "Tap Done first, then adjust."}
                  </span>
                </label>
                {contourBuilt && contourRingCount > 1 ? (
                  <label className="font-dm mt-1 flex flex-col gap-1 text-[11px] text-pace-muted">
                    <span className="flex justify-between gap-2 font-medium">
                      <span>Route outline</span>
                      <span className="tabular-nums">
                        {Math.min(lineRingIndex, contourRingCount - 1) + 1} /{" "}
                        {contourRingCount}
                      </span>
                    </span>
                    <select
                      value={Math.min(
                        lineRingIndex,
                        Math.max(0, contourRingCount - 1),
                      )}
                      onChange={(e) =>
                        setLineRingIndex(Number(e.target.value))
                      }
                      className="w-full rounded border border-pace-line bg-pace-white py-1 pl-1.5 pr-8 text-[11px] text-pace-ink"
                      aria-label="Which closed loop from the line art to use as the route"
                    >
                      {Array.from({ length: contourRingCount }, (_, i) => (
                        <option key={i} value={i}>
                          {i === 0 ? "1 (largest)" : `${i + 1}`}
                        </option>
                      ))}
                    </select>
                    <span className="text-[10px] leading-snug">
                      Multiple outlines were found—pick the one you want as the
                      path.
                    </span>
                  </label>
                ) : null}
              </div>
              <div className="mt-1.5 flex w-full max-w-[280px] flex-col gap-1.5 sm:flex-row sm:justify-center">
                <button
                  type="button"
                  disabled={!imageReady}
                  onClick={handleStartOver}
                  className="pace-toolbar-btn px-4 py-2 disabled:opacity-40"
                >
                  Reset
                </button>
                <button
                  type="button"
                  disabled={!normalizedContour}
                  onClick={() => normalizedContour && onComplete(normalizedContour)}
                  className="pace-toolbar-btn-primary px-4 py-2"
                >
                  Next: place on map →
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function curvatureAdaptiveSample(
  ring: [number, number][],
  targetCount: number,
): [number, number][] {
  const n = ring.length;
  if (targetCount >= n) return ring;

  const weights: number[] = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const curr = ring[i];
    const next = ring[(i + 1) % n];

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
    cumulative[i + 1] = cumulative[i] + weights[i];
  }
  const total = cumulative[n];
  if (total === 0) return ring;

  const sampled: [number, number][] = [];
  for (let k = 0; k < targetCount; k++) {
    const t = (k / targetCount) * total;
    let idx = binarySearchCumulative(cumulative, t);
    if (idx >= n) idx = n - 1;
    sampled.push(ring[idx]);
  }

  return sampled;
}

function binarySearchCumulative(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1 >= 0 ? lo - 1 : 0;
}
