"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

/** Longest side of the working canvas; big enough for the worker, small enough to upload. */
const MAX_SIDE = 1200;
const MAX_UNDO = 20;
const SIZES = [
  { label: "S", frac: 0.008 },
  { label: "M", frac: 0.02 },
  { label: "L", frac: 0.05 },
];

type Tool = "erase" | "pen";

export type LineArtEditorHandle = {
  /** the edited picture as a PNG data URL, or null before the picture has loaded */
  toDataUrl: () => string | null;
};

/**
 * Background colour the same way the worker's ink step finds it (the most
 * common border colour, in steps of 16), so erased pixels count as paper
 * there too: a white eraser on a blue plate would draw a new white shape.
 */
function borderColour(ctx: CanvasRenderingContext2D, w: number, h: number): [number, number, number] {
  // bucket -> [count, sum r, sum g, sum b]; the eraser paints the bucket's
  // mean so erased patches match the paper exactly, not the bucket centre
  const buckets = new Map<string, [number, number, number, number]>();
  const add = (d: Uint8ClampedArray) => {
    for (let i = 0; i < d.length; i += 4) {
      const k = `${d[i]! >> 4},${d[i + 1]! >> 4},${d[i + 2]! >> 4}`;
      const s = buckets.get(k) ?? [0, 0, 0, 0];
      s[0]++;
      s[1] += d[i]!;
      s[2] += d[i + 1]!;
      s[3] += d[i + 2]!;
      buckets.set(k, s);
    }
  };
  add(ctx.getImageData(0, 0, w, 1).data);
  add(ctx.getImageData(0, h - 1, w, 1).data);
  add(ctx.getImageData(0, 0, 1, h).data);
  add(ctx.getImageData(w - 1, 0, 1, h).data);
  let best: [number, number, number, number] = [1, 255, 255, 255];
  for (const s of buckets.values()) if (s[0] > best[0]) best = s;
  return [Math.round(best[1] / best[0]), Math.round(best[2] / best[0]), Math.round(best[3] / best[0])];
}

/**
 * Touch-up step between choosing a picture and "Draw it" (Ralph, Oct 30):
 * erase lettering or details that will not survive on streets, close gaps,
 * thicken thin lines. Colours are kept because the worker splits a two-tone
 * logo into parts by colour; the canvas is exactly what gets uploaded.
 */
const LineArtEditor = forwardRef<LineArtEditorHandle, { file: File }>(function LineArtEditor({ file }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const originalRef = useRef<ImageData | null>(null);
  const undoRef = useRef<ImageData[]>([]);
  const bgRef = useRef<[number, number, number]>([255, 255, 255]);
  const inkRef = useRef<[number, number, number]>([0, 0, 0]);
  const drawingRef = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<Tool>("erase");
  const [size, setSize] = useState(1);
  const [undoCount, setUndoCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useImperativeHandle(ref, () => ({
    toDataUrl: () => (ready && canvasRef.current ? canvasRef.current.toDataURL("image/png") : null),
  }), [ready]);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setLoadError(false);
    undoRef.current = [];
    setUndoCount(0);
    createImageBitmap(file)
      .then((bmp) => {
        if (cancelled) return bmp.close();
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d", { willReadFrequently: true });
        if (!canvas || !ctx) return bmp.close();
        const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        canvas.width = Math.max(1, Math.round(bmp.width * k));
        canvas.height = Math.max(1, Math.round(bmp.height * k));
        // transparent PNGs go onto white, as the worker does
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
        bgRef.current = borderColour(ctx, canvas.width, canvas.height);
        const [r, g, b] = bgRef.current;
        // pen ink: black on a light background, white on a dark one
        inkRef.current = r + g + b > 384 ? [0, 0, 0] : [255, 255, 255];
        originalRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const ctx = () => canvasRef.current?.getContext("2d", { willReadFrequently: true }) ?? null;

  const pushUndo = () => {
    const c = ctx();
    const canvas = canvasRef.current;
    if (!c || !canvas) return;
    undoRef.current.push(c.getImageData(0, 0, canvas.width, canvas.height));
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
    setUndoCount(undoRef.current.length);
  };

  const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const stroke = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const c = ctx();
      const canvas = canvasRef.current;
      if (!c || !canvas) return;
      const [r, g, b] = tool === "erase" ? bgRef.current : inkRef.current;
      c.strokeStyle = `rgb(${r},${g},${b})`;
      c.lineWidth = Math.max(2, SIZES[size]!.frac * Math.max(canvas.width, canvas.height));
      c.lineCap = "round";
      c.lineJoin = "round";
      c.beginPath();
      c.moveTo(from.x, from.y);
      c.lineTo(to.x, to.y);
      c.stroke();
    },
    [tool, size],
  );

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pushUndo();
    const p = toCanvas(e);
    drawingRef.current = p;
    stroke(p, p);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const last = drawingRef.current;
    if (!last) return;
    const p = toCanvas(e);
    stroke(last, p);
    drawingRef.current = p;
  };
  const onUp = () => {
    drawingRef.current = null;
  };

  const undo = () => {
    const snap = undoRef.current.pop();
    if (snap) ctx()?.putImageData(snap, 0, 0);
    setUndoCount(undoRef.current.length);
  };
  const reset = () => {
    if (!originalRef.current) return;
    pushUndo();
    ctx()?.putImageData(originalRef.current, 0, 0);
  };

  const toolBtn = (t: Tool, label: string) => (
    <button
      type="button"
      onClick={() => setTool(t)}
      className={`rounded border px-3 py-1.5 text-xs font-semibold ${
        tool === t ? "border-pace-blue bg-pace-blue text-white" : "border-pace-line bg-pace-white text-pace-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {toolBtn("erase", "Eraser")}
        {toolBtn("pen", "Pen")}
        <span className="ml-2 text-xs text-pace-muted">Size</span>
        {SIZES.map((s, i) => (
          <button
            key={s.label}
            type="button"
            onClick={() => setSize(i)}
            className={`h-8 w-8 rounded border text-xs font-semibold ${
              size === i ? "border-pace-blue bg-pace-blue text-white" : "border-pace-line bg-pace-white text-pace-ink"
            }`}
          >
            {s.label}
          </button>
        ))}
        <button
          type="button"
          onClick={undo}
          disabled={undoCount === 0}
          className="ml-2 rounded border border-pace-line bg-pace-white px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={!ready}
          className="rounded border border-pace-line bg-pace-white px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
        >
          Start over
        </button>
      </div>
      <div className="flex items-center justify-center rounded-lg border border-pace-line bg-pace-warm p-2">
        {loadError ? (
          <p className="p-6 text-sm text-red-700">Could not open that picture - try a PNG or JPG.</p>
        ) : (
          <canvas
            ref={canvasRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            aria-label="Your picture - draw on it to edit"
            className="max-h-[60vh] max-w-full cursor-crosshair touch-none bg-white"
          />
        )}
      </div>
    </div>
  );
});

export default LineArtEditor;
