"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { LatLngExpression } from "leaflet";
import { NormalizedPoint } from "./Step1ImageUpload";
import {
  autoFindTop5,
  type ShapeHint,
  type Top5Pick,
} from "../lib/autoFindTop5";
import { MANHATTAN_PRESET, type CityPreset } from "../lib/cityPresets";
import { buildAnchorLatLngsFromContour } from "../lib/placementFromContour";
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
const Marker = dynamic(
  () => import("react-leaflet").then((m) => m.Marker),
  { ssr: false },
);

type Step2MapAnchorProps = {
  contour: NormalizedPoint[];
  cityPreset: CityPreset;
  /** Defaults to Manhattan; use selected city preset center. */
  defaultCenter?: [number, number];
  /**
   * Original uploaded image as a data-URL. When provided, auto-find rescores
   * the top snap candidates with Claude vision and picks by gestalt match.
   */
  imageBase64?: string | null;
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
  cityPreset,
  defaultCenter = MANHATTAN_PRESET.defaultCenter,
  imageBase64,
  onBack,
  onComplete,
}: Step2MapAnchorProps) {
  const [rotationDeg, setRotationDeg] = useState(0);
  const [scale, setScale] = useState(1);
  const [center, setCenter] = useState<[number, number]>(defaultCenter);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoHint, setAutoHint] = useState<string | null>(null);
  const leafletId = useLeafletContainerId();
  const [picks, setPicks] = useState<Top5Pick[]>([]);
  const [picksVisionUsed, setPicksVisionUsed] = useState(false);
  const [picksHint, setPicksHint] = useState<ShapeHint | null>(null);
  const [selectedPickIdx, setSelectedPickIdx] = useState<number | null>(null);

  const runAutoFind = useCallback(
    async (mode: "full" | "refine") => {
      setAutoBusy(true);
      const modeLabel =
        mode === "refine" ? "Refining around your placement" : "Searching placements";
      setAutoHint(
        imageBase64
          ? `${modeLabel} — Claude will rank the top 5…`
          : `${modeLabel}…`,
      );
      setPicks([]);
      setSelectedPickIdx(null);
      try {
        const r = await autoFindTop5(contour, cityPreset, {
          anchorSource: "image",
          imageBase64: imageBase64 ?? undefined,
          anchorAround:
            mode === "refine"
              ? { center, rotationDeg, scale }
              : undefined,
        });
        if (r.picks.length === 0) {
          setAutoHint("No viable placements found — try adjusting manually.");
          window.setTimeout(() => setAutoHint(null), 5000);
          return;
        }
        setPicks(r.picks);
        setPicksVisionUsed(r.visionUsed);
        setPicksHint(r.hint ?? null);
        // Auto-apply the #1 pick so the map updates immediately; user can tap others.
        const first = r.picks[0]!;
        setCenter([...first.placement.center] as [number, number]);
        setRotationDeg(Math.round(first.placement.rotationDeg));
        setScale(Math.round(first.placement.scale * 10) / 10);
        setSelectedPickIdx(0);
        const modeNoun = mode === "refine" ? "refinements" : "options";
        setAutoHint(
          r.visionUsed
            ? `Claude ranked ${r.picks.length} ${modeNoun} — tap any to try it.`
            : `Showing ${r.picks.length} ${modeNoun} — tap any to try it.`,
        );
      } catch (err) {
        console.warn("[Step2] autoFindTop5 failed:", err);
        setAutoHint("Couldn’t reach routing — try again or adjust by hand.");
        window.setTimeout(() => setAutoHint(null), 5000);
      } finally {
        setAutoBusy(false);
      }
    },
    [contour, cityPreset, imageBase64, center, rotationDeg, scale],
  );

  const applyPick = useCallback((pick: Top5Pick, idx: number) => {
    setCenter([...pick.placement.center] as [number, number]);
    setRotationDeg(Math.round(pick.placement.rotationDeg));
    setScale(Math.round(pick.placement.scale * 10) / 10);
    setSelectedPickIdx(idx);
  }, []);

  const clearPicks = useCallback(() => {
    setPicks([]);
    setSelectedPickIdx(null);
    setPicksHint(null);
    setAutoHint(null);
  }, []);

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

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              disabled={autoBusy || !contour.length}
              onClick={() => void runAutoFind("full")}
              className="pace-toolbar-btn w-full py-2.5 text-[11px] font-semibold disabled:opacity-50 sm:text-xs"
            >
              {autoBusy ? "Working…" : "Auto-find placement"}
            </button>
            <button
              type="button"
              disabled={autoBusy || !contour.length}
              onClick={() => void runAutoFind("refine")}
              className="w-full rounded border border-pace-line bg-pace-white py-2 text-[11px] font-medium text-pace-ink transition hover:border-pace-yellow hover:bg-pace-warm disabled:opacity-50 sm:text-xs"
              title="Search tightly around where you've placed the shape — good once you've nudged it into roughly the right area."
            >
              Refine around my placement
            </button>
            {autoHint ? (
              <p className="text-[10px] leading-snug text-pace-muted">{autoHint}</p>
            ) : (
              <p className="text-[10px] leading-snug text-pace-muted">
                <strong>Auto-find:</strong> searches the whole city.{" "}
                <strong>Refine:</strong> searches ~2 km around where you've put it
                now, at similar size and angle.
              </p>
            )}
          </div>

          {picks.length > 0 && (
            <div className="mt-3 flex flex-col gap-2 rounded border border-pace-line bg-pace-warm/50 p-2">
              <div className="flex items-center justify-between">
                <span className="font-bebas text-[11px] tracking-[0.1em] text-pace-ink">
                  {picksVisionUsed ? "Claude's top picks" : "Candidates"}
                </span>
                <button
                  type="button"
                  onClick={clearPicks}
                  className="text-[10px] text-pace-muted underline underline-offset-2 hover:text-pace-ink"
                >
                  clear
                </button>
              </div>
              {picksHint && (
                <p className="-mt-1 text-[10px] leading-tight text-pace-muted">
                  <span className="font-semibold text-pace-ink">
                    {picksHint.shapeClass}
                  </span>
                  <span> · {picksHint.rotationStrategy}</span>
                  <span> · {picksHint.scaleHint}</span>
                  {picksHint.reason && (
                    <span className="block italic text-pace-muted">
                      “{picksHint.reason}”
                    </span>
                  )}
                </p>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                {picks.map((p, idx) => {
                  const selected = selectedPickIdx === idx;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => applyPick(p, idx)}
                      className={`relative flex flex-col overflow-hidden rounded border transition ${
                        selected
                          ? "border-pace-yellow ring-2 ring-pace-yellow/50"
                          : "border-pace-line hover:border-pace-yellow/60"
                      } bg-white p-1 text-left`}
                      title={p.reason || `Option ${idx + 1}`}
                    >
                      {p.previewDataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.previewDataUrl}
                          alt={`Option ${idx + 1}`}
                          className="aspect-square w-full object-contain"
                        />
                      ) : (
                        <div className="aspect-square w-full bg-pace-line/30" />
                      )}
                      <span className="absolute left-1 top-1 rounded bg-pace-ink/85 px-1.5 py-0.5 font-bebas text-[10px] text-white">
                        {idx + 1}
                      </span>
                      <span className="mt-1 text-[10px] font-medium tabular-nums text-pace-muted">
                        {p.distanceKm.toFixed(1)} km
                      </span>
                      {p.reason && (
                        <span className="line-clamp-2 text-[9px] leading-tight text-pace-muted">
                          {p.reason}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

        </>
      }
      sidebarFooter={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onBack}
            className="pace-toolbar-btn shrink-0"
          >
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
            className="pace-toolbar-btn-primary flex-1 font-bebas tracking-[0.08em]"
          >
            Snap to streets →
          </button>
        </div>
      }
      map={
        <div className="relative h-full min-h-0 w-full">
          <MapContainer
            id={leafletId}
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
