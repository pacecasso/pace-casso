"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { LatLngExpression } from "leaflet";
import L from "leaflet";
import { NormalizedPoint } from "./Step1ImageUpload";
import {
  autoFindTop5,
  type ShapeHint,
  type Top5Pick,
} from "../lib/autoFindTop5";
import { MANHATTAN_PRESET, type CityPreset } from "../lib/cityPresets";
import { buildAnchorLatLngsFromContour } from "../lib/placementFromContour";
import {
  analyzeOneLinePath,
  connectorSegmentPairs,
} from "../lib/oneLinePathAnalysis";
import {
  estimateSeconds,
  formatDistance,
  formatDuration,
  useRunnerProfile,
} from "../lib/runnerProfile";
import { OSM_TILE_ATTRIBUTION, OSM_TILE_URL } from "../lib/mapAttribution";
import { useLeafletContainerId } from "../lib/useLeafletContainerId";
import type { RouteLineString } from "../lib/routeTypes";
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
const FitBounds = dynamic(
  () => import("react-leaflet").then((m) => {
    /**
     * Fit the map to `line` — but ONLY when `nonce` changes (initial mount,
     * auto-find result, tapping a pick). The line itself changes on every
     * drag tick / rotate / scale, and refitting then yanks the map out from
     * under the user's cursor mid-drag.
     */
    function Step2FitBounds({
      line,
      nonce,
    }: {
      line: [number, number][];
      nonce: number;
    }) {
      const map = m.useMap();
      const lineRef = useRef(line);
      lineRef.current = line;
      useEffect(() => {
        const l = lineRef.current;
        if (l.length < 2) return;
        const bounds = L.latLngBounds(
          l.map(([lat, lng]) => L.latLng(lat, lng)),
        );
        if (!bounds.isValid()) return;
        map.fitBounds(bounds, {
          padding: [72, 72],
          maxZoom: 15,
          animate: false,
        });
      }, [nonce, map]);
      return null;
    }
    return Step2FitBounds;
  }),
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
  imageSourceName?: string | null;
  onBack: () => void;
  onComplete: (args: {
    anchorLatLngs: [number, number][];
    center: [number, number];
    rotationDeg: number;
    scale: number;
    connectorSegmentIndices?: number[];
    preferredSnappedRoute?: RouteLineString;
  }) => void;
};

