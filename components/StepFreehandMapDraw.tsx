"use client";

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { LatLngExpression } from "leaflet";
import { flattenStrokesForSnap } from "../lib/flattenFreehandStrokes";
import {
  centroidLatLng,
  latLngPathToNormalizedContour,
} from "../lib/latLngPathToNormalizedContour";
import type { NormalizedPoint } from "./Step1ImageUpload";
import { OSM_TILE_ATTRIBUTION, OSM_TILE_URL } from "../lib/mapAttribution";
import { useLeafletContainerId } from "../lib/useLeafletContainerId";
import LeafletInvalidateOnResize from "./LeafletInvalidateOnResize";
import MapChunkFallback from "./MapChunkFallback";
import MapStepSplitLayout from "./MapStepSplitLayout";

const MapContainer = dynamic(
  () => import("react-leaflet").then((m) => m.MapContainer),
  { ssr: false, loading: () => <MapChunkFallback /> },
);
const TileLayer = dynamic(
  () => import("react-leaflet").then((m) => m.TileLayer),
  { ssr: false },
);
const Polyline = dynamic(
  () => import("react-leaflet").then((m) => m.Polyline),
  { ssr: false },
);
const CircleMarker = dynamic(
  () => import("react-leaflet").then((m) => m.CircleMarker),
  { ssr: false },
);

const PenLayer = dynamic(() => import("./StepFreehandMapPenLayer"), {
  ssr: false,
});

