"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnchorLocation, RouteLineString } from "./WorkflowController";
import {
  fetchWalkingTurnCues,
  shouldAppendStreetLabel,
  type WalkingCue,
  waypointsForDirectionsQuery,
} from "./mapboxWalkingCues";
import MapChunkFallback from "./MapChunkFallback";
import { getShareTwitterHandle } from "../lib/siteConfig";
import { getSiteUrl } from "../lib/siteUrl";
import { saveFinalizedRoute } from "../lib/finalizedRouteMemory";
import {
  isRouteAnimationSupported,
  recordRouteAnimation,
} from "../lib/recordRouteAnimation";

const Step5PreviewMap = dynamic(() => import("./Step5PreviewMap"), {
  ssr: false,
  loading: () => (
    <MapChunkFallback className="h-[min(420px,50vh)] min-h-[280px]" />
  ),
});

type Props = {
  route: RouteLineString;
  anchorLocation: AnchorLocation;
  routeSource: "image" | "freehand";
  onBackToFineTune: () => void;
  onStartOver: () => void;
};

function safeCoords(route: RouteLineString): [number, number][] {
  return (route.coordinates ?? []).filter(
    (c): c is [number, number] =>
      Array.isArray(c) &&
      typeof c[0] === "number" &&
      Number.isFinite(c[0]) &&
      typeof c[1] === "number" &&
      Number.isFinite(c[1]),
  );
}

function routeToGeoJSONFeature(route: RouteLineString) {
  const coords = safeCoords(route);
  return {
    type: "Feature" as const,
    properties: {
      name: "PaceCasso walking route",
      distanceMeters: route.distanceMeters ?? null,
      waypointCount: route.blockWaypoints?.length ?? null,
      pathVertexCount: coords.length,
    },
    geometry: {
      type: "LineString" as const,
      coordinates: coords.map(([lat, lng]) => [lng, lat] as [number, number]),
    },
  };
}

function routeToGeoJSONFeatureCollection(
  route: RouteLineString,
  cues: WalkingCue[],
) {
  const features: Record<string, unknown>[] = [routeToGeoJSONFeature(route)];
  cues.forEach((c, i) => {
    features.push({
      type: "Feature",
      properties: {
        name: `Cue ${i + 1}`,
        instruction: c.instruction,
        street: c.street,
      },
      geometry: {
        type: "Point",
        coordinates: [c.lng, c.lat] as [number, number],
      },
    });
  });
  return { type: "FeatureCollection" as const, features };
}

