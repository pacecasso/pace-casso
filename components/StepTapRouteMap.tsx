"use client";

/**
 * Leaflet subtree for StepTapRoute (static react-leaflet imports in one
 * client-only module, like Step4LeafletMap — per-component dynamic imports
 * break map context in Next.js).
 */

import { useEffect } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { LatLngExpression, LeafletMouseEvent } from "leaflet";
import { OSM_TILE_ATTRIBUTION, OSM_TILE_URL } from "../lib/mapAttribution";
import { useLeafletContainerId } from "../lib/useLeafletContainerId";
import LeafletInvalidateOnResize from "./LeafletInvalidateOnResize";
import RouteMapLayers, {
  type RouteContextRequest,
  type RouteMapLeg,
} from "./routeMap/RouteMapLayers";
import type { LatLng } from "../lib/tapRoute";
import type { DistanceUnit } from "../lib/runnerProfile";

function MapReady({ onMap }: { onMap: (m: L.Map) => void }) {
  const map = useMap();
  useEffect(() => {
    onMap(map);
  }, [map, onMap]);
  return null;
}

function ClickHandler({
  onClick,
}: {
  onClick: (at: LatLng, e: LeafletMouseEvent) => void;
}) {
  useMapEvents({
    click(e) {
      onClick([e.latlng.lat, e.latlng.lng], e);
    },
    contextmenu(e) {
      // Empty-map right-click: no browser menu over the map.
      e.originalEvent?.preventDefault();
    },
  });
  return null;
}

export type StepTapRouteMapProps = {
  center: LatLng;
  legs: RouteMapLeg[];
  line: LatLng[];
  points: LatLng[];
  selectedIndex: number | null;
  unit: DistanceUnit;
  onMapReady: (m: L.Map) => void;
  onMapClick: (at: LatLng, e: LeafletMouseEvent) => void;
  onPointClick: (index: number, e: LeafletMouseEvent) => void;
  onPointDragEnd: (index: number, to: LatLng) => void;
  onLineDragInsert: (legIndex: number, from: LatLng, to: LatLng) => void;
  onContextMenu: (req: RouteContextRequest) => void;
};

export default function StepTapRouteMap({
  center,
  legs,
  line,
  points,
  selectedIndex,
  unit,
  onMapReady,
  onMapClick,
  onPointClick,
  onPointDragEnd,
  onLineDragInsert,
  onContextMenu,
}: StepTapRouteMapProps) {
  const leafletId = useLeafletContainerId();
  return (
    <MapContainer
      id={leafletId}
      center={center as LatLngExpression}
      zoom={15}
      className="pace-otg-map z-0 h-full w-full"
      scrollWheelZoom
      doubleClickZoom={false}
      zoomControl={false}
    >
      <MapReady onMap={onMapReady} />
      <LeafletInvalidateOnResize />
      <ClickHandler onClick={onMapClick} />
      <TileLayer attribution={OSM_TILE_ATTRIBUTION} url={OSM_TILE_URL} />
      <RouteMapLayers
        legs={legs}
        line={line}
        points={points}
        showPoints
        selectedIndices={selectedIndex === null ? [] : [selectedIndex]}
        unit={unit}
        onPointClick={onPointClick}
        onPointDragEnd={onPointDragEnd}
        onLineDragInsert={onLineDragInsert}
        onContextMenu={onContextMenu}
      />
    </MapContainer>
  );
}
