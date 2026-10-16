"use client";

/**
 * Single client-only Leaflet subtree with static react-leaflet imports.
 * Per-component dynamic() imports can break map context / layer registration in Next.js.
 */

import { useCallback, useEffect, useMemo } from "react";
import {
  MapContainer,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import { OSM_TILE_ATTRIBUTION, OSM_TILE_URL } from "../lib/mapAttribution";
import { useLeafletContainerId } from "../lib/useLeafletContainerId";
import LeafletInvalidateOnResize from "./LeafletInvalidateOnResize";
import type { LatLngExpression } from "leaflet";
import RouteMapLayers, {
  type RouteContextRequest,
} from "./routeMap/RouteMapLayers";
import { joinLegs } from "../lib/tapRoute";
import type { DistanceUnit } from "../lib/runnerProfile";

type Waypoint = [number, number];

function MapReady({
  onMap,
}: {
  onMap: (map: L.Map) => void;
}) {
  const map = useMap();
  useEffect(() => {
    onMap(map);
    map.doubleClickZoom?.disable();
    const id = requestAnimationFrame(() => {
      map.invalidateSize({ animate: false });
    });
    return () => cancelAnimationFrame(id);
  }, [map, onMap]);
  return null;
}

/** Fit only when `staticLine` is usable; otherwise use `fallbackLine` (e.g. waypoints only). */
function FitRouteBounds({
  staticLine,
  fallbackLine,
}: {
  staticLine: Waypoint[] | null;
  fallbackLine: Waypoint[];
}) {
  const map = useMap();
  const line =
    staticLine && staticLine.length >= 2 ? staticLine : fallbackLine;
  useEffect(() => {
    if (line.length < 2) return;
    const bounds = L.latLngBounds(
      line.map(([lat, lng]) => L.latLng(lat, lng)),
    );
    if (!bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [56, 56], maxZoom: 17, animate: false });
  }, [map, line]);
  return null;
}

function MapInteractionHandlers({
  onDoubleClick,
  onMapClick,
}: {
  onDoubleClick: (lat: number, lng: number) => void;
  onMapClick: () => void;
}) {
  useMapEvents({
    dblclick(e) {
      e.originalEvent?.preventDefault();
      e.originalEvent?.stopPropagation();
      onDoubleClick(e.latlng.lat, e.latlng.lng);
    },
    click() {
      onMapClick();
    },
  });
  return null;
}

export type Step4LeafletMapProps = {
  center: Waypoint;
  /** When length >= 2, fit bounds use this only (stable when editing waypoints). */
  fitBoundsStaticLine: Waypoint[] | null;
  /** Used for fit when static line is missing or too short. */
  fitBoundsFallbackLine: Waypoint[];
  /** Full Mapbox/snapped geometry (only drawn when true — avoids “dead” tails past your waypoints). */
  streetLine: Waypoint[];
  showFaintFullStreet: boolean;
  originalArt: Waypoint[];
  originalArtConnectorSegments?: [Waypoint, Waypoint][];
  showOriginalArt: boolean;
  legPolylines: Waypoint[][];
  /** Indices of legs currently rendered as straight-line fallbacks. Drawn with
   *  a dashed amber overlay so the user can see which segments aren't walkable. */
  spurLegIndices?: number[];
  /** When false, markers are hidden so the user can preview the final route line only. */
  showWaypoints: boolean;
  waypoints: Waypoint[];
  selectedWaypointIndex: number | null;
  shiftSelectedIndices: number[];
  onClearSelection: () => void;
  onWaypointMarkerClick: (index: number, shiftKey: boolean) => void;
  onWaypointDragEnd: (index: number, lat: number, lng: number) => void;
  onMapDoubleClickLatLng: (lat: number, lng: number) => void;
  /** Mouse dragged the line out of leg `legIndex` at `from`, dropped at `to`. */
  onLineDragInsert: (
    legIndex: number,
    from: [number, number],
    to: [number, number],
  ) => void;
  onContextMenu: (req: RouteContextRequest) => void;
  unit: DistanceUnit;
  onMapReady: (map: L.Map) => void;
};

