"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderRouteToDataUrl } from "../lib/renderRouteImage";
import {
  applyStrokeEdits,
  cloneStrokeList,
  strokeFromCanvasPath,
  strokeLength,
  type StrokeEdit,
} from "../lib/strokeEdit";
import type { Stroke, UnitPt } from "../lib/strokePainter";

/**
 * THE EDIT STEP — fix the draft before exporting it.
 *
 * The only two routes Ralph has approved (gas, Sep 8; unicorn, Sep 12) were an
 * automatic draft plus three or four stroke edits. Until now that step existed
 * only as an offline script driven by hand-written JSON, so nobody using the
 * site could do the one thing that has ever produced a route worth keeping.
 *
 * Editing is free and instant: one routePlacement call per change, measured at
 * 42-170 ms against the real Manhattan graph. No model calls, no Mapbox.
 */

const BOX = 320;

export type StrokeEditHandoff = {
  strokes: Stroke[];
  center: [number, number];
  scale: number;
  rot: number;
};

type Props = {
  draft: StrokeEditHandoff;
  /** the user's own artwork, drawn faintly underneath so edits have a reference */
  imageBase64?: string | null;
  cityId: string;
  initialRoute: [number, number][];
  initialKm: number;
  onBack: () => void;
  onComplete: (result: { chain: [number, number][]; km: number; strokes: Stroke[] }) => void;
};

type Tool = "select" | "draw" | "cut";

const toCanvas = (p: UnitPt): [number, number] => [((p[0] + 1) / 2) * BOX, ((1 - p[1]) / 2) * BOX];

/** shortest distance from a canvas point to a stroke, in canvas pixels */
function distanceToStroke(s: Stroke, x: number, y: number): number {
  let best = Infinity;
  const n = s.pts.length;
  const last = s.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const [ax, ay] = toCanvas(s.pts[i]!);
    const [bx, by] = toCanvas(s.pts[(i + 1) % n]!);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }
  return best;
}

