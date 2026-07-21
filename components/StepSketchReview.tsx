"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Maximize, Plus, RotateCcw, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import type { NormalizedPoint } from "./Step1ImageUpload";
import {
  buildSketchReviewOptions,
  deleteSketchPoint,
  insertSketchPoint,
  moveSketchPoint,
  type NormalizedSketchPoint,
} from "../lib/sketchReview";

type Props = {
  contour: NormalizedPoint[];
  imageBase64?: string | null;
  sourceName?: string | null;
  onBack: () => void;
  onApprove: (points: NormalizedPoint[]) => void;
};

function toPath(points: NormalizedSketchPoint[]): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(p.x * 1000).toFixed(1)} ${(p.y * 1000).toFixed(1)}`)
    .join(" ");
}

function toPolyline(points: NormalizedSketchPoint[]): string {
  return points
    .map((p) => `${(p.x * 1000).toFixed(1)},${(p.y * 1000).toFixed(1)}`)
    .join(" ");
}

function safePointCount(points: NormalizedSketchPoint[]): string {
  return `${points.length} point${points.length === 1 ? "" : "s"}`;
}

export default function StepSketchReview({
  contour,
  imageBase64,
  sourceName,
  onBack,
  onApprove,
}: Props) {
  const options = useMemo(() => buildSketchReviewOptions(contour), [contour]);
  const [activeId, setActiveId] = useState(options[0]?.id ?? "");
  const activeOption = options.find((option) => option.id === activeId) ?? options[0];
  const [points, setPoints] = useState<NormalizedSketchPoint[]>(
    () => activeOption?.points ?? contour,
  );
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [history, setHistory] = useState<NormalizedSketchPoint[][]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndexRef = useRef<number | null>(null);
  // Zoom/pan viewport in the 0-1000 sketch space. Dense traces (a logo
  // with letters is 200+ points) are uneditable at fit-zoom — the user
  // must be able to zoom into one letter and drag its points.
  const [view, setView] = useState({ cx: 500, cy: 500, scale: 1 });
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const vbSize = 1000 / view.scale;
  const clampView = useCallback((cx: number, cy: number, scale: number) => {
    const s = Math.max(1, Math.min(8, scale));
    const half = 500 / s;
    return {
      cx: Math.max(half, Math.min(1000 - half, cx)),
      cy: Math.max(half, Math.min(1000 - half, cy)),
      scale: s,
    };
  }, []);

  const zoomBy = useCallback(
    (factor: number, focus?: { x: number; y: number }) => {
      setView((v) => {
        const s = Math.max(1, Math.min(8, v.scale * factor));
        if (s === v.scale) return v;
        const f = focus ?? { x: v.cx, y: v.cy };
        // Keep the focus point stationary on screen while scaling.
        const ratio = v.scale / s;
        return clampView(f.x - (f.x - v.cx) * ratio, f.y - (f.y - v.cy) * ratio, s);
      });
    },
    [clampView],
  );

  // Wheel zoom needs a non-passive native listener; React's synthetic
  // wheel handler can't preventDefault the page scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const fx = (event.clientX - rect.left) / rect.width;
      const fy = (event.clientY - rect.top) / rect.height;
      setView((v) => {
        const size = 1000 / v.scale;
        const wx = v.cx - size / 2 + fx * size;
        const wy = v.cy - size / 2 + fy * size;
        const s = Math.max(1, Math.min(8, v.scale * (event.deltaY < 0 ? 1.18 : 1 / 1.18)));
        if (s === v.scale) return v;
        const ratio = v.scale / s;
        const half = 500 / s;
        return {
          cx: Math.max(half, Math.min(1000 - half, wx - (wx - v.cx) * ratio)),
          cy: Math.max(half, Math.min(1000 - half, wy - (wy - v.cy) * ratio)),
          scale: s,
        };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // Editing marks scale down as the trace gets denser AND as the user
  // zooms in, so a 250-point letter trace stays line-art instead of a
  // blob of handles.
  const density = Math.max(1, points.length / 60);
  const routeStroke = Math.max(6, 28 / Math.sqrt(density)) / view.scale;
  const handleR = Math.max(4, 12 / Math.sqrt(density)) / view.scale;
  const handleStroke = Math.max(2.5, 8 / Math.sqrt(density)) / view.scale;

  const pushHistory = useCallback((current: NormalizedSketchPoint[]) => {
    setHistory((prev) => [...prev.slice(-14), current.map((p) => ({ ...p }))]);
  }, []);

  const chooseOption = useCallback(
    (id: string) => {
      const option = options.find((candidate) => candidate.id === id);
      if (!option) return;
      pushHistory(points);
      setActiveId(id);
      setPoints(option.points);
      setSelectedIndex(null);
    },
    [options, points, pushHistory],
  );

  const undo = useCallback(() => {
    setHistory((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      setPoints(last);
      setSelectedIndex(null);
      return prev.slice(0, -1);
    });
  }, []);

  const pointFromEvent = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const fx = (event.clientX - rect.left) / rect.width;
      const fy = (event.clientY - rect.top) / rect.height;
      // Map through the zoomed viewport back into 0-1 sketch space.
      const size = 1000 / view.scale;
      return {
        x: (view.cx - size / 2 + fx * size) / 1000,
        y: (view.cy - size / 2 + fy * size) / 1000,
      };
    },
    [view],
  );

  const startDrag = useCallback(
    (index: number, event: React.PointerEvent<SVGCircleElement>) => {
      event.preventDefault();
      event.stopPropagation();
      pushHistory(points);
      dragIndexRef.current = index;
      setSelectedIndex(index);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [points, pushHistory],
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const index = dragIndexRef.current;
      if (index != null) {
        const next = pointFromEvent(event);
        if (!next) return;
        setPoints((current) => moveSketchPoint(current, index, next));
        return;
      }
      const pan = panRef.current;
      if (pan && pan.pointerId === event.pointerId) {
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0) return;
        const size = 1000 / view.scale;
        const dx = ((event.clientX - pan.x) / rect.width) * size;
        const dy = ((event.clientY - pan.y) / rect.height) * size;
        panRef.current = { pointerId: pan.pointerId, x: event.clientX, y: event.clientY };
        setView((v) => clampView(v.cx - dx, v.cy - dy, v.scale));
      }
    },
    [clampView, pointFromEvent, view.scale],
  );

  const endDrag = useCallback(() => {
    dragIndexRef.current = null;
    panRef.current = null;
  }, []);

  const startPan = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (dragIndexRef.current != null) return;
      if (view.scale <= 1) return;
      panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      svgRef.current?.setPointerCapture(event.pointerId);
    },
    [view.scale],
  );

  const addPoint = useCallback(() => {
    pushHistory(points);
    const result = insertSketchPoint(points, selectedIndex);
    setPoints(result.points);
    setSelectedIndex(result.selectedIndex);
  }, [points, pushHistory, selectedIndex]);

  const deletePoint = useCallback(() => {
    pushHistory(points);
    const result = deleteSketchPoint(points, selectedIndex);
    setPoints(result.points);
    setSelectedIndex(result.selectedIndex);
  }, [points, pushHistory, selectedIndex]);

  const approve = useCallback(() => {
    onApprove(points as NormalizedPoint[]);
  }, [onApprove, points]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-pace-warm lg:flex-row">
      <aside className="flex max-h-[46vh] min-h-0 flex-col overflow-y-auto border-b-2 border-pace-yellow bg-pace-white px-[clamp(1rem,4vw,2.5rem)] py-4 lg:max-h-none lg:w-96 lg:shrink-0 lg:border-b-0 lg:border-r lg:border-pace-line lg:px-4">
        <div className="border-l-4 border-pace-yellow pl-4">
          <p className="font-bebas text-sm tracking-[0.14em] text-pace-yellow">
            APPROVE THE SKETCH
          </p>
          <h2 className="mt-1 font-bebas text-2xl tracking-[0.08em] text-pace-ink">
            {sourceName ? sourceName.replace(/\.[^.]+$/, "") : "Uploaded art"}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-pace-muted">
            Pick the version that reads closest, then adjust the line before PaceCasso searches the city.
          </p>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => chooseOption(option.id)}
              className={`rounded-lg border bg-pace-white p-2 text-left transition ${
                option.id === activeId
                  ? "border-pace-blue shadow-[0_0_0_2px_rgba(30,120,255,0.14)]"
                  : "border-pace-line hover:border-pace-yellow"
              }`}
            >
              <svg
                viewBox="0 0 1000 1000"
                className="aspect-square w-full rounded-md bg-pace-panel"
                aria-hidden="true"
              >
                <path
                  d={toPath(option.points)}
                  fill="none"
                  stroke="#18844f"
                  strokeWidth={Math.max(10, 38 / Math.sqrt(Math.max(1, option.points.length / 60)))}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="mt-2 block font-bebas text-sm tracking-[0.1em] text-pace-ink">
                {option.label}
              </span>
              <span className="text-xs text-pace-muted">{safePointCount(option.points)}</span>
            </button>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-4 gap-2">
          <button
            type="button"
            onClick={undo}
            disabled={history.length === 0}
            className="inline-flex h-11 items-center justify-center rounded-md border border-pace-line bg-pace-white text-pace-ink transition hover:border-pace-yellow disabled:cursor-not-allowed disabled:opacity-40"
            title="Undo"
            aria-label="Undo"
          >
            <RotateCcw size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={addPoint}
            className="inline-flex h-11 items-center justify-center rounded-md border border-pace-line bg-pace-white text-pace-ink transition hover:border-pace-yellow"
            title="Add point"
            aria-label="Add point"
          >
            <Plus size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={deletePoint}
            disabled={selectedIndex == null || points.length <= 2}
            className="inline-flex h-11 items-center justify-center rounded-md border border-pace-line bg-pace-white text-pace-ink transition hover:border-pace-yellow disabled:cursor-not-allowed disabled:opacity-40"
            title="Delete selected point"
            aria-label="Delete selected point"
          >
            <Trash2 size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={approve}
            className="inline-flex h-11 items-center justify-center rounded-md border border-pace-yellow bg-pace-yellow text-pace-ink transition hover:bg-pace-white"
            title="Use sketch"
            aria-label="Use sketch"
          >
            <Check size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="mt-auto flex gap-2 pt-5">
          <button
            type="button"
            onClick={onBack}
            className="h-11 flex-1 rounded-md border border-pace-line bg-pace-white px-4 font-bebas text-sm tracking-[0.12em] text-pace-ink transition hover:border-pace-yellow"
          >
            Back
          </button>
          <button
            type="button"
            onClick={approve}
            className="h-11 flex-[2] rounded-md border border-pace-yellow bg-pace-yellow px-4 font-bebas text-sm tracking-[0.12em] text-pace-ink transition hover:bg-pace-white"
          >
            Use sketch
          </button>
        </div>
      </aside>

      <section className="flex min-h-[min(54vh,34rem)] flex-1 items-center justify-center overflow-hidden bg-pace-panel p-4 lg:min-h-0 lg:p-8">
        <div className="relative aspect-square w-full max-w-[min(84vh,48rem)] border border-pace-line bg-pace-white shadow-sm">
          <svg
            ref={svgRef}
            viewBox={`${view.cx - vbSize / 2} ${view.cy - vbSize / 2} ${vbSize} ${vbSize}`}
            className="h-full w-full touch-none"
            style={{ cursor: view.scale > 1 ? "grab" : "default" }}
            onPointerDown={startPan}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {imageBase64 ? (
              <image
                href={imageBase64}
                x="40"
                y="40"
                width="920"
                height="920"
                preserveAspectRatio="xMidYMid meet"
                opacity="0.18"
              />
            ) : null}
            <polyline
              points={toPolyline(contour)}
              fill="none"
              stroke="#111827"
              strokeWidth={routeStroke * 0.55}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.18"
            />
            <path
              d={toPath(points)}
              fill="none"
              stroke="#18844f"
              strokeWidth={routeStroke}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {points.map((p, i) => (
              <circle
                key={`${i}-${points.length}`}
                cx={p.x * 1000}
                cy={p.y * 1000}
                r={selectedIndex === i ? handleR * 1.5 : handleR}
                fill={selectedIndex === i ? "#ffb703" : "#ffffff"}
                stroke={selectedIndex === i ? "#111827" : "#18844f"}
                strokeWidth={handleStroke}
                onPointerDown={(event) => startDrag(i, event)}
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedIndex(i);
                }}
              />
            ))}
          </svg>
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-pace-line bg-pace-white/90 px-3 py-2 font-dm text-xs font-semibold text-pace-muted shadow-sm">
            {safePointCount(points)} · {view.scale.toFixed(1)}x
          </div>
          <div className="absolute right-3 top-3 flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => zoomBy(1.4)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-pace-line bg-pace-white text-pace-ink shadow-sm transition hover:border-pace-yellow"
              title="Zoom in (or scroll on the sketch)"
              aria-label="Zoom in"
            >
              <ZoomIn size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => zoomBy(1 / 1.4)}
              disabled={view.scale <= 1}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-pace-line bg-pace-white text-pace-ink shadow-sm transition hover:border-pace-yellow disabled:cursor-not-allowed disabled:opacity-40"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setView({ cx: 500, cy: 500, scale: 1 })}
              disabled={view.scale <= 1}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-pace-line bg-pace-white text-pace-ink shadow-sm transition hover:border-pace-yellow disabled:cursor-not-allowed disabled:opacity-40"
              title="Fit whole sketch"
              aria-label="Fit whole sketch"
            >
              <Maximize size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
