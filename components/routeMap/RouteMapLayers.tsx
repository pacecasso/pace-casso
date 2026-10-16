"use client";

/**
 * onthegomap-style route rendering, shared by the tap-to-route drawing step
 * and the Step 4 route editor. Must render inside a react-leaflet MapContainer.
 *
 * - Route: white casing + bold colour line; darkens on hover.
 * - Start = green dot, finish = dark dot, other handles = small white dots.
 * - Numbered km / mi markers along the line, thinned when zoomed out.
 * - Mouse hover on the line shows the distance at that spot.
 * - Mouse drag on the line pulls a new point out of it (Google/onthegomap).
 *   Touch keeps panning the map; touch users long-press for the menu.
 * - Right-click / long-press on a handle or the line reports a context menu.
 */

import { useMemo, useRef, useState } from "react";
import { Marker, Pane, Polyline, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { LatLngExpression, LeafletMouseEvent } from "leaflet";
import {
  distanceMarkers,
  legIndexAtAlong,
  projectOntoLine,
  type LatLng,
} from "../../lib/tapRoute";
import { KM_PER_MI, type DistanceUnit } from "../../lib/runnerProfile";

export const ROUTE_COLOR = "#1d6fd8";
export const ROUTE_COLOR_HOVER = "#0f4fa8";
const START_COLOR = "#16a34a";
const END_COLOR = "#0d0d0d";

export type RouteMapLeg = {
  coords: LatLng[];
  /** Still routing: faint dashed placeholder. */
  pending?: boolean;
  /** Not on streets (routing failed): amber dashed. */
  fallback?: boolean;
  /** Ruler leg the user asked for: thinner dashed line. */
  straight?: boolean;
};

export type RouteContextTarget =
  | { kind: "point"; index: number }
  | { kind: "leg"; legIndex: number; at: LatLng };

export type RouteContextRequest = {
  target: RouteContextTarget;
  /** Pixel position inside the map container. */
  x: number;
  y: number;
};

type Props = {
  legs: RouteMapLeg[];
  /** All legs joined — used for markers and hover distance. */
  line: LatLng[];
  points: LatLng[];
  showPoints: boolean;
  selectedIndices?: number[];
  unit: DistanceUnit;
  showDistanceMarkers?: boolean;
  onPointClick?: (index: number, e: LeafletMouseEvent) => void;
  onPointDragEnd?: (index: number, to: LatLng) => void;
  /** Mouse dragged the line at `from` (on leg `legIndex`) and dropped at `to`. */
  onLineDragInsert?: (legIndex: number, from: LatLng, to: LatLng) => void;
  onLineDoubleClick?: (at: LatLng) => void;
  onContextMenu?: (req: RouteContextRequest) => void;
};

function formatAlong(m: number, unit: DistanceUnit): string {
  const v = unit === "mi" ? m / 1000 / KM_PER_MI : m / 1000;
  return `${v < 10 ? v.toFixed(2) : v.toFixed(1)} ${unit}`;
}

function pointIcon(
  kind: "start" | "end" | "loop" | "mid",
  selected: boolean,
): L.DivIcon {
  const size = kind === "mid" ? 12 : 16;
  const fill =
    kind === "end" ? END_COLOR : kind === "mid" ? "#ffffff" : START_COLOR;
  // A closed loop's start is also its finish: green with a dark rim.
  const border =
    kind === "mid" ? ROUTE_COLOR : kind === "loop" ? END_COLOR : "#ffffff";
  const ring = selected
    ? "box-shadow:0 0 0 3px #ffb800,0 1px 4px rgba(0,0,0,0.45);"
    : "box-shadow:0 1px 4px rgba(0,0,0,0.45);";
  // 28 px transparent hit box around a small dot, so phones can grab it.
  return L.divIcon({
    className: "pace-otg-point",
    html: `<div style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;cursor:grab;"><div style="width:${size}px;height:${size}px;border-radius:9999px;background:${fill};border:2.5px solid ${border};${ring}"></div></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function markerIcon(n: number): L.DivIcon {
  return L.divIcon({
    className: "pace-otg-km",
    html: `<div style="min-width:18px;height:18px;padding:0 3px;border-radius:5px;background:#fff;border:2px solid ${ROUTE_COLOR};color:${ROUTE_COLOR};font:700 10px/14px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.3);">${n}</div>`,
    iconSize: [22, 18],
    iconAnchor: [11, 9],
  });
}

function hoverIcon(text: string): L.DivIcon {
  return L.divIcon({
    className: "pace-otg-hover",
    html: `<div style="position:relative;left:-50%;bottom:30px;white-space:nowrap;padding:3px 7px;border-radius:6px;background:rgba(13,13,13,0.82);color:#fff;font:600 11px/14px system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.35);">${text}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

const GHOST_ICON = L.divIcon({
  className: "pace-otg-ghost",
  html: `<div style="width:14px;height:14px;border-radius:9999px;background:#fff;border:3px solid ${ROUTE_COLOR_HOVER};box-shadow:0 1px 6px rgba(0,0,0,0.5);"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

/** Show every Nth marker so labels sit at least ~34 px apart. */
function markerStride(stepM: number, zoom: number, lat: number): number {
  const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const px = stepM / mPerPx;
  const need = 34 / Math.max(px, 1e-6);
  for (const s of [1, 2, 5, 10, 20, 50]) if (s >= need) return s;
  return 100;
}

export default function RouteMapLayers({
  legs,
  line,
  points,
  showPoints,
  selectedIndices = [],
  unit,
  showDistanceMarkers = true,
  onPointClick,
  onPointDragEnd,
  onLineDragInsert,
  onLineDoubleClick,
  onContextMenu,
}: Props) {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());
  const [hover, setHover] = useState<{ at: LatLng; text: string } | null>(null);
  const [ghost, setGhost] = useState<LatLng | null>(null);
  const dragRef = useRef<{ legIndex: number; from: LatLng; moved: boolean } | null>(null);

  useMapEvents({
    zoomend() {
      setZoom(map.getZoom());
    },
  });

  // Latest values for the native listeners below.
  const live = useRef({ line, legs, onLineDragInsert });
  live.current = { line, legs, onLineDragInsert };

  const stepM = unit === "mi" ? 1000 * KM_PER_MI : 1000;
  const markers = useMemo(() => {
    if (!showDistanceMarkers || line.length < 2) return [];
    const all = distanceMarkers(line, stepM);
    const stride = markerStride(stepM, zoom, line[0]![0]);
    return all.filter((m) => m.n % stride === 0);
  }, [showDistanceMarkers, line, stepM, zoom]);

  const lineLL = line as LatLngExpression[];

  function legAt(p: LatLng): { legIndex: number; at: LatLng; alongM: number } | null {
    const pr = projectOntoLine(live.current.line, p);
    if (!pr) return null;
    return {
      legIndex: legIndexAtAlong(live.current.legs, pr.alongM),
      at: pr.point,
      alongM: pr.alongM,
    };
  }

  /** Mouse-only drag-to-insert on the hit line. */
  function startLineDrag(ev: PointerEvent) {
    if (ev.pointerType === "touch" || ev.button !== 0) return;
    if (!live.current.onLineDragInsert) return;
    const start = map.mouseEventToLatLng(ev as unknown as MouseEvent);
    const hit = legAt([start.lat, start.lng]);
    if (!hit) return;
    ev.preventDefault();
    ev.stopPropagation();
    map.dragging.disable();
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    dragRef.current = { legIndex: hit.legIndex, from: hit.at, moved: false };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - x0, e.clientY - y0) < 5) return;
      d.moved = true;
      const ll = map.mouseEventToLatLng(e as unknown as MouseEvent);
      setGhost([ll.lat, ll.lng]);
      setHover(null);
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      map.dragging.enable();
      const d = dragRef.current;
      dragRef.current = null;
      setGhost(null);
      if (!d?.moved) return;
      // The browser fires a click after this mouseup; swallow it so the
      // tap-to-route editor does not also append a point.
      const kill = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener("click", kill, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", kill, true), 350);
      const ll = map.mouseEventToLatLng(e as unknown as MouseEvent);
      live.current.onLineDragInsert?.(d.legIndex, d.from, [ll.lat, ll.lng]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Attach on Leaflet's "add": the hit line lives in a custom pane that
  // mounts a render later, so a ref read in an effect can still be null.
  const startRef = useRef(startLineDrag);
  startRef.current = startLineDrag;
  const onHitPointerDown = useRef((e: Event) =>
    startRef.current(e as PointerEvent),
  ).current;

  const lastIndex = points.length - 1;
  const closed =
    points.length >= 3 &&
    points[0]![0] === points[lastIndex]![0] &&
    points[0]![1] === points[lastIndex]![1];

  return (
    <>
      {/* Casing under everything so the line reads on any tile colour. */}
      {line.length > 1 && (
        <Polyline
          positions={lineLL}
          pathOptions={{
            color: "#ffffff",
            weight: 9,
            opacity: 0.9,
            lineCap: "round",
            lineJoin: "round",
            interactive: false,
          }}
        />
      )}
      {legs.map((leg, i) =>
        leg.coords.length > 1 ? (
          <Polyline
            key={`leg-${i}-${leg.pending ? "p" : leg.fallback ? "f" : leg.straight ? "s" : "r"}`}
            positions={leg.coords as LatLngExpression[]}
            pathOptions={{
              color: leg.fallback
                ? "#f59e0b"
                : hover || ghost
                  ? ROUTE_COLOR_HOVER
                  : ROUTE_COLOR,
              weight: leg.straight ? 4 : 5,
              opacity: leg.pending ? 0.45 : 0.95,
              dashArray: leg.pending
                ? "2 8"
                : leg.fallback
                  ? "8 8"
                  : leg.straight
                    ? "10 6"
                    : undefined,
              lineCap: "round",
              lineJoin: "round",
              interactive: false,
            }}
          />
        ) : null,
      )}

      {/* Wide invisible hit line: hover distance, drag-insert, menus. */}
      <Pane name="paceOtgHitPane" style={{ zIndex: 450 }}>
        {line.length > 1 && (
          <Polyline
            positions={lineLL}
            pathOptions={{
              color: "#000",
              weight: 22,
              opacity: 0,
              lineCap: "round",
              lineJoin: "round",
              interactive: true,
              className: "pace-otg-hit",
            }}
            eventHandlers={{
              add(e) {
                const el = (e.target as L.Polyline).getElement();
                el?.addEventListener("pointerdown", onHitPointerDown);
              },
              remove(e) {
                const el = (e.target as L.Polyline).getElement();
                el?.removeEventListener("pointerdown", onHitPointerDown);
              },
              mousemove(e) {
                if (dragRef.current) return;
                const pr = projectOntoLine(line, [e.latlng.lat, e.latlng.lng]);
                if (pr) setHover({ at: pr.point, text: formatAlong(pr.alongM, unit) });
              },
              mouseout() {
                setHover(null);
              },
              dblclick(e) {
                if (!onLineDoubleClick) return;
                L.DomEvent.stop(e);
                onLineDoubleClick([e.latlng.lat, e.latlng.lng]);
              },
              contextmenu(e) {
                if (!onContextMenu) return;
                L.DomEvent.stop(e);
                e.originalEvent?.preventDefault();
                const hit = legAt([e.latlng.lat, e.latlng.lng]);
                if (!hit) return;
                onContextMenu({
                  target: { kind: "leg", legIndex: hit.legIndex, at: hit.at },
                  x: e.containerPoint.x,
                  y: e.containerPoint.y,
                });
              },
            }}
          />
        )}
      </Pane>

      {markers.map((m) => (
        <Marker
          key={`km-${m.n}`}
          position={m.at as LatLngExpression}
          icon={markerIcon(m.n)}
          interactive={false}
          zIndexOffset={200}
        />
      ))}

      {showPoints &&
        points.map((p, i) => {
          // Closed loop: one shared start/finish handle (index 0).
          if (closed && i === lastIndex) return null;
          const kind =
            i === 0 ? (closed ? "loop" : "start") : i === lastIndex ? "end" : "mid";
          return (
            <Marker
              key={`pt-${i}-${p[0].toFixed(6)}-${p[1].toFixed(6)}`}
              position={p as LatLngExpression}
              icon={pointIcon(kind, selectedIndices.includes(i))}
              draggable={Boolean(onPointDragEnd)}
              zIndexOffset={kind === "mid" ? 1000 : 1500}
              eventHandlers={{
                click(e) {
                  L.DomEvent.stop(e);
                  onPointClick?.(i, e);
                },
                dragstart() {
                  setHover(null);
                },
                dragend(e) {
                  const ll = (e.target as L.Marker).getLatLng();
                  onPointDragEnd?.(i, [ll.lat, ll.lng]);
                },
                contextmenu(e) {
                  if (!onContextMenu) return;
                  L.DomEvent.stop(e);
                  e.originalEvent?.preventDefault();
                  onContextMenu({
                    target: { kind: "point", index: i },
                    x: e.containerPoint.x,
                    y: e.containerPoint.y,
                  });
                },
              }}
            />
          );
        })}

      {hover && !ghost && (
        <Marker
          position={hover.at as LatLngExpression}
          icon={hoverIcon(hover.text)}
          interactive={false}
          zIndexOffset={3000}
        />
      )}
      {ghost && (
        <>
          {dragRef.current && (
            <Polyline
              positions={[dragRef.current.from, ghost] as LatLngExpression[]}
              pathOptions={{
                color: ROUTE_COLOR_HOVER,
                weight: 3,
                dashArray: "4 6",
                interactive: false,
              }}
            />
          )}
          <Marker
            position={ghost as LatLngExpression}
            icon={GHOST_ICON}
            interactive={false}
            zIndexOffset={3000}
          />
        </>
      )}
    </>
  );
}