export default function Step4LeafletMap({
  center,
  fitBoundsStaticLine,
  fitBoundsFallbackLine,
  streetLine,
  showFaintFullStreet,
  originalArt,
  originalArtConnectorSegments = [],
  showOriginalArt,
  legPolylines,
  spurLegIndices,
  showWaypoints,
  waypoints,
  selectedWaypointIndex,
  shiftSelectedIndices,
  onClearSelection,
  onWaypointMarkerClick,
  onWaypointDragEnd,
  onMapDoubleClickLatLng,
  onLineDragInsert,
  onContextMenu,
  unit,
  onMapReady,
}: Step4LeafletMapProps) {
  const spurSet = useMemo(() => new Set(spurLegIndices ?? []), [spurLegIndices]);
  const mapLegs = useMemo(
    () =>
      legPolylines.map((coords, i) => ({
        coords: coords as [number, number][],
        fallback: spurSet.has(i),
      })),
    [legPolylines, spurSet],
  );
  const joined = useMemo(() => joinLegs(mapLegs), [mapLegs]);
  const selected = useMemo(
    () =>
      selectedWaypointIndex === null
        ? shiftSelectedIndices
        : [...shiftSelectedIndices, selectedWaypointIndex],
    [selectedWaypointIndex, shiftSelectedIndices],
  );

  const stableOnMap = useCallback(
    (m: L.Map) => {
      onMapReady(m);
    },
    [onMapReady],
  );
  const leafletId = useLeafletContainerId();

  return (
    <MapContainer
      id={leafletId}
      center={center as LatLngExpression}
      zoom={14}
      className="h-full w-full z-0"
      scrollWheelZoom
      dragging
      doubleClickZoom={false}
      zoomControl={false}
    >
      <MapReady onMap={stableOnMap} />
      <LeafletInvalidateOnResize />
      <FitRouteBounds
        staticLine={fitBoundsStaticLine}
        fallbackLine={fitBoundsFallbackLine}
      />
      <MapInteractionHandlers
        onDoubleClick={onMapDoubleClickLatLng}
        onMapClick={onClearSelection}
      />
      <TileLayer attribution={OSM_TILE_ATTRIBUTION} url={OSM_TILE_URL} />
      {showOriginalArt && originalArt.length > 1 && (
        <>
          <Polyline
            positions={originalArt as LatLngExpression[]}
            pathOptions={{
              color: "#059669",
              weight: 5,
              opacity: 0.92,
              dashArray: "10 6",
              lineCap: "round",
              lineJoin: "round",
              interactive: false,
            }}
          />
          {originalArtConnectorSegments.map((segment, idx) => (
            <Polyline
              key={`art-connector-${idx}`}
              positions={segment as LatLngExpression[]}
              pathOptions={{
                color: "#ffb800",
                weight: 7,
                opacity: 0.96,
                dashArray: "10 8",
                lineCap: "round",
                lineJoin: "round",
                interactive: false,
              }}
            />
          ))}
        </>
      )}
      {showFaintFullStreet && streetLine.length > 1 && (
        <Polyline
          positions={streetLine as LatLngExpression[]}
          pathOptions={{
            color: "#7f1d1d",
            weight: 5,
            opacity: 0.28,
            lineCap: "round",
            lineJoin: "round",
            interactive: false,
          }}
        />
      )}
      <RouteMapLayers
        legs={mapLegs}
        line={joined}
        points={waypoints as [number, number][]}
        showPoints={showWaypoints}
        selectedIndices={selected}
        unit={unit}
        onPointClick={(i, e) => onWaypointMarkerClick(i, e.originalEvent.shiftKey)}
        onPointDragEnd={(i, to) => onWaypointDragEnd(i, to[0], to[1])}
        onLineDoubleClick={(at) => onMapDoubleClickLatLng(at[0], at[1])}
        onLineDragInsert={onLineDragInsert}
        onContextMenu={onContextMenu}
      />
    </MapContainer>
  );
}
