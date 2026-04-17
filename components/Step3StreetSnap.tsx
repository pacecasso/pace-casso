"use client";

import dynamic from "next/dynamic";
import type { LatLngExpression } from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { OSM_TILE_ATTRIBUTION, OSM_TILE_URL } from "../lib/mapAttribution";
import {
  interpretationMatchPercent,
  shapeAccuracyPercent,
} from "../lib/shapeMatchScore";
import { snapWalkingRoute } from "../lib/snapWalkingRoute";
import LeafletInvalidateOnResize from "./LeafletInvalidateOnResize";
import MapChunkFallback from "./MapChunkFallback";
import MapStepSplitLayout from "./MapStepSplitLayout";
import ShapeMatchMeter from "./ShapeMatchMeter";
import type { AnchorLocation, RouteLineString } from "./WorkflowController";

function formatSnapError(err: unknown): string {
  if (!(err instanceof Error)) {
    return "We couldn’t reach the directions service. Check your connection and tap Retry.";
  }
  const m = err.message.toLowerCase();
  if (m.includes("401") || m.includes("403")) {
    return "Directions were blocked (access token). If this keeps happening, contact support.";
  }
  if (m.includes("429")) {
    return "Too many requests right now. Wait a moment and tap Retry.";
  }
  if (m.includes("network") || m.includes("failed to fetch")) {
    return "Network error while snapping. Check your connection and tap Retry.";
  }
  return `Couldn’t snap to streets: ${err.message}`;
}

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

type Step3StreetSnapProps = {
  anchorLocation: AnchorLocation;
  /** Photo trace: show original contour vs snapped line. Freehand: hide (same sketch as input). */
  routeSource: "image" | "freehand";
  onBack: () => void;
  onComplete: (route: RouteLineString) => void;
};