export default function StepStrokeEdit({
  draft,
  imageBase64,
  cityId,
  initialRoute,
  initialKm,
  onBack,
  onComplete,
}: Props) {
  const [strokes, setStrokes] = useState<Stroke[]>(() => cloneStrokeList(draft.strokes));
  const [history, setHistory] = useState<Stroke[][]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [cutPoints, setCutPoints] = useState<UnitPt[]>([]);
  const [route, setRoute] = useState<[number, number][]>(initialRoute);
  const [km, setKm] = useState(initialKm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<[number, number][] | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageReady, setImageReady] = useState(false);
  // only the newest re-route may land: a slow earlier one must not overwrite it
  const routeSeqRef = useRef(0);

  useEffect(() => {
    if (!imageBase64) return;
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setImageReady(true);
    };
    img.src = imageBase64;
  }, [imageBase64]);

  const pushHistory = useCallback((next: Stroke[]) => {
    setHistory((h) => [...h.slice(-19), cloneStrokeList(strokesRef.current)]);
    setStrokes(next);
  }, []);
  const strokesRef = useRef(strokes);
  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);

  // ---- re-route whenever the drawing changes
  const reroute = useCallback(
    async (list: Stroke[]) => {
      const seq = ++routeSeqRef.current;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/stroke-route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            strokes: list,
            center: draft.center,
            scale: draft.scale,
            rot: draft.rot,
            cityId,
          }),
        });
        const payload = (await res.json()) as {
          ok?: boolean;
          reason?: string;
          chain?: [number, number][];
          km?: number;
        };
        if (seq !== routeSeqRef.current) return;
        if (!payload.ok || !payload.chain?.length) {
          setError(
            payload.reason === "nothing-left"
              ? "That removed the whole drawing — undo, or draw something."
              : "Those streets can't take that shape. Undo and try a different line.",
          );
          return;
        }
        setRoute(payload.chain);
        setKm(payload.km ?? 0);
      } catch {
        if (seq === routeSeqRef.current) setError("Couldn't reach the route service. Try again.");
      } finally {
        if (seq === routeSeqRef.current) setBusy(false);
      }
    },
    [cityId, draft.center, draft.rot, draft.scale],
  );

  const runEdit = useCallback(
    (edit: StrokeEdit) => {
      const next = applyStrokeEdits(strokesRef.current, [edit]);
      pushHistory(next);
      setSelected(null);
      setCutPoints([]);
      void reroute(next);
    },
    [pushHistory, reroute],
  );

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1]!;
      setStrokes(prev);
      setSelected(null);
      setCutPoints([]);
      void reroute(prev);
      return h.slice(0, -1);
    });
  }, [reroute]);

  // ---- canvas
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, BOX, BOX);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, BOX, BOX);

    if (imageRef.current) {
      ctx.globalAlpha = 0.14;
      const img = imageRef.current;
      const s = Math.min(BOX / img.width, BOX / img.height);
      ctx.drawImage(img, (BOX - img.width * s) / 2, (BOX - img.height * s) / 2, img.width * s, img.height * s);
      ctx.globalAlpha = 1;
    }

    strokes.forEach((stroke, i) => {
      ctx.beginPath();
      stroke.pts.forEach((p, k) => {
        const [x, y] = toCanvas(p);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (stroke.closed) ctx.closePath();
      ctx.lineWidth = i === selected ? 4 : 2.5;
      ctx.strokeStyle = i === selected ? "#168fd0" : "#e8590c";
      ctx.stroke();
    });

    for (const p of cutPoints) {
      const [x, y] = toCanvas(p);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#168fd0";
      ctx.fill();
    }

    const path = drawingRef.current;
    if (path?.length) {
      ctx.beginPath();
      path.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#168fd0";
      ctx.stroke();
    }
  }, [cutPoints, selected, strokes]);

  // imageReady is not read by paint(), but the faint artwork underneath only
  // exists once the image has decoded, so a repaint is owed at that moment
  useEffect(() => {
    paint();
  }, [paint, imageReady]);

  const canvasPoint = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * BOX,
      ((e.clientY - rect.top) / rect.height) * BOX,
    ];
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = canvasPoint(e);
    if (tool === "draw") {
      e.currentTarget.setPointerCapture(e.pointerId);
      drawingRef.current = [[x, y]];
      paint();
      return;
    }
    if (tool === "cut") {
      const unit: UnitPt = [(x / BOX) * 2 - 1, 1 - (y / BOX) * 2];
      const next = [...cutPoints, unit];
      if (next.length === 2 && selected !== null) {
        runEdit({ op: "cut", index: selected, at: [next[0]!, next[1]!] });
        setTool("select");
        return;
      }
      setCutPoints(next);
      return;
    }
    // select: nearest stroke within a finger's reach
    let best: number | null = null;
    let bestD = 18;
    strokes.forEach((s, i) => {
      const d = distanceToStroke(s, x, y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setSelected(best);
    setCutPoints([]);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool !== "draw" || !drawingRef.current) return;
    drawingRef.current.push(canvasPoint(e));
    paint();
  };

  const handlePointerUp = () => {
    if (tool !== "draw") return;
    const path = drawingRef.current;
    drawingRef.current = null;
    if (!path || path.length < 2) {
      paint();
      return;
    }
    const stroke = strokeFromCanvasPath(path, BOX);
    // a stray tap is not a stroke
    if (stroke.pts.length < 2 || strokeLength(stroke) * draft.scale < 250) {
      setError("That line is too short to run — draw a longer one.");
      paint();
      return;
    }
    setTool("select");
    runEdit({ op: "add", stroke });
  };

  const preview = useMemo(() => renderRouteToDataUrl(route, 420, { padding: 40 }), [route]);
  const selectedStroke = selected === null ? null : strokes[selected];

  return (
    <div className="mx-auto w-full max-w-[880px] px-2">
      <div className="mb-2">
        <h2 className="font-bebas text-lg tracking-[0.12em] text-pace-ink sm:text-xl">
          Make it yours
        </h2>
        <p className="font-dm text-[11px] leading-snug text-pace-muted">
          This is your drawing, on real streets. Delete a line you don&apos;t want, cut one in
          half, or draw a new one — the route updates as you go.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col items-center">
          <span className="font-bebas text-[11px] tracking-[0.12em] text-pace-muted">Your lines</span>
          <canvas
            ref={canvasRef}
            width={BOX}
            height={BOX}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className="w-full max-w-[320px] touch-none border border-pace-line bg-white"
            style={{ cursor: tool === "select" ? "pointer" : "crosshair" }}
          />
          <div className="mt-1.5 flex w-full max-w-[320px] flex-wrap justify-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setTool("select");
                setCutPoints([]);
              }}
              className={tool === "select" ? "pace-toolbar-btn-primary px-3 py-1.5 text-[11px]" : "pace-toolbar-btn px-3 py-1.5 text-[11px]"}
            >
              Select
            </button>
            <button
              type="button"
              onClick={() => {
                setTool("draw");
                setSelected(null);
                setCutPoints([]);
              }}
              className={tool === "draw" ? "pace-toolbar-btn-primary px-3 py-1.5 text-[11px]" : "pace-toolbar-btn px-3 py-1.5 text-[11px]"}
            >
              Draw a line
            </button>
            <button
              type="button"
              disabled={selected === null}
              onClick={() => {
                setTool("cut");
                setCutPoints([]);
              }}
              className={`px-3 py-1.5 text-[11px] disabled:opacity-40 ${
                tool === "cut" ? "pace-toolbar-btn-primary" : "pace-toolbar-btn"
              }`}
            >
              Cut in two
            </button>
            <button
              type="button"
              disabled={selected === null}
              onClick={() => selected !== null && runEdit({ op: "drop", index: selected })}
              className="pace-toolbar-btn px-3 py-1.5 text-[11px] disabled:opacity-40"
            >
              Delete
            </button>
            <button
              type="button"
              disabled={!history.length}
              onClick={undo}
              className="pace-toolbar-btn px-3 py-1.5 text-[11px] disabled:opacity-40"
            >
              Undo
            </button>
          </div>
          <p className="mt-1 max-w-[320px] text-center font-dm text-[11px] leading-snug text-pace-muted">
            {tool === "draw"
              ? "Drag on the drawing to add a line."
              : tool === "cut"
                ? `Tap two points on the selected line to cut it${cutPoints.length ? " — one more" : ""}.`
                : selectedStroke
                  ? "Line selected. Delete it, or cut it in two."
                  : "Tap a line to select it."}
          </p>
        </div>

        <div className="flex flex-col items-center">
          <span className="font-bebas text-[11px] tracking-[0.12em] text-pace-muted">On the map</span>
          <div className="relative w-full max-w-[320px] border border-pace-line bg-white">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element -- a canvas data URL, not a remote asset
              <img src={preview} alt="Your route on real streets" className="block w-full" />
            ) : (
              <div className="aspect-square w-full" />
            )}
            {busy ? (
              <div className="absolute inset-0 flex items-center justify-center bg-white/60">
                <span className="font-bebas text-xs tracking-[0.12em] text-pace-ink">UPDATING…</span>
              </div>
            ) : null}
          </div>
          <p className="mt-1 font-dm text-[11px] text-pace-muted">
            {km > 0 ? `${km.toFixed(1)} km` : "—"} · {strokes.length} line{strokes.length === 1 ? "" : "s"}
          </p>
          {error ? (
            <p className="mt-1 max-w-[320px] rounded border-l-2 border-pace-yellow bg-pace-yellow/10 px-2 py-1.5 text-center font-dm text-[11px] leading-snug text-pace-ink">
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:justify-between">
        <button type="button" onClick={onBack} className="pace-toolbar-btn px-4 py-2">
          ← Back
        </button>
        <button
          type="button"
          disabled={busy || route.length < 8}
          onClick={() => onComplete({ chain: route, km, strokes })}
          className="pace-toolbar-btn-primary px-4 py-2 disabled:opacity-40"
        >
          Looks good — continue →
        </button>
      </div>
    </div>
  );
}
