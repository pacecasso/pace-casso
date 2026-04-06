"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { LatLngExpression } from "leaflet";
import { NormalizedPoint } from "./Step1ImageUpload";
import { MANHATTAN_PRESET } from "../lib/cityPresets";
import { buildAnchorLatLngsFromContour } from "../lib/placementFromContour";
import { OSM_TILE_ATTRIBUTION, OSM_TILE_URL } from "../lib/mapAttribution";
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
const Marker = dynamic(
  () => import("react-leaflet").then((m) => m.Marker),
  { ssr: false },
);

type Step2MapAnchorProps = {
  contour: NormalizedPoint[];
  /** Defaults to Manhattan; use selected city preset center. */
  defaultCenter?: [number, number];
  onBack: () => void;
  onComplete: (args: {
    anchorLatLngs: [number, number][];
    center: [number, number];
    rotationDeg: number;
    scale: number;
  }) => void;
};

export default function Step2MapAnchor({
  contour,
  defaultCenter = MANHATTAN_PRESET.defaultCenter,
  onBack,
  onComplete,
}: Step2MapAnchorProps) {
  const [rotationDeg, setRotationDeg] = useState(0);
  const [scale, setScale] = useState(1);
  const [center, setCenter] = useState<[number, number]>(defaultCenter);
  const [railCollapsed, setRailCollapsed] = useState(false);

  const centerHandleIcon = useMemo(() => {
    if (typeof window === "undefined") return null;
    const L = require("leaflet") as typeof import("leaflet");
    return L.divIcon({
      className: "",
      html:
        '<div style="width:16px;height:16px;border-radius:9999px;background:#ffb800;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.25);"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }, []);

  const { anchorLatLngs, approxDistanceKm } = useMemo(() => {
    return buildAnchorLatLngsFromContour(contour, {
      center,
      rotationDeg,
      scale,
    });
  }, [contour, center, rotationDeg, scale]);

  const leafletPolyline: LatLngExpression[] = anchorLatLngs;

  return (
    <MapStepSplitLayout
      railCollapsed={railCollapsed}
      onToggleRail={() => setRailCollapsed((c) => !c)}
      sidebar={
        <>
          <div className="pace-highlight flex flex-col gap-0.5">
            <span className="font-bebas text-xs tracking-[0.12em] text-pace-yellow">
              Place on map
            </span>
            <span className="font-dm text-[11px] leading-snug text-pace-muted">
              Drag the yellow dot to move. Set rotation and size, then continue.
            </span>
          </div>

          <div className="mt-4 flex flex-col gap-4 text-xs text-pace-ink">
            <label className="flex flex-col gap-1.5">
              <span className="whitespace-nowrap font-medium text-pace-muted">
                Rotate
              </span>
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={rotationDeg}
                onChange={(e) => setRotationDeg(parseInt(e.target.value, 10))}
                className="h-1 w-full accent-pace-yellow"
              />
              <span className="text-right tabular-nums text-pace-muted">
                {rotationDeg}°
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="whitespace-nowrap font-medium text-pace-muted">
                Scale
              </span>
              <input
                type="range"
                min={0.5}
                max={3}
                step={0.1}
                value={scale}
                onChange={(e) => setScale(parseFloat(e.target.value))}
                className="h-1 w-full accent-pace-yellow"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="tabular-nums text-pace-muted">
                  {scale.toFixed(1)}×
                </span>
                {approxDistanceKm > 0 && (
                  <span className="text-[11px] font-semibold text-emerald-600">
                    ≈ {approxDistanceKm.toFixed(2)} km
                  </span>
                )}
              </div>
            </label>
          </div>

          <div className="mt-6 flex flex-col gap-2 border-t border-pace-line pt-4">
            <button type="button" onClick={onBack} className="pace-toolbar-btn">
              Back
            </button>
            <button
              type="button"
              disabled={!anchorLatLngs.length}
              onClick={() =>
                onComplete({
                  anchorLatLngs,
                  center,
                  rotationDeg,
                  scale,
                })
              }
              className="pace-toolbar-btn-primary font-bebas tracking-[0.08em]"
            >
              Snap to streets →
            </button>
          </div>
        </>
      }
      map={
        <div className="relative h-full min-h-0 w-full">
          <MapContainer
            center={defaultCenter}
            zoom={13}
            className="h-full w-full"
            scrollWheelZoom
          >
            <LeafletInvalidateOnResize />
            <TileLayer attribution={OSM_TILE_ATTRIBUTION} url={OSM_TILE_URL} />

            {leafletPolyline.length > 0 && (
              <>
                <Polyline
                  positions={leafletPolyline}
                  pathOptions={{
                    color: "#16a34a",
                    weight: 5,
                    opacity: 0.92,
                  }}
                />
                {centerHandleIcon && (
                  <Marker
                    position={center}
                    draggable
                    icon={centerHandleIcon}
                    eventHandlers={{
                      drag: (e) => {
                        const latlng = (e.target as { getLatLng: () => { lat: number; lng: number } }).getLatLng();
                        setCenter([latlng.lat, latlng.lng]);
                      },
                    }}
                  />
                )}
              </>
            )}
          </MapContainer>
        </div>
      }
    />
  );
}