const MIN_POINT_M = 4;
const MAX_POINTS_TOTAL = 1600;

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b[0] - a[0]);
  const dLng = toR(b[1] - a[1]);
  const lat1 = toR(a[0]);
  const lat2 = toR(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function countPoints(strokes: [number, number][][]): number {
  return strokes.reduce((n, s) => n + s.length, 0);
}

function downsampleLatLng(
  pts: [number, number][],
  maxPts: number,
): [number, number][] {
  if (pts.length <= maxPts) return pts;
  const step = Math.ceil(pts.length / maxPts);
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function trimSingletonTrailing(strokes: [number, number][][]): [number, number][][] {
  if (!strokes.length) return strokes;
  const last = strokes[strokes.length - 1]!;
  if (last.length < 2) return strokes.slice(0, -1);
  return strokes;
}

type Props = {
  defaultCenter: [number, number];
  onBack: () => void;
  onComplete: (payload: {
    anchorLatLngs: [number, number][];
    contour: NormalizedPoint[];
    center: [number, number];
  }) => void;
};

export default function StepFreehandMapDraw({
  defaultCenter,
  onBack,
  onComplete,
}: Props) {
  const [mode, setMode] = useState<"draw" | "pan">("pan");
  const [strokes, setStrokes] = useState<[number, number][][]>([]);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const leafletId = useLeafletContainerId();
  const lastInStrokeRef = useRef<[number, number] | null>(null);

  const finalizeOpenStroke = useCallback(() => {
    lastInStrokeRef.current = null;
    setStrokes((prev) => trimSingletonTrailing(prev));
  }, []);

  const setModeSafe = useCallback(
    (next: "draw" | "pan") => {
      if (next === "pan" && mode === "draw") {
        finalizeOpenStroke();
      }
      setMode(next);
    },
    [mode, finalizeOpenStroke],
  );

  const onStrokeStart = useCallback((lat: number, lng: number) => {
    const p: [number, number] = [lat, lng];
    lastInStrokeRef.current = p;
    setStrokes((prev) => {
      if (countPoints(prev) >= MAX_POINTS_TOTAL) return prev;
      return [...prev, [p]];
    });
  }, []);

  const onStrokePoint = useCallback((lat: number, lng: number) => {
    const next: [number, number] = [lat, lng];
    const last = lastInStrokeRef.current;
    if (last) {
      const d = haversineM(last, next);
      if (d < MIN_POINT_M) return;
    }
    lastInStrokeRef.current = next;
    setStrokes((prev) => {
      if (!prev.length) return [[[lat, lng]]];
      if (countPoints(prev) >= MAX_POINTS_TOTAL) return prev;
      const copy = prev.slice();
      const cur = copy[copy.length - 1]!.slice();
      cur.push(next);
      copy[copy.length - 1] = cur;
      return copy;
    });
  }, []);

  const onStrokeEnd = useCallback(() => {
    finalizeOpenStroke();
  }, [finalizeOpenStroke]);

  /** Double-click in draw mode: forced vertex (no MIN_POINT_M), extends last stroke or starts a singleton. */
  const onDoubleClickAnchor = useCallback((lat: number, lng: number) => {
    const p: [number, number] = [lat, lng];
    setStrokes((prev) => {
      if (countPoints(prev) >= MAX_POINTS_TOTAL) return prev;
      if (!prev.length) {
        lastInStrokeRef.current = p;
        return [[p]];
      }
      const copy = prev.slice();
      const lastStroke = copy[copy.length - 1]!;
      const cur = lastStroke.slice();
      cur.push(p);
      copy[copy.length - 1] = cur;
      lastInStrokeRef.current = p;
      return copy;
    });
  }, []);

  const handleUndo = useCallback(() => {
    setStrokes((prev) => {
      if (!prev.length) return prev;
      const copy = prev.slice();
      let lastStroke = copy[copy.length - 1]!;
      if (lastStroke.length <= 1) {
        copy.pop();
        lastInStrokeRef.current = null;
        return copy;
      }
      lastStroke = lastStroke.slice(0, -1);
      copy[copy.length - 1] = lastStroke;
      lastInStrokeRef.current =
        lastStroke.length > 0 ? lastStroke[lastStroke.length - 1]! : null;
      return copy;
    });
  }, []);

  const handleClear = useCallback(() => {
    lastInStrokeRef.current = null;
    setStrokes([]);
  }, []);

  const flatForExport = flattenStrokesForSnap(strokes);

  const handleDone = useCallback(() => {
    const flat = flattenStrokesForSnap(strokes);
    if (flat.length < 2) return;
    const anchorLatLngs = downsampleLatLng(flat, MAX_POINTS_TOTAL);
    const center = centroidLatLng(anchorLatLngs);
    const contour = latLngPathToNormalizedContour(
      anchorLatLngs,
    ) as NormalizedPoint[];
    onComplete({ anchorLatLngs, contour, center });
  }, [strokes, onComplete]);

  return (
    <MapStepSplitLayout
      railCollapsed={railCollapsed}
      onToggleRail={() => setRailCollapsed((c) => !c)}
      sidebar={
        <>
          <div className="pace-highlight flex flex-col gap-0.5">
            <span className="font-bebas text-xs tracking-[0.12em] text-pace-yellow">
              Draw on the map
            </span>
            <span className="font-dm text-[11px] leading-snug text-pace-muted">
              <strong className="text-pace-ink">Move map</strong> to pan/zoom.{" "}
              <strong className="text-pace-ink">Draw</strong> to sketch.{" "}
              <strong className="text-pace-ink">Double-click</strong> to drop a
              corner anchor, or <strong className="text-pace-ink">
                Shift+click
              </strong>{" "}
              if double-click still zooms your browser. Each drag is one stroke —
              connect corners yourself if you need one continuous path.
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setModeSafe("pan")}
              className={`rounded-xl border-2 px-3 py-2.5 text-xs font-bold transition-all sm:text-sm ${
                mode === "pan"
                  ? "border-pace-blue bg-pace-blue/10 text-pace-ink shadow-sm"
                  : "border-pace-line bg-pace-white text-pace-muted hover:border-pace-yellow/50"
              }`}
            >
              Move map
            </button>
            <button
              type="button"
              onClick={() => setModeSafe("draw")}
              className={`rounded-xl border-2 px-3 py-2.5 text-xs font-bold transition-all sm:text-sm ${
                mode === "draw"
                  ? "border-pace-yellow bg-pace-yellow/15 text-pace-ink shadow-sm"
                  : "border-pace-line bg-pace-white text-pace-muted hover:border-pace-yellow/50"
              }`}
            >
              Draw
            </button>
          </div>

          <p
            className={`mt-3 text-center text-[11px] font-medium ${
              mode === "draw" ? "text-pace-yellow" : "text-pace-muted"
            }`}
          >
            {mode === "draw"
              ? "Drawing on — sketch or double-click anchors. Switch to Move map to pan."
              : "Move mode — pan the map. Switch to Draw when you’re ready."}
          </p>

          <div className="mt-4 flex flex-wrap gap-2 border-t border-pace-line pt-4">
            <button
              type="button"
              onClick={handleUndo}
              disabled={strokes.length === 0}
              className="pace-toolbar-btn px-2 py-1.5 disabled:opacity-40"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={strokes.length === 0}
              className="pace-toolbar-btn px-2 py-1.5 disabled:opacity-40"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={onBack}
              className="pace-toolbar-btn px-2 py-1.5"
            >
              Back
            </button>
          </div>
          <button
            type="button"
            disabled={flatForExport.length < 2}
            onClick={handleDone}
            className="pace-toolbar-btn-primary mt-2 w-full px-3 py-2 font-bebas tracking-[0.08em] disabled:opacity-40"
          >
            Snap to streets →
          </button>
        </>
      }
      map={
        <div className="relative h-full min-h-0 w-full">
          <MapContainer
            id={leafletId}
            center={defaultCenter as LatLngExpression}
            zoom={14}
            className="z-0 h-full w-full"
            scrollWheelZoom
            doubleClickZoom={mode === "pan"}
          >
            <LeafletInvalidateOnResize />
            <TileLayer attribution={OSM_TILE_ATTRIBUTION} url={OSM_TILE_URL} />
            {strokes.map((stroke, i) =>
              stroke.length === 1 ? (
                <CircleMarker
                  key={`anchor-dot-${i}`}
                  center={stroke[0] as LatLngExpression}
                  radius={5}
                  pathOptions={{
                    color: "#16a34a",
                    fillColor: "#16a34a",
                    fillOpacity: 0.95,
                    weight: 2,
                  }}
                />
              ) : stroke.length > 1 ? (
                <Polyline
                  key={i}
                  positions={stroke as LatLngExpression[]}
                  pathOptions={{
                    color: "#16a34a",
                    weight: 5,
                    opacity: 0.95,
                    lineCap: "round",
                    lineJoin: "round",
                  }}
                />
              ) : null,
            )}
            <PenLayer
              mode={mode}
              onStrokeStart={onStrokeStart}
              onStrokePoint={onStrokePoint}
              onStrokeEnd={onStrokeEnd}
              onDoubleClickAnchor={onDoubleClickAnchor}
            />
          </MapContainer>
        </div>
      }
    />
  );
}