export default function Step3StreetSnap({
  anchorLocation,
  routeSource,
  onBack,
  onComplete,
}: Step3StreetSnapProps) {
  const [snapping, setSnapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<RouteLineString | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  const center = anchorLocation?.center ?? [40.7831, -73.9712];

  const originalPolyline: LatLngExpression[] =
    anchorLocation?.anchorLatLngs || [];
  const snappedPolyline: LatLngExpression[] = route?.coordinates || [];

  useEffect(() => {
    if (!anchorLocation?.anchorLatLngs?.length) return;

    const ac = new AbortController();
    let cancelled = false;

    void runSnapping();

    return () => {
      cancelled = true;
      ac.abort();
    };

    async function runSnapping() {
      setSnapping(true);
      setError(null);

      try {
        if (!anchorLocation) throw new Error("Missing anchor.");
        const coords = anchorLocation.anchorLatLngs;
        if (coords.length < 2) {
          throw new Error("Not enough points to snap to streets.");
        }

        const snappedRoute = await snapWalkingRoute(coords);
        if (cancelled || ac.signal.aborted) return;
        setRoute(snappedRoute);
      } catch (err: unknown) {
        if (cancelled || ac.signal.aborted) return;
        console.error(err);
        setError(formatSnapError(err));
      } finally {
        if (!cancelled && !ac.signal.aborted) setSnapping(false);
      }
    }
  }, [anchorLocation, retryToken]);

  const distanceKm = route?.distanceMeters
    ? route.distanceMeters / 1000
    : undefined;
  const walkMinutes = route?.distanceMeters
    ? (route.distanceMeters / 1000 / 5) * 60
    : undefined;
  const runMinutes = route?.distanceMeters
    ? (route.distanceMeters / 1000 / 10) * 60
    : undefined;

  const outlineForMatch = useMemo((): [number, number][] => {
    const pts = anchorLocation?.anchorLatLngs;
    if (!pts?.length) return [];
    return pts.map(([lat, lng]) => [lat, lng] as [number, number]);
  }, [anchorLocation?.anchorLatLngs]);

  const streetForMatch = useMemo((): [number, number][] => {
    const c = route?.coordinates;
    if (!c?.length) return [];
    return c.map(([lat, lng]) => [lat, lng] as [number, number]);
  }, [route?.coordinates]);

  const interpretationPct = useMemo(() => {
    if (outlineForMatch.length < 2 || streetForMatch.length < 2) return null;
    return interpretationMatchPercent(outlineForMatch, streetForMatch);
  }, [outlineForMatch, streetForMatch]);

  const tightFitPct = useMemo(() => {
    if (outlineForMatch.length < 2 || streetForMatch.length < 2) return null;
    return shapeAccuracyPercent(outlineForMatch, streetForMatch);
  }, [outlineForMatch, streetForMatch]);

  const matchMeterLabel =
    routeSource === "freehand"
      ? "Interpretation (sketch)"
      : "Interpretation (your art)";
  const matchMeterTitle =
    "GPS-art style score: multi-scale silhouette, forgiving of grid stair-steps.";
  const tightTitle =
    "Strict mean distance between outline and route (often lower on real streets).";

  return (
    <MapStepSplitLayout
      railCollapsed={railCollapsed}
      onToggleRail={() => setRailCollapsed((c) => !c)}
      sidebar={
        <>
          <div className="pace-highlight flex flex-col gap-0.5">
            <span className="font-bebas text-xs tracking-[0.12em] text-pace-yellow">
              Snap to streets
            </span>
            <span className="font-dm text-xs leading-snug text-pace-muted">
              We fit your shape to walkable streets using Mapbox Directions. If
              the request fails, it’s usually network or rate limits—Retry
              usually fixes it.
            </span>
          </div>

          <div className="mt-4 border-t border-pace-line pt-4">
            <ShapeMatchMeter
              label={matchMeterLabel}
              percent={interpretationPct}
              pendingText={snapping ? "…" : "—"}
              title={matchMeterTitle}
              secondaryPercent={interpretationPct != null ? tightFitPct : null}
              secondaryLabel="Tight fit"
              secondaryTitle={tightTitle}
            />
          </div>

          <div className="mt-4 space-y-3 border-t border-pace-line pt-4 font-dm text-xs text-pace-ink">
            {snapping ? (
              <p className="text-[11px] font-medium text-pace-blue">
                Snapping your route to walkable streets—usually a few seconds.
              </p>
            ) : null}
            {error && (
              <div
                className="space-y-2"
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
              >
                <p className="text-[11px] leading-snug text-red-600">{error}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="pace-toolbar-btn-primary font-bebas text-[11px] tracking-[0.06em]"
                    onClick={() => {
                      setError(null);
                      setRoute(null);
                      setRetryToken((t) => t + 1);
                    }}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="pace-toolbar-btn font-dm text-[11px]"
                    onClick={() => setError(null)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {distanceKm != null && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-pace-ink">
                  <span className="text-pace-muted">Distance</span>{" "}
                  <span className="font-bold tabular-nums text-pace-ink">
                    {distanceKm.toFixed(2)} km
                  </span>
                </p>
                <p className="text-[11px] text-pace-muted">
                  Walk ~{walkMinutes?.toFixed(0) ?? "—"} min · Run ~
                  {runMinutes?.toFixed(0) ?? "—"} min
                </p>
              </div>
            )}
          </div>
        </>
      }
      sidebarFooter={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-2">
          <button type="button" onClick={onBack} className="pace-toolbar-btn sm:min-w-0">
            Back
          </button>
          <button
            type="button"
            disabled={!route || snapping}
            onClick={() => {
              if (!route) return;
              onComplete(route);
            }}
            className="pace-toolbar-btn-primary font-bebas tracking-[0.08em] sm:shrink-0"
          >
            Tune route →
          </button>
        </div>
      }
      map={
        <div className="relative h-full min-h-0 w-full">
          {snapping ? (
            <div
              className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center bg-pace-warm/80 backdrop-blur-[1px]"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <div className="max-w-[14rem] rounded-md border border-pace-line bg-pace-white/95 px-4 py-3 text-center font-dm text-xs font-medium leading-snug text-pace-ink shadow-sm">
                Snapping to streets…
              </div>
            </div>
          ) : null}
          <MapContainer
            center={center as LatLngExpression}
            zoom={13}
            className="h-full w-full"
            scrollWheelZoom
          >
            <LeafletInvalidateOnResize />
            <TileLayer attribution={OSM_TILE_ATTRIBUTION} url={OSM_TILE_URL} />

            {routeSource === "image" && originalPolyline.length > 0 && (
              <Polyline
                positions={originalPolyline}
                pathOptions={{
                  color: "#065f46",
                  weight: 4,
                  opacity: 0.9,
                }}
              />
            )}
            {snappedPolyline.length > 0 && (
              <Polyline
                positions={snappedPolyline}
                pathOptions={{
                  color: "#b91c1c",
                  weight: 5,
                  opacity: 0.95,
                }}
              />
            )}
          </MapContainer>
        </div>
      }
    />
  );
}
