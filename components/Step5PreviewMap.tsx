"use client";

import { useEffect } from "react";
import L from "leaflet";
import type { LatLngExpression } from "leaflet";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";
import { OSM_TILE_ATTRIBUTION, OSM_TILE_URL } from "../lib/mapAttribution";
import { useLeafletContainerId } from "../lib/useLeafletContainerId";

type LatLng = [number, number];

function FitCombinedBounds({
  routeLine,
  originalArt,
  showArt,
}: {
  routeLine: LatLng[];
  originalArt: LatLng[];
  showArt: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    const pts: L.LatLng[] = [];
    if (routeLine.length >= 2) {
      routeLine.forEach(([lat, lng]) => pts.push(L.latLng(lat, lng)));
    }
    if (showArt && originalArt.length >= 2) {
      originalArt.forEach(([lat, lng]) => pts.push(L.latLng(lat, lng)));
    }
    if (pts.length < 2) return;
    const b = L.latLngBounds(pts);
    if (!b.isValid()) return;
    map.fitBounds(b, { padding: [48, 48], maxZoom: 17, animate: false });
  }, [map, routeLine, originalArt, showArt]);
  return null;
}

export type Step5PreviewMapProps = {
  routeLine: LatLng[];
  originalArt: LatLng[];
  originalArtConnectorSegments?: [LatLng, LatLng][];
  showOriginalArt: boolean;
  /** mark where the route starts (green) and finishes (dark); /draw results */
  showEndpoints?: boolean;
  /**
   * For a map that sits in a long page (/draw results): the page must keep
   * scrolling when a thumb or the mouse wheel passes over it. On a phone one
   * finger scrolls the page and two fingers move and zoom the map; with a
   * mouse the wheel scrolls the page, and dragging and the +/- buttons work
   * the map. Nov 12 phone check: a swipe that began on a map did nothing, and
   * the five maps fill most of the results page.
   */
  pageScroll?: boolean;
};

export default function Step5PreviewMap({
  routeLine,
  originalArt,
  originalArtConnectorSegments = [],
  showOriginalArt,
  showEndpoints = false,
  pageScroll = false,
}: Step5PreviewMapProps) {
  const center: LatLng =
    routeLine[0] ??
    originalArt[0] ??
    ([40.7831, -73.9712] as LatLng);
  const leafletId = useLeafletContainerId();

  return (
    <MapContainer
      id={leafletId}
      center={center as LatLngExpression}
      zoom={14}
      className="z-0 h-full min-h-[280px] w-full rounded-xl border border-pace-line bg-pace-white shadow-inner"
      scrollWheelZoom={!pageScroll}
      dragging={!(pageScroll && L.Browser.mobile)}
      doubleClickZoom
    >
      <FitCombinedBounds
        routeLine={routeLine}
        originalArt={originalArt}
        showArt={showOriginalArt}
      />
      <TileLayer attribution={OSM_TILE_ATTRIBUTION} url={OSM_TILE_URL} />
      {showOriginalArt && originalArt.length > 1 && (
        <>
          <Polyline
            positions={originalArt as LatLngExpression[]}
            pathOptions={{
              color: "#059669",
              weight: 4,
              opacity: 0.88,
              dashArray: "10 6",
              lineCap: "round",
              lineJoin: "round",
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
              }}
            />
          ))}
        </>
      )}
      {routeLine.length > 1 && (
        <Polyline
          positions={routeLine as LatLngExpression[]}
          pathOptions={{
            color: "#b91c1c",
            weight: 6,
            opacity: 0.95,
            lineCap: "round",
            lineJoin: "round",
          }}
        />
      )}
      {showEndpoints && routeLine.length > 1 && (
        <>
          <CircleMarker
            center={routeLine[routeLine.length - 1] as LatLngExpression}
            radius={7}
            pathOptions={{ color: "#ffffff", weight: 2, fillColor: "#111827", fillOpacity: 1 }}
          >
            <Tooltip>Finish</Tooltip>
          </CircleMarker>
          <CircleMarker
            center={routeLine[0] as LatLngExpression}
            radius={8}
            pathOptions={{ color: "#ffffff", weight: 2, fillColor: "#16a34a", fillOpacity: 1 }}
          >
            <Tooltip>Start</Tooltip>
          </CircleMarker>
        </>
      )}
    </MapContainer>
  );
}
