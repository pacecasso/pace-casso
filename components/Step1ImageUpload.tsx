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

export type NormalizedPoint = { x: number; y: number };

const BOX_SIZE = 300;
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

function extractRingFromField(
  field: Float32Array,
  level: number,
): [number, number][] | null {
  const contourGenerator = d3.contours().size([BOX_SIZE, BOX_SIZE]);
  const [contour] = contourGenerator.thresholds([level])(Array.from(field));
  if (!contour) return null;

  let best: [number, number][] | null = null;
  let bestScore = 0;
  for (const multi of contour.coordinates) {
    for (const ring of multi) {
      const r = ring as [number, number][];
      const score = ringAreaAbs(r);
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
  }
  return best;
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

  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lineArtCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const contourCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const luminanceRef = useRef<Float32Array | null>(null);
  const lineMaskRef = useRef<Uint8Array | null>(null);
  const lineArtDirtyRef = useRef(false);
  const paintingRef = useRef(false);
  const strokeDirtyRef = useRef(false);

  const lineUndoStackRef = useRef<Uint8Array[]>([]);
  const lineUndoIndexRef = useRef(-1);

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

  const ringFromPhoto = useCallback((): [number, number][] | null => {
    const lum = luminanceRef.current;
    if (!lum) return null;
    return extractRingFromField(lum, threshold);
  }, [threshold]);

  const seedLineMaskFromPhoto = useCallback(() => {
    const lineMask = lineMaskRef.current;
    const c = workCanvasRef.current;
    if (!lineMask || !c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const ring = ringFromPhoto();
    lineMask.fill(0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, BOX_SIZE, BOX_SIZE);
    if (!ring || ring.length < 3) {
      replaceLineUndoWithCurrent();
      return;
    }
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ring.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();

    const img = ctx.getImageData(0, 0, BOX_SIZE, BOX_SIZE);
    for (let i = 0; i < BOX_SIZE * BOX_SIZE; i++) {
      lineMask[i] = img.data[i * 4] > 80 ? 255 : 0;
    }
    lineArtDirtyRef.current = false;
    replaceLineUndoWithCurrent();
  }, [ringFromPhoto, replaceLineUndoWithCurrent]);

  const buildBlurredFieldFromLineMask = useCallback((): Float32Array | null => {
    const lineMask = lineMaskRef.current;
    if (!lineMask) return null;
    let field: Float32Array = new Float32Array(BOX_SIZE * BOX_SIZE);
    for (let i = 0; i < field.length; i++) {
      field[i] = lineMask[i] / 255;
    }
    for (let pass = 0; pass < 3; pass++) {
      field = boxBlurFloat(field, BOX_SIZE, BOX_SIZE, 2) as Float32Array;
    }
    return field;
  }, []);

  const contourPointsFromLineMask = useCallback(
    (level: number): NormalizedPoint[] | null => {
      const field = buildBlurredFieldFromLineMask();
      if (!field) return null;
      const ring = extractRingFromField(field, level);
      if (ring === null || ring.length < 4) return null;
      const sampled = curvatureAdaptiveSample(ring, 120);
      return sampled.map(([x, y]) => ({
        x: x / BOX_SIZE,
        y: y / BOX_SIZE,
      }));
    },
    [buildBlurredFieldFromLineMask],
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
      const scale = Math.min(BOX_SIZE / iw, BOX_SIZE / ih);
      const drawW = iw * scale;
      const drawH = ih * scale;
      const offsetX = (BOX_SIZE - drawW) / 2;
      const offsetY = (BOX_SIZE - drawH) / 2;

      imageCtx.clearRect(0, 0, BOX_SIZE, BOX_SIZE);
      imageCtx.drawImage(img, offsetX, offsetY, drawW, drawH);

      const imageData = imageCtx.getImageData(0, 0, BOX_SIZE, BOX_SIZE);
      const lum = new Float32Array(BOX_SIZE * BOX_SIZE);
      for (let y = 0; y < BOX_SIZE; y++) {
        for (let x = 0; x < BOX_SIZE; x++) {
          const idx = (y * BOX_SIZE + x) * 4;
          const a = imageData.data[idx + 3];
          if (a < 128) {
            lum[y * BOX_SIZE + x] = 0;
            continue;
          }
          const r = imageData.data[idx];
          const g = imageData.data[idx + 1];
          const b = imageData.data[idx + 2];
          const gray = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          lum[y * BOX_SIZE + x] = 1 - gray;
        }
      }
      luminanceRef.current = lum;
      lineMaskRef.current = new Uint8Array(BOX_SIZE * BOX_SIZE);

      setNormalizedContour(null);
      setContourBuilt(false);
      setContourLevel(DEFAULT_CONTOUR_LEVEL);
      setImageReady(true);

      requestAnimationFrame(() => {
        seedLineMaskFromPhoto();
        drawLineMaskToCanvas();
        drawContourPlaceholder();
      });
    };
    img.src = uploadedImage.url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadedImage]);

  useEffect(() => {
    if (!luminanceRef.current || !lineMaskRef.current || !imageReady) return;
    if (lineArtDirtyRef.current) return;
    seedLineMaskFromPhoto();
    requestAnimationFrame(() => drawLineMaskToCanvas());
  }, [threshold, imageReady, seedLineMaskFromPhoto, drawLineMaskToCanvas]);

  useEffect(() => {
    if (!contourBuilt || !imageReady) return;
    const pts = contourPointsFromLineMask(contourLevel);
    setNormalizedContour(pts);
    requestAnimationFrame(() => applyContourToCanvas(pts));
  }, [contourLevel, contourBuilt, imageReady, contourPointsFromLineMask, applyContourToCanvas]);

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
    lineArtDirtyRef.current = false;
    seedLineMaskFromPhoto();
    requestAnimationFrame(() => {
      drawLineMaskToCanvas();
      drawContourPlaceholder();
    });
  }

  function applyBrush(cx: number, cy: number) {
    const lineMask = lineMaskRef.current;
    if (!lineMask) return;
    lineArtDirtyRef.current = true;
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

  const columnTitleClass =
    "mb-0.5 flex w-full flex-col items-center justify-center text-center";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-2 pb-1.5 pt-0.5 sm:px-2.5 sm:pb-2 sm:pt-1">
      <canvas
        ref={workCanvasRef}
        width={BOX_SIZE}
        height={BOX_SIZE}
        className="pointer-events-none fixed left-0 top-0 opacity-0"
        aria-hidden
      />

      {onBack ? (
        <div className="mb-0.5 flex w-full justify-start sm:mb-1">
          <button type="button" onClick={onBack} className="pace-link-back">
            ← Back
          </button>
        </div>
      ) : null}

      <p className="mb-1 max-w-xl text-center font-dm text-[10px] leading-snug text-pace-muted sm:mb-1.5 sm:text-[11px]">
        Your photo is traced in the browser—we don’t upload the image to our
        servers.
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

function boxBlurFloat(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
): Float32Array {
  const out = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        sum += src[y * w + xx];
        n++;
      }
      tmp[y * w + x] = sum / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        sum += tmp[yy * w + x];
        n++;
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
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
