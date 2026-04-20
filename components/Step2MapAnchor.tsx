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
import {
  estimateSeconds,
  formatDistance,
  formatDuration,
  useRunnerProfile,
} from "../lib/runnerProfile";
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
   * the top snap candidates with PaceCasso's AI vision and picks by gestalt
   * match.
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
  const [targetDistanceKm, setTargetDistanceKm] = useState<number | null>(null);
  const [picks, setPicks] = useState<Top5Pick[]>([]);
  const [picksVisionUsed, setPicksVisionUsed] = useState(false);
  const [picksHint, setPicksHint] = useState<ShapeHint | null>(null);
  const [selectedPickIdx, setSelectedPickIdx] = useState<number | null>(null);
  const [runnerProfile] = useRunnerProfile();

  const runAutoFind = useCallback(
    async (mode: "full" | "refine") => {
      setAutoBusy(true);
      const modeLabel =
        mode === "refine" ? "Refining around your placement" : "Searching placements";
      setAutoHint(
        imageBase64
          ? `${modeLabel} — PaceCasso AI will rank the top 5…`
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
          targetDistanceKm:
            mode === "full" && targetDistanceKm != null
              ? targetDistanceKm
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
            ? `PaceCasso ranked ${r.picks.length} ${modeNoun} — tap any to try it.`
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
    [contour, cityPreset, imageBase64, center, rotationDeg, scale, targetDistanceKm],
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
            <div
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition ${
                targetDistanceKm != null
                  ? "border-pace-yellow bg-pace-yellow/10"
                  : "border-pace-line bg-pace-white"
              }`}
            >
              <label
                htmlFor="target-distance"
                className="shrink-0 font-bebas text-[11px] tracking-[0.14em] text-pace-muted"
              >
                Distance
              </label>
              <input
                id="target-distance"
                type="number"
                min={2}
                max={40}
                step={0.5}
                value={targetDistanceKm ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    setTargetDistanceKm(null);
                    return;
                  }
                  const n = parseFloat(v);
                  setTargetDistanceKm(Number.isFinite(n) ? n : null);
                }}
                placeholder="any"
                className="w-14 border-0 bg-transparent p-0 text-xs font-semibold tabular-nums text-pace-ink placeholder:font-normal placeholder:text-pace-muted focus:outline-none focus:ring-0"
              />
              <span className="text-[11px] font-medium text-pace-muted">km</span>
              {targetDistanceKm != null && (
                <button
                  type="button"
                  onClick={() => setTargetDistanceKm(null)}
                  className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-base leading-none text-pace-muted transition hover:bg-pace-ink/10 hover:text-pace-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow"
                  title="Clear target distance"
                  aria-label="Clear target distance"
                >
                  ×
                </button>
              )}
            </div>
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
              <p className="text-[11px] leading-snug text-pace-muted">{autoHint}</p>
            ) : (
              <p className="text-[11px] leading-snug text-pace-muted">
                <strong>Auto-find:</strong> searches the whole city.{" "}
                <strong>Refine:</strong> searches ~2 km around where you&apos;ve
                put it now, at similar size and angle.
              </p>
            )}
          </div>

          {autoBusy && picks.length === 0 && (
            <div className="mt-3 flex flex-col gap-2 rounded border border-pace-line bg-pace-warm/50 p-2">
              <div className="flex items-center justify-between">
                <span className="font-bebas text-[11px] tracking-[0.1em] text-pace-muted">
                  Working on it…
                </span>
                <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-pace-yellow motion-reduce:animate-none" aria-hidden />
              </div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex animate-pulse flex-col overflow-hidden rounded-lg border border-pace-line bg-white shadow-sm motion-reduce:animate-none"
                    style={{ animationDelay: `${i * 120}ms` }}
                    aria-hidden
                  >
                    <div className="aspect-square w-full bg-gradient-to-br from-pace-line/50 to-pace-line/20" />
                    <div className="space-y-1.5 px-2 py-1.5">
                      <div className="h-2 w-1/3 rounded bg-pace-line/60" />
                      <div className="h-1.5 w-3/4 rounded bg-pace-line/40" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {picks.length > 0 && (
            <div className="mt-3 flex flex-col gap-2 rounded border border-pace-line bg-pace-warm/50 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-bebas text-[11px] tracking-[0.1em] text-pace-ink">
                  {picksVisionUsed ? "PaceCasso top picks" : "Candidates"}
                  {picksVisionUsed && (
                    /* Keyboard-accessible "Why these picks?" tooltip. `summary`
                       toggles on click AND Enter; screen readers announce the
                       open/closed state automatically. */
                    <details className="group relative">
                      <summary
                        className="flex h-5 w-5 cursor-pointer list-none items-center justify-center rounded-full border border-pace-line bg-white text-[10px] font-bold text-pace-muted transition hover:border-pace-blue hover:text-pace-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-blue [&::-webkit-details-marker]:hidden"
                        aria-label="How PaceCasso ranks these picks"
                        title="How PaceCasso ranks these picks"
                      >
                        ?
                      </summary>
                      <div
                        role="tooltip"
                        className="absolute left-0 top-7 z-10 w-[260px] rounded-md border border-pace-line bg-white p-2.5 text-[11px] leading-snug text-pace-ink shadow-md"
                      >
                        PaceCasso ranks placements by two things, in order:
                        <ol className="mt-1.5 space-y-1 pl-4 [list-style-type:decimal]">
                          <li>
                            <span className="font-semibold">Walkability</span> —
                            the route stays on real streets, no water or park
                            detours.
                          </li>
                          <li>
                            <span className="font-semibold">Shape match</span> —
                            the silhouette reads clearly from above.
                          </li>
                        </ol>
                      </div>
                    </details>
                  )}
                </span>
                <button
                  type="button"
                  onClick={clearPicks}
                  className="min-h-[32px] rounded px-2 py-1 text-[11px] text-pace-muted underline underline-offset-2 transition hover:bg-pace-ink/5 hover:text-pace-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow"
                >
                  clear
                </button>
              </div>
              {picksHint && (
                <p className="-mt-1 text-[11px] leading-tight text-pace-muted">
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
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {picks.map((p, idx) => {
                  const selected = selectedPickIdx === idx;
                  const isTopPick = picksVisionUsed && idx === 0;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => applyPick(p, idx)}
                      className={`group relative flex flex-col overflow-hidden rounded-lg border bg-white text-left shadow-sm transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-blue focus-visible:ring-offset-2 ${
                        selected
                          ? "-translate-y-0.5 border-pace-yellow shadow-md ring-2 ring-pace-yellow/60"
                          : isTopPick
                            ? "border-pace-yellow/70 hover:-translate-y-0.5 hover:shadow-md"
                            : "border-pace-line hover:-translate-y-0.5 hover:border-pace-yellow/60 hover:shadow-md"
                      }`}
                      title={p.reason || `Option ${idx + 1}`}
                    >
                      {p.previewDataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.previewDataUrl}
                          alt={`${isTopPick ? "Top pick: " : `Option ${idx + 1}: `}${formatDistance(p.distanceKm, runnerProfile.unit)}${p.reason ? ` — ${p.reason}` : ""}`}
                          className="aspect-square w-full object-cover"
                        />
                      ) : (
                        <div
                          className="aspect-square w-full bg-pace-line/30"
                          role="img"
                          aria-label={`Option ${idx + 1}: preview unavailable`}
                        />
                      )}
                      <span
                        className={`absolute left-1.5 top-1.5 rounded-full px-2 py-0.5 font-bebas text-[11px] tracking-wider shadow-sm transition ${
                          selected
                            ? "bg-pace-yellow text-pace-ink"
                            : "bg-pace-ink/85 text-white"
                        }`}
                      >
                        {idx + 1}
                      </span>
                      {isTopPick && (
                        <span className="absolute right-1.5 top-1.5 rounded-full bg-pace-yellow px-2 py-0.5 font-bebas text-[10px] tracking-[0.1em] text-pace-ink shadow-sm">
                          ★ TOP PICK
                        </span>
                      )}
                      <div className="flex flex-col gap-1 px-2 py-2">
                        <span className="flex items-baseline gap-1.5 tabular-nums text-pace-ink">
                          <span className="text-[12px] font-semibold">
                            {formatDistance(p.distanceKm, runnerProfile.unit)}
                          </span>
                          <span className="text-[11px] font-medium text-pace-muted">
                            ·{" "}
                            {formatDuration(
                              estimateSeconds(
                                p.distanceKm,
                                runnerProfile.paceSecPerKm,
                              ),
                            )}
                          </span>
                        </span>
                        {p.reason && (
                          <span className="text-[11px] leading-snug text-pace-ink/75">
                            {p.reason}
                          </span>
                        )}
                      </div>
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