function routeToGpx(route: RouteLineString, cues: WalkingCue[]): string {
  const coords = safeCoords(route);
  const pts = coords
    .map(
      ([lat, lng]) =>
        `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></trkpt>`,
    )
    .join("\n");
  const name = "PaceCasso route";
  // Guard cue coords too — a non-finite lat/lng would emit <wpt lat="NaN">
  // which breaks every GPX parser.
  const safeCues = cues.filter(
    (c) => Number.isFinite(c.lat) && Number.isFinite(c.lng),
  );
  const wptBlock =
    safeCues.length > 0
      ? `${safeCues
          .map((c) => {
            const desc =
              c.street && shouldAppendStreetLabel(c.instruction, c.street)
                ? `\n    <desc>${escapeXml(c.street)}</desc>`
                : "";
            return `  <wpt lat="${c.lat.toFixed(7)}" lon="${c.lng.toFixed(7)}">
    <name>${escapeXml(c.instruction)}</name>${desc}
  </wpt>`;
          })
          .join("\n")}\n`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
${wptBlock}  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

function cuesToPlainText(cues: WalkingCue[]): string {
  return cues
    .map((c, i) => {
      const extra =
        c.street && shouldAppendStreetLabel(c.instruction, c.street)
          ? ` (${c.street})`
          : "";
      return `${i + 1}. ${c.instruction}${extra}`;
    })
    .join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function triggerDownload(filename: string, mime: string, body: string) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Step5RouteComplete({
  route,
  anchorLocation,
  routeSource,
  onBackToFineTune,
  onStartOver,
}: Props) {
  const showArtControls = routeSource === "image";
  const [showArtOnMap, setShowArtOnMap] = useState(showArtControls);
  const [turnCues, setTurnCues] = useState<WalkingCue[]>([]);
  const [cuesLoading, setCuesLoading] = useState(false);
  const [cuesError, setCuesError] = useState<string | null>(null);
  /** Bumped to force the cues useEffect to re-run. Used by the Retry button. */
  const [cuesRetryNonce, setCuesRetryNonce] = useState(0);
  const [shareHint, setShareHint] = useState<string | null>(null);
  const [canNativeShare, setCanNativeShare] = useState(false);

  useEffect(() => {
    setCanNativeShare(
      typeof navigator !== "undefined" && typeof navigator.share === "function",
    );
  }, []);

  // Remember this finalized placement so future auto-find runs can lean
  // toward similar layouts. Stored per-browser in localStorage only.
  useEffect(() => {
    if (!anchorLocation) return;
    const distanceKm = (route.distanceMeters ?? 0) / 1000;
    if (!Number.isFinite(distanceKm) || distanceKm <= 0) return;
    saveFinalizedRoute({
      center: anchorLocation.center,
      rotationDeg: anchorLocation.rotationDeg,
      scale: anchorLocation.scale,
      distanceKm,
    });
  }, [anchorLocation, route.distanceMeters]);

  const routeLine = useMemo(
    () => (route.coordinates ?? []) as [number, number][],
    [route.coordinates],
  );

  const originalArt = useMemo(
    () => (anchorLocation?.anchorLatLngs ?? []) as [number, number][],
    [anchorLocation?.anchorLatLngs],
  );

  const hasArt = originalArt.length >= 2;

  useEffect(() => {
    const coords = (route.coordinates ?? []) as [number, number][];
    const block = route.blockWaypoints as [number, number][] | undefined;
    const queryWps = waypointsForDirectionsQuery(block, coords);
    if (queryWps.length < 2) {
      setTurnCues([]);
      setCuesError(null);
      setCuesLoading(false);
      return;
    }

    let cancelled = false;
    setCuesLoading(true);
    setCuesError(null);

    fetchWalkingTurnCues(queryWps, { referenceLine: coords })
      .then((c) => {
        if (!cancelled) setTurnCues(c);
      })
      .catch((e) => {
        if (!cancelled) {
          setTurnCues([]);
          setCuesError(
            e instanceof Error ? e.message : "Could not load turn cues",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setCuesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [route.blockWaypoints, route.coordinates, cuesRetryNonce]);

  const retryCues = useCallback(() => setCuesRetryNonce((n) => n + 1), []);

  const downloadGeoJSON = useCallback(() => {
    const fc =
      turnCues.length > 0
        ? routeToGeoJSONFeatureCollection(route, turnCues)
        : { type: "FeatureCollection" as const, features: [routeToGeoJSONFeature(route)] };
    triggerDownload(
      "pacecasso-route.geojson",
      "application/geo+json",
      JSON.stringify(fc, null, 2),
    );
  }, [route, turnCues]);

  const downloadGpx = useCallback(() => {
    triggerDownload(
      "pacecasso-route.gpx",
      "application/gpx+xml",
      routeToGpx(route, turnCues),
    );
  }, [route, turnCues]);

  const downloadCueSheet = useCallback(() => {
    if (!turnCues.length) return;
    triggerDownload(
      "pacecasso-turn-cues.txt",
      "text/plain;charset=utf-8",
      cuesToPlainText(turnCues),
    );
  }, [turnCues]);

  const [animBusy, setAnimBusy] = useState(false);
  const [animError, setAnimError] = useState<string | null>(null);
  const [animSupported, setAnimSupported] = useState(false);
  useEffect(() => {
    setAnimSupported(isRouteAnimationSupported());
  }, []);

  const downloadAnimation = useCallback(async () => {
    setAnimBusy(true);
    setAnimError(null);
    try {
      const coords = routeLine;
      if (coords.length < 2) {
        setAnimError("Route too short to animate.");
        return;
      }
      const distanceLabel =
        route.distanceMeters != null
          ? `${(route.distanceMeters / 1000).toFixed(1)} km`
          : "";
      const blob = await recordRouteAnimation(coords, {
        distanceLabel,
        title: "PaceCasso",
      });
      if (!blob) {
        setAnimError(
          "Your browser doesn't support canvas video recording. Try Chrome, Edge, or Firefox.",
        );
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "pacecasso-route.webm";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[Step5] recordRouteAnimation failed:", err);
      setAnimError("Couldn't record animation — try again.");
    } finally {
      setAnimBusy(false);
    }
  }, [routeLine, route.distanceMeters]);

  const distanceKm =
    route.distanceMeters != null
      ? (route.distanceMeters / 1000).toFixed(2)
      : null;
  const waypointCount = route.blockWaypoints?.length ?? 0;
  const pathVertices = routeLine.length;

  const shareBlurb = useMemo(() => {
    const base = getSiteUrl();
    const kmBit =
      distanceKm != null ? `${distanceKm} km` : "a route";
    const handle = getShareTwitterHandle();
    return `I designed a ${kmBit} street route with PaceCasso — turn your city into art. Try it: ${base}/create\n\n@${handle}`;
  }, [distanceKm]);

  const copyShareBlurb = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareBlurb);
      setShareHint("Copied!");
      window.setTimeout(() => setShareHint(null), 2200);
    } catch {
      setShareHint("Couldn’t copy — select and copy manually.");
      window.setTimeout(() => setShareHint(null), 3500);
    }
  }, [shareBlurb]);

  const nativeShare = useCallback(async () => {
    if (!navigator.share) return;
    try {
      await navigator.share({
        title: "PaceCasso",
        text: shareBlurb,
        url: `${getSiteUrl()}/create`,
      });
    } catch {
      /* user dismissed or cancelled */
    }
  }, [shareBlurb]);

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-14rem)] w-full max-w-6xl flex-col">
      <div className="border-b border-pace-yellow bg-pace-white px-[clamp(1rem,4vw,2rem)] py-2.5 sm:py-3">
        <div className="pace-highlight max-w-3xl py-0.5">
          <div className="pace-section-label mb-0 text-xs tracking-[0.18em] sm:text-[0.85rem]">
            Finish line
          </div>
          <h2 className="font-pace-heading text-lg uppercase leading-tight tracking-wide text-pace-blue sm:text-xl">
            Route ready — preview & export
          </h2>
          <p className="font-dm mt-1 max-w-2xl text-xs leading-snug text-pace-muted sm:text-[13px]">
            Your route is ready. Download it for your watch, share a preview,
            or keep tweaking.
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-[clamp(1rem,4vw,2rem)] py-3 sm:py-4 lg:flex-row lg:gap-6">
        <div className="flex w-full shrink-0 flex-col gap-3 lg:max-w-sm">
          <div className="pace-card-editorial p-4 sm:p-5">
            <dl className="font-dm space-y-3 text-sm">
              <div className="flex justify-between gap-6 border-b border-pace-line pb-3">
                <dt className="font-bebas text-xs tracking-[0.1em] text-pace-muted">
                  Distance
                </dt>
                <dd className="font-bold tabular-nums text-pace-ink">
                  {distanceKm != null ? `${distanceKm} km` : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-6 border-b border-pace-line pb-3">
                <dt className="font-bebas text-xs tracking-[0.1em] text-pace-muted">
                  Waypoints
                </dt>
                <dd className="font-bold tabular-nums text-pace-ink">
                  {waypointCount > 0 ? waypointCount : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-6">
                <dt className="font-bebas text-xs tracking-[0.1em] text-pace-muted">
                  Vertices
                </dt>
                <dd className="font-bold tabular-nums text-pace-ink">
                  {pathVertices}
                </dd>
              </div>
            </dl>

            <div className="mt-5 flex flex-col gap-2 border-t border-pace-line pt-5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bebas text-[11px] tracking-[0.12em] text-pace-muted">
                  Turn-by-turn
                </span>
                {cuesLoading ? (
                  <span
                    className="text-[11px] font-medium text-pace-blue"
                    role="status"
                    aria-live="polite"
                  >
                    Building turn-by-turn cues…
                  </span>
                ) : turnCues.length > 0 ? (
                  <span className="text-[11px] font-medium tabular-nums text-pace-muted">
                    {turnCues.length} steps
                  </span>
                ) : cuesError ? (
                  <button
                    type="button"
                    onClick={retryCues}
                    className="min-h-[28px] rounded border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 transition hover:border-red-400 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                    title={cuesError}
                    aria-label={`Cues failed to load: ${cuesError}. Retry.`}
                  >
                    ↻ Retry cues
                  </button>
                ) : null}
              </div>
              {cuesError ? (
                <p
                  className="text-[11px] leading-snug text-red-600"
                  role="alert"
                  aria-live="assertive"
                >
                  Couldn&apos;t load turn-by-turn cues — {cuesError}. The route
                  line itself is fine; export GPX or tap{" "}
                  <strong>↻ Retry cues</strong>.
                </p>
              ) : null}
              {turnCues.length > 0 ? (
                <ol className="max-h-40 list-decimal space-y-1.5 overflow-y-auto pl-4 text-[11px] text-pace-muted">
                  {turnCues.map((c, i) => (
                    <li key={`${c.lat.toFixed(5)}-${c.lng.toFixed(5)}-${i}`}>
                      <span className="font-medium text-pace-ink">
                        {c.instruction}
                      </span>
                      {c.street &&
                      shouldAppendStreetLabel(c.instruction, c.street) ? (
                        <span className="text-pace-muted"> — {c.street}</span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : !cuesLoading && !cuesError && pathVertices >= 2 ? (
                <p className="text-[11px] text-pace-muted">
                  No cues returned — check connection or try again.
                </p>
              ) : null}

              <span className="mt-2 font-bebas text-[11px] tracking-[0.12em] text-pace-muted">
                Export
              </span>
              <div className="flex flex-col gap-2">
                {/* GPX is the hero: 90 %+ of users are sending this to a
                    watch. Full-width primary button + clear subtitle removes
                    the "which file do I use" guessing. */}
                <button
                  type="button"
                  onClick={downloadGpx}
                  disabled={pathVertices < 2}
                  className="pace-toolbar-btn-primary flex flex-col items-start gap-0.5 px-3 py-2.5 text-left disabled:opacity-40"
                  aria-label="Download GPX for your watch (Garmin, Coros, Apple Watch, Suunto)"
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="font-bebas text-sm tracking-[0.08em]">
                      GPX — for your watch
                    </span>
                    <span className="font-bebas text-[10px] tracking-[0.14em] text-pace-ink/70">
                      .gpx
                    </span>
                  </span>
                  <span className="font-dm text-[11px] font-normal leading-snug text-pace-ink/75">
                    Garmin · Coros · Apple Watch · Suunto · most Strava imports
                  </span>
                </button>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={downloadGeoJSON}
                    disabled={pathVertices < 2}
                    className="pace-toolbar-btn flex flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left disabled:opacity-40"
                    aria-label="Download GeoJSON for maps and analysis tools"
                  >
                    <span className="font-bebas text-[12px] tracking-[0.08em]">
                      GeoJSON
                    </span>
                    <span className="font-dm text-[10px] font-normal leading-snug text-pace-muted">
                      Google My Maps, Mapbox, GIS tools
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={downloadCueSheet}
                    disabled={turnCues.length === 0}
                    className="pace-toolbar-btn flex flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left disabled:opacity-40"
                    aria-label="Download turn-by-turn cue sheet as plain text"
                  >
                    <span className="font-bebas text-[12px] tracking-[0.08em]">
                      Cues (.txt)
                    </span>
                    <span className="font-dm text-[10px] font-normal leading-snug text-pace-muted">
                      Printable turn list
                    </span>
                  </button>
                </div>
                {animSupported && (
                  <button
                    type="button"
                    onClick={() => void downloadAnimation()}
                    disabled={animBusy || pathVertices < 2}
                    className="pace-toolbar-btn flex flex-col items-start gap-0.5 px-3 py-2 text-left disabled:opacity-40"
                    aria-label="Download an animated video of the route drawing itself"
                    title="Download a ~4-second animation of the route drawing itself — great for social."
                  >
                    <span className="font-bebas text-[12px] tracking-[0.08em]">
                      {animBusy ? "Recording…" : "Animation (.webm)"}
                    </span>
                    <span className="font-dm text-[10px] font-normal leading-snug text-pace-muted">
                      4-second video — great for Instagram / Strava social
                    </span>
                  </button>
                )}
              </div>
              {animError && (
                <p className="text-[11px] leading-snug text-red-600">
                  {animError}
                </p>
              )}

              <span className="mt-4 font-bebas text-[11px] tracking-[0.12em] text-pace-muted">
                Share
              </span>
              <p className="text-[11px] leading-snug text-pace-muted">
                Copy a short blurb for social — your route stays on your device;
                this only shares text and a link to PaceCasso.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copyShareBlurb}
                  className="pace-toolbar-btn-primary px-3 py-2"
                >
                  Copy share text
                </button>
                {canNativeShare ? (
                  <button
                    type="button"
                    onClick={nativeShare}
                    className="pace-toolbar-btn px-3 py-2"
                  >
                    Share…
                  </button>
                ) : null}
              </div>
              {shareHint ? (
                <p
                  className="text-[11px] font-medium text-pace-blue"
                  role="status"
                  aria-live="polite"
                >
                  {shareHint}
                </p>
              ) : null}

              <div className="mt-4 rounded-lg border border-pace-line bg-pace-panel/80 p-3">
                <h3 className="font-bebas text-[11px] tracking-[0.12em] text-pace-yellow">
                  Get this route on your watch
                </h3>
                <ul className="font-dm mt-2 list-disc space-y-1.5 pl-4 text-[11px] leading-relaxed text-pace-muted">
                  <li>
                    Tap <strong className="text-pace-ink">GPX</strong> — the file
                    downloads to your computer or phone. PaceCasso does not upload
                    your route to our servers.
                  </li>
                  <li>
                    In your watch maker&apos;s app or site (e.g. Garmin
                    Connect, Coros, Suunto), use{" "}
                    <strong className="text-pace-ink">import course</strong>,{" "}
                    <strong className="text-pace-ink">import route</strong>, or{" "}
                    <strong className="text-pace-ink">add from file</strong> —
                    labels differ by brand.
                  </li>
                  <li>
                    Sync to the watch, start an{" "}
                    <strong className="text-pace-ink">outdoor</strong> run or
                    walk, and follow the course on the map screen.
                  </li>
                  <li>
                    If turns don&apos;t show on-wrist, use{" "}
                    <strong className="text-pace-ink">Cues (.txt)</strong> on your
                    phone, or open the GPX in another app that reads waypoints.
                  </li>
                </ul>
              </div>
            </div>

            {showArtControls && hasArt ? (
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-pace-line pt-4">
                <span className="font-bebas text-[11px] tracking-[0.12em] text-pace-muted">
                  Show art on map
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showArtOnMap}
                  aria-label="Show original art on preview map"
                  onClick={() => setShowArtOnMap((v) => !v)}
                  className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                    showArtOnMap ? "bg-emerald-500" : "bg-pace-line"
                  }`}
                >
                  <span
                    className={`absolute top-1 left-1 block h-5 w-5 rounded-full bg-pace-white shadow transition-transform ${
                      showArtOnMap ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            ) : null}

            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={onBackToFineTune}
                className="pace-btn-ghost pace-btn-ghost--sm"
              >
                ← Tune again
              </button>
              <button
                type="button"
                onClick={onStartOver}
                className="pace-btn-primary pace-btn-primary--sm"
              >
                New route
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-[min(520px,58vh)] flex-1 lg:min-h-[calc(100dvh-12rem)]">
          {pathVertices >= 2 || (showArtControls && showArtOnMap && hasArt) ? (
            <Step5PreviewMap
              routeLine={routeLine}
              originalArt={originalArt}
              showOriginalArt={showArtControls && showArtOnMap && hasArt}
            />
          ) : (
            <div className="flex h-full min-h-[280px] items-center justify-center rounded-xl border border-dashed border-pace-line bg-pace-panel text-sm text-pace-muted">
              Nothing to preview yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
