"use client";

/**
 * Single client-only Leaflet subtree with static react-leaflet imports.
 * Per-component dynamic() imports can break map context / layer registration in Next.js.
 */

import { useCallback, useEffect, useMemo } from "react";
import {
  MapContainer,
  Marker,
  Pane,
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
  /** Merged path through current waypoints — bold “active” route. */
  activeRouteLine: Waypoint[];
  originalArt: Waypoint[];
  showOriginalArt: boolean;
  legPolylines: Waypoint[][];
  /** When false, markers are hidden so the user can preview the final route line only. */
  showWaypoints: boolean;
  waypoints: Waypoint[];
  selectedWaypointIndex: number | null;
  shiftSelectedIndices: number[];
  onClearSelection: () => void;
  onWaypointMarkerClick: (index: number, shiftKey: boolean) => void;
  onWaypointDragEnd: (index: number, lat: number, lng: number) => void;
  onMapDoubleClickLatLng: (lat: number, lng: number) => void;
  onMapReady: (map: L.Map) => void;
};

export default function Step4LeafletMap({
  center,
  fitBoundsStaticLine,
  fitBoundsFallbackLine,
  streetLine,
  showFaintFullStreet,
  activeRouteLine,
  originalArt,
  showOriginalArt,
  legPolylines,
  showWaypoints,
  waypoints,
  selectedWaypointIndex,
  shiftSelectedIndices,
  onClearSelection,
  onWaypointMarkerClick,
  onWaypointDragEnd,
  onMapDoubleClickLatLng,
  onMapReady,
}: Step4LeafletMapProps) {
  const waypointIcons = useMemo(
    () => ({
      normal: L.divIcon({
        className: "pace-waypoint-icon",
        html: `<div style="width:18px;height:18px;border-radius:9999px;background:#f59e0b;border:3px solid #fef3c7;box-shadow:0 2px 8px rgba(0,0,0,0.45);pointer-events:auto;cursor:grab;"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
      selected: L.divIcon({
        className: "pace-waypoint-icon pace-waypoint-icon--selected",
        html: `<div style="width:20px;height:20px;border-radius:9999px;background:#f59e0b;border:3px solid #fff;box-shadow:0 0 0 2px rgba(245,158,11,0.9),0 2px 10px rgba(0,0,0,0.5);pointer-events:auto;cursor:grab;"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
      /** Shift multi-select (2+): same square frame on every marked waypoint. */
      multiSquare: L.divIcon({
        className: "pace-waypoint-icon pace-waypoint-icon--multi",
        html: `<div style="width:28px;height:28px;display:flex;align-items:center;justify-content:center;position:relative;pointer-events:auto;cursor:grab;">
          <div style="position:absolute;inset:0;border:2px solid #fff;border-radius:3px;box-shadow:0 0 0 2px rgba(245,158,11,0.95),0 2px 10px rgba(0,0,0,0.5);pointer-events:none;"></div>
          <div style="width:12px;height:12px;border-radius:9999px;background:#f59e0b;border:2px solid #fef3c7;flex-shrink:0;"></div>
        </div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    }),
    [],
  );

  const multiSelectActive = shiftSelectedIndices.length > 1;

  function waypointIconFor(i: number): L.DivIcon {
    if (multiSelectActive && shiftSelectedIndices.includes(i)) {
      return waypointIcons.multiSquare;
    }
    if (shiftSelectedIndices.includes(i) || selectedWaypointIndex === i) {
      return waypointIcons.selected;
    }
    return waypointIcons.normal;
  }

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
      {activeRouteLine.length > 1 && (
        <Polyline
          positions={activeRouteLine as LatLngExpression[]}
          pathOptions={{
            color: "#b91c1c",
            weight: 6,
            opacity: 0.95,
            lineCap: "round",
            lineJoin: "round",
            interactive: false,
          }}
        />
      )}
      {/* Invisible wide hit targets only — avoids stacking semi-transparent red on the visible route */}
      <Pane name="step4RouteHitPane" style={{ zIndex: 450 }}>
        {legPolylines.map((positions, legIndex) =>
          positions.length >= 2 ? (
            <Polyline
              key={`leg-hit-${legIndex}`}
              className="cursor-pointer"
              positions={positions as LatLngExpression[]}
              pathOptions={{
                color: "#b91c1c",
                weight: 22,
                opacity: 0,
                lineCap: "round",
                lineJoin: "round",
                interactive: true,
              }}
              eventHandlers={{
                dblclick(e) {
                  e.originalEvent?.preventDefault();
                  e.originalEvent?.stopPropagation();
                  const ll = e.latlng;
                  onMapDoubleClickLatLng(ll.lat, ll.lng);
                },
              }}
            />
          ) : null,
        )}
      </Pane>
      {showWaypoints &&
        waypoints.map((pos, i) => (
          <Marker
            key={`wp-${i}-${pos[0].toFixed(6)}-${pos[1].toFixed(6)}`}
            position={pos as LatLngExpression}
            icon={waypointIconFor(i)}
            zIndexOffset={1000 + i}
            draggable
            eventHandlers={{
              click(e) {
                e.originalEvent?.stopPropagation();
                onWaypointMarkerClick(i, e.originalEvent.shiftKey);
              },
              dragend(e) {
                const ll = e.target.getLatLng();
                onWaypointDragEnd(i, ll.lat, ll.lng);
              },
            }}
          />
        ))}
    </MapContainer>
  );
}