export default function Step2MapAnchor({
  contour,
  cityPreset,
  defaultCenter = MANHATTAN_PRESET.defaultCenter,
  imageBase64,
  imageSourceName,
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
  const [preferredSnappedRoute, setPreferredSnappedRoute] =
    useState<RouteLineString | null>(null);
  const [selectedAnchorLatLngs, setSelectedAnchorLatLngs] = useState<
    [number, number][] | null
  >(null);
  // Bump to re-fit the map to the shape. Deliberately NOT tied to the shape
  // itself — dragging/rotating/scaling must never move the camera.
  const [fitNonce, setFitNonce] = useState(0);
  const [runnerProfile] = useRunnerProfile();

  const clearSelectedCandidateRoute = useCallback(() => {
    setSelectedPickIdx(null);
    setPreferredSnappedRoute(null);
    setSelectedAnchorLatLngs(null);
  }, []);

  const routeFromPick = useCallback((pick: Top5Pick) => {
    return pick.snappedRoute;
  }, []);

  const runAutoFind = useCallback(
    async (mode: "full" | "refine") => {
      setAutoBusy(true);
      setAutoHint(
        mode === "refine"
          ? "Polishing your placement…"
          : "Finding the best spots in the city…",
      );
      setPicks([]);
      setSelectedPickIdx(null);
      setPreferredSnappedRoute(null);
      setSelectedAnchorLatLngs(null);
      try {
        const r = await autoFindTop5(contour, cityPreset, {
          anchorSource: "image",
          imageBase64: imageBase64 ?? undefined,
          imageSourceName: imageSourceName ?? undefined,
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
          // We'd rather show nothing than a tangle that only looks like a
          // route in a thumbnail. Say so plainly and point at what works:
          // simpler artwork, or placing it by hand.
          setAutoHint(
            r.snapFailures && r.snapFailures > 0
              ? "The map service is busy right now — give it a minute and try again."
              : "Nothing we found would read as your artwork on the streets, so we're not showing guesses. Bold, simple shapes work best — or drag it where you want it and we'll fit it to the streets.",
          );
          window.setTimeout(() => setAutoHint(null), 9000);
          return;
        }
        setPicks(r.picks);
        setPicksVisionUsed(r.visionUsed);
        setPicksHint(r.hint ?? null);
        // Auto-apply the #1 pick so the map updates immediately; user can tap others.
        const first = r.picks[0]!;
        setCenter([...first.placement.center] as [number, number]);
        setRotationDeg(first.placement.rotationDeg);
        setScale(first.placement.scale);
        setSelectedPickIdx(0);
        setPreferredSnappedRoute(routeFromPick(first));
        setSelectedAnchorLatLngs(first.anchorLatLngs ?? null);
        setFitNonce((n) => n + 1);
        const partialNote =
          r.snapFailures && r.snapFailures > 0
            ? " Retry in a minute for even more."
            : "";
        setAutoHint(
          r.relaxedQuality
            ? `These are our best attempts so far — tap one and nudge it, or hit Refine to polish it.${partialNote}`
            : `Here are ${r.picks.length} options — tap one to try it.${partialNote}`,
        );
      } catch (err) {
        console.warn("[Step2] autoFindTop5 failed:", err);
        setAutoHint("Couldn’t reach routing — try again or adjust by hand.");
        window.setTimeout(() => setAutoHint(null), 5000);
      } finally {
        setAutoBusy(false);
      }
    },
    [
      contour,
      cityPreset,
      imageBase64,
      imageSourceName,
      center,
      rotationDeg,
      scale,
      targetDistanceKm,
      routeFromPick,
    ],
  );

  const applyPick = useCallback((pick: Top5Pick, idx: number) => {
    setCenter([...pick.placement.center] as [number, number]);
    setRotationDeg(pick.placement.rotationDeg);
    setScale(pick.placement.scale);
    setSelectedPickIdx(idx);
    setPreferredSnappedRoute(routeFromPick(pick));
    setSelectedAnchorLatLngs(pick.anchorLatLngs ?? null);
    setFitNonce((n) => n + 1);
  }, [routeFromPick]);

  const clearPicks = useCallback(() => {
    setPicks([]);
    setSelectedPickIdx(null);
    setPreferredSnappedRoute(null);
    setSelectedAnchorLatLngs(null);
    setPicksHint(null);
    setAutoHint(null);
  }, []);

  const centerHandleIcon = useMemo(() => {
    if (typeof window === "undefined") return null;
    const L = require("leaflet") as typeof import("leaflet");
    // Generous hit target — grabbing a tiny dot on a touchscreen was the #1
    // "moving the art doesn't work" complaint. Visual dot stays modest; the
    // transparent padding is all grab area.
    return L.divIcon({
      className: "",
      html:
        '<div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:grab;">' +
        '<div style="width:22px;height:22px;border-radius:9999px;background:#ffb800;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.35);"></div>' +
        "</div>",
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });
  }, []);

  const placedContour = useMemo(() => {
    return buildAnchorLatLngsFromContour(contour, {
      center,
      rotationDeg,
      scale,
    });
  }, [contour, center, rotationDeg, scale]);
  const anchorLatLngs = selectedAnchorLatLngs ?? placedContour.anchorLatLngs;
  const approxDistanceKm = selectedAnchorLatLngs
    ? selectedAnchorLatLngs.reduce((sum, p, idx) => {
        const prev = selectedAnchorLatLngs[idx - 1];
        if (!prev) return sum;
        const latMid = ((prev[0] + p[0]) / 2) * (Math.PI / 180);
        const metersPerLat = 111_320;
        const metersPerLng = 111_320 * Math.cos(latMid);
        return (
          sum +
          Math.hypot(
            (p[0] - prev[0]) * metersPerLat,
            (p[1] - prev[1]) * metersPerLng,
          ) /
            1000
        );
      }, 0)
    : placedContour.approxDistanceKm;

  const leafletPolyline: LatLngExpression[] = anchorLatLngs;
  const oneLineAnalysis = useMemo(() => analyzeOneLinePath(contour), [contour]);
  const connectorLatLngSegments = useMemo(
    () =>
      selectedAnchorLatLngs
        ? []
        :
      connectorSegmentPairs(
        anchorLatLngs,
        oneLineAnalysis.connectorSegmentIndices,
      ),
    [anchorLatLngs, oneLineAnalysis.connectorSegmentIndices, selectedAnchorLatLngs],
  );

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
                onChange={(e) => {
                  setRotationDeg(parseInt(e.target.value, 10));
                  clearSelectedCandidateRoute();
                }}
                className="h-1 w-full accent-pace-yellow"
              />
              <span className="text-right tabular-nums text-pace-muted">
                {Math.round(rotationDeg)}°
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
                onChange={(e) => {
                  setScale(parseFloat(e.target.value));
                  clearSelectedCandidateRoute();
                }}
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
                max={25}
                step={0.5}
                value={targetDistanceKm ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    setTargetDistanceKm(null);
                    return;
                  }
                  const n = parseFloat(v);
                  if (!Number.isFinite(n)) {
                    setTargetDistanceKm(null);
                    return;
                  }
                  setTargetDistanceKm(Math.min(25, Math.max(2, n)));
                }}
                placeholder="≈15"
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
            <p className="text-[10px] leading-snug text-pace-muted">
              Optional: target distance (km).
            </p>
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
            ) : null}
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
                        Ranked by how runnable and how recognizable each option
                        is.
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
              {picksHint?.reason && (
                <p className="-mt-1 text-[11px] italic leading-tight text-pace-muted">
                  “{picksHint.reason}”
                </p>
              )}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {picks.map((p, idx) => {
                  const selected = selectedPickIdx === idx;
                  const isTopPick = picksVisionUsed && idx === 0;
                  const isVerifiedRoute = p.verifiedRoute === true;
                  const isRunnableStarter =
                    !isVerifiedRoute &&
                    (p.qualityScore < 25 || p.sourceMatchScore < 45);
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
                          {isRunnableStarter ? "RUNNABLE STARTER" : "TOP PICK"}
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
                        {isVerifiedRoute ? (
                          <span
                            className="w-fit rounded-full bg-emerald-50 px-1.5 py-0.5 font-bebas text-[10px] tracking-[0.1em] text-emerald-700"
                            title={p.verificationLabel ?? "Verified curated route"}
                          >
                            VERIFIED MAP-NATIVE
                          </span>
                        ) : (
                          <>
                            <span
                              className={`w-fit rounded-full px-1.5 py-0.5 font-bebas text-[10px] tracking-[0.1em] ${
                                p.shapeMatchScore >= 78
                                  ? "bg-sky-50 text-sky-700"
                                  : p.shapeMatchScore >= 55
                                    ? "bg-amber-50 text-amber-700"
                                    : "bg-red-50 text-red-700"
                              }`}
                              title="How closely the streets follow your shape."
                            >
                              Shape {p.shapeMatchScore}%
                            </span>
                            <span
                              className={`w-fit rounded-full px-1.5 py-0.5 font-bebas text-[10px] tracking-[0.1em] ${
                                p.sourceMatchScore >= 72
                                  ? "bg-sky-50 text-sky-700"
                                  : p.sourceMatchScore >= 52
                                    ? "bg-amber-50 text-amber-700"
                                    : "bg-red-50 text-red-700"
                              }`}
                              title="How much the route resembles your art."
                            >
                              Looks like your art {p.sourceMatchScore}%
                            </span>
                            <span
                              className={`w-fit rounded-full px-1.5 py-0.5 font-bebas text-[10px] tracking-[0.1em] ${
                                p.qualityScore >= 78
                                  ? "bg-emerald-50 text-emerald-700"
                                  : p.qualityScore >= 55
                                    ? "bg-amber-50 text-amber-700"
                                    : "bg-red-50 text-red-700"
                              }`}
                              title="Higher means less doubling back."
                            >
                              Clean route {p.qualityScore}%
                            </span>
                          </>
                        )}
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
                connectorSegmentIndices:
                  !selectedAnchorLatLngs &&
                  oneLineAnalysis.connectorSegmentIndices.length > 0
                    ? oneLineAnalysis.connectorSegmentIndices
                    : undefined,
                preferredSnappedRoute:
                  preferredSnappedRoute &&
                  preferredSnappedRoute.coordinates.length >= 2
                    ? preferredSnappedRoute
                    : undefined,
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
            <FitBounds line={anchorLatLngs} nonce={fitNonce} />

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
                {connectorLatLngSegments.map((segment, idx) => (
                  <Polyline
                    key={`connector-${idx}`}
                    positions={segment}
                    pathOptions={{
                      color: "#ffb800",
                      weight: 7,
                      opacity: 0.96,
                      dashArray: "10 8",
                    }}
                  />
                ))}
                {centerHandleIcon && (
                  <Marker
                    position={center}
                    draggable
                    icon={centerHandleIcon}
                    eventHandlers={{
                      drag: (e) => {
                        const latlng = (e.target as { getLatLng: () => { lat: number; lng: number } }).getLatLng();
                        setCenter([latlng.lat, latlng.lng]);
                        clearSelectedCandidateRoute();
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
