"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { LatLngExpression } from "leaflet";
import L from "leaflet";
import { NormalizedPoint } from "./Step1ImageUpload";
import { autoFindTop5, type Top5Pick } from "../lib/autoFindTop5";
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
import { matchVerifiedBankRun } from "../lib/refusalOfframp";
import type { CuratedRun } from "../lib/curatedManhattanRuns";
import { useLeafletContainerId } from "../lib/useLeafletContainerId";
import type { RouteLineString } from "../lib/routeTypes";
import { renderRouteToDataUrl } from "../lib/renderRouteImage";
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
  /** Blind-verified subject from the AI redraw step, if the sketch came from it. */
  interpretedSubject?: string | null;
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

function cleanLatLngArray(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (p): p is [number, number] =>
        Array.isArray(p) &&
        typeof p[0] === "number" &&
        Number.isFinite(p[0]) &&
        typeof p[1] === "number" &&
        Number.isFinite(p[1]),
    )
    .map(([lat, lng]) => [lat, lng]);
}

type WowPlacePickPayload = {
  center: [number, number];
  rotDeg: number;
  extentM: number;
  km: number;
  dev: number;
  primed: number;
  /** Present when a zero-context judge named this route 3/3 before display. */
  blindGuess?: string;
  /** True when strict judging failed but the server returned the best runnable route. */
  fallbackDraft?: boolean;
  fallbackReason?: string;
  coordinates: [number, number][];
  anchorLatLngs: [number, number][];
  previewPngBase64: string;
};

function cleanWowPick(value: unknown): WowPlacePickPayload | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const coordinates = cleanLatLngArray(rec.coordinates);
  const anchorLatLngs = cleanLatLngArray(rec.anchorLatLngs);
  const center = cleanLatLngArray([rec.center])[0];
  if (coordinates.length < 2 || anchorLatLngs.length < 2 || !center) return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const rotDeg = num(rec.rotDeg);
  const extentM = num(rec.extentM);
  const km = num(rec.km);
  const dev = num(rec.dev);
  const primed = num(rec.primed);
  if (rotDeg == null || extentM == null || km == null || dev == null || primed == null) return null;
  if (typeof rec.previewPngBase64 !== "string" || !rec.previewPngBase64) return null;
  return {
    center,
    rotDeg,
    extentM,
    km,
    dev,
    primed,
    blindGuess:
      typeof rec.blindGuess === "string" && rec.blindGuess ? rec.blindGuess : undefined,
    fallbackDraft: rec.fallbackDraft === true,
    fallbackReason:
      typeof rec.fallbackReason === "string" && rec.fallbackReason
        ? rec.fallbackReason
        : undefined,
    coordinates,
    anchorLatLngs,
    previewPngBase64: rec.previewPngBase64,
  };
}

type WowPlaceResultPayload = {
  picks: WowPlacePickPayload[];
  subject: string | null;
  message?: string;
};

type ArtistLoopResultPayload = {
  label: string;
  description: string;
  sketchLatLngs: [number, number][];
  chain: [number, number][];
  distanceMeters: number;
  center: [number, number];
  meanDeviationMeters: number;
  recognizedCount: number;
  medianConfidence: number;
  guesses: string[];
  roundsRun: number;
};

async function readNdjsonResult(
  res: Response,
  onProgress: (detail: string) => void,
): Promise<Record<string, unknown>> {
  if (!res.ok) {
    let message = `Route search failed (${res.status}).`;
    try {
      const payload = (await res.json()) as { error?: unknown };
      if (typeof payload.error === "string") message = payload.error;
    } catch {
      /* keep status message */
    }
    throw new Error(message);
  }
  if (!res.body) throw new Error("Route search returned no progress stream.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Ref object (not a plain let) — TS control flow can't see closure writes.
  const resultRef: { current: Record<string, unknown> | null } = { current: null };
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const payload = JSON.parse(line) as Record<string, unknown>;
    if (payload.type === "progress") {
      if (typeof payload.detail === "string") onProgress(payload.detail);
      return;
    }
    if (payload.type === "error") {
      throw new Error(
        typeof payload.message === "string" ? payload.message : "Route search failed.",
      );
    }
    if (payload.type === "result" && payload.result && typeof payload.result === "object") {
      resultRef.current = payload.result as Record<string, unknown>;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }
    if (done) break;
  }
  if (buffer.trim()) consumeLine(buffer);
  if (!resultRef.current) throw new Error("Route search did not return a result.");
  return resultRef.current;
}

// One record: the state of the latest find-my-route search. Written on
// every stage change, read on mount to surface interrupted searches.
const SEARCH_STATE_KEY = "pacecasso.step2.searchState.v1";

async function fetchWowPlace(
  body: Record<string, unknown>,
  onProgress: (detail: string) => void,
): Promise<WowPlaceResultPayload> {
  const res = await fetch("/api/wow-place", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const rec = await readNdjsonResult(res, onProgress);
  return {
    picks: Array.isArray(rec.picks)
      ? rec.picks.map(cleanWowPick).filter((p): p is WowPlacePickPayload => p !== null)
      : [],
    subject: typeof rec.subject === "string" ? rec.subject : null,
    message: typeof rec.message === "string" ? rec.message : undefined,
  };
}

function cleanArtistLoopResult(rec: Record<string, unknown>): ArtistLoopResultPayload | null {
  const sketchLatLngs = cleanLatLngArray(rec.sketchLatLngs);
  const chain = cleanLatLngArray(rec.chain);
  const center = cleanLatLngArray([rec.center])[0];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const distanceMeters = num(rec.distanceMeters);
  const meanDeviationMeters = num(rec.meanDeviationMeters);
  const recognizedCount = num(rec.recognizedCount);
  const medianConfidence = num(rec.medianConfidence);
  const roundsRun = num(rec.roundsRun);
  if (
    sketchLatLngs.length < 2 ||
    chain.length < 2 ||
    !center ||
    distanceMeters == null ||
    meanDeviationMeters == null ||
    recognizedCount == null ||
    medianConfidence == null ||
    roundsRun == null
  ) {
    return null;
  }
  return {
    label: typeof rec.label === "string" && rec.label ? rec.label : "street-ready design",
    description:
      typeof rec.description === "string" && rec.description
        ? rec.description
        : "Design-first street route",
    sketchLatLngs,
    chain,
    distanceMeters,
    center,
    meanDeviationMeters,
    recognizedCount,
    medianConfidence,
    guesses: Array.isArray(rec.guesses)
      ? rec.guesses.filter((g): g is string => typeof g === "string" && !!g)
      : [],
    roundsRun,
  };
}

async function fetchArtistLoop(
  body: Record<string, unknown>,
  onProgress: (detail: string) => void,
): Promise<ArtistLoopResultPayload | null> {
  const res = await fetch("/api/artist-loop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const rec = await readNdjsonResult(res, onProgress);
  return cleanArtistLoopResult(rec);
}

type StudioRoutePayload = {
  ok: boolean;
  verified?: boolean;
  subject?: string;
  chain?: [number, number][];
  km?: number;
  visualScore?: number;
  verdicts?: { guess: string; confidence: number }[];
};

async function fetchStudioRoute(
  body: Record<string, unknown>,
  onProgress: (detail: string) => void,
): Promise<StudioRoutePayload | null> {
  // Never let this stage stall the cascade: the server budgets itself to
  // ~200 s and streams progress; if neither a result nor the stream's end
  // arrives by 270 s something is wedged — abort and fall through.
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), 270_000);
  try {
    onProgress("Tracing your shape onto real streets… (usually 1–3 minutes)");
    const res = await fetch("/api/studio-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("Content-Type") ?? "";
    if (!contentType.includes("ndjson")) {
      // non-stream replies (manhattan-only, validation) are plain JSON
      const rec = (await res.json()) as StudioRoutePayload;
      return rec && typeof rec === "object" ? rec : null;
    }
    const result = await readNdjsonResult(res, onProgress);
    return result as StudioRoutePayload;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

// ---- async job lane (server-side search; survives closed tabs) -----------
const NOTIFY_EMAIL_KEY = "pacecasso.notifyEmail";
const ACTIVE_JOB_KEY = "pacecasso.activeRouteJob.v1";

type RouteJobStatusPayload = {
  jobId?: string;
  status?: string;
  stage?: string;
  stageNote?: string;
  result?: {
    kind?: string;
    studio?: StudioRoutePayload;
    wow?: { picks?: unknown[]; subject?: unknown; message?: unknown };
    redrawn?: boolean;
    composite?: boolean;
    artist?: Record<string, unknown>;
    message?: string;
  } | null;
  error?: string | null;
};

function searchRunningLine(email: string | null): string {
  return email
    ? `Your route search is running on our servers — we'll email ${email} when it's found. You can close this page.`
    : "Your route search is running on our servers — you can close this page and come back; the result will be waiting here.";
}

async function createRouteJob(
  body: Record<string, unknown>,
): Promise<{ jobId: string } | "unavailable" | null> {
  try {
    const res = await fetch("/api/route-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 503) return "unavailable";
    if (!res.ok) return null;
    const rec = (await res.json()) as { jobId?: unknown };
    return typeof rec.jobId === "string" && rec.jobId ? { jobId: rec.jobId } : null;
  } catch {
    return null;
  }
}

async function fetchRouteJobStatus(jobId: string): Promise<RouteJobStatusPayload | null> {
  try {
    const res = await fetch(`/api/route-job?id=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });
    if (res.status === 404) return { status: "gone" };
    if (!res.ok) return null;
    return (await res.json()) as RouteJobStatusPayload;
  } catch {
    return null;
  }
}

async function fetchInterpret(
  imageBase64: string,
  onProgress: (detail: string) => void,
): Promise<{
  contour: NormalizedPoint[] | null;
  subject: string | null;
  /** true when the redraw is the whole multi-element composition (logo) —
   * placement must then judge by likeness to the upload, not the subject */
  composite: boolean;
  message?: string;
}> {
  const res = await fetch("/api/interpret-sketch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64 }),
  });
  const rec = await readNdjsonResult(res, onProgress);
  const contour = Array.isArray(rec.contour)
    ? (rec.contour as { x?: unknown; y?: unknown }[]).filter(
        (p): p is NormalizedPoint =>
          !!p &&
          typeof p.x === "number" &&
          Number.isFinite(p.x) &&
          typeof p.y === "number" &&
          Number.isFinite(p.y),
      )
    : null;
  return {
    contour: contour && contour.length >= 8 ? contour : null,
    subject: typeof rec.subject === "string" ? rec.subject : null,
    composite: rec.composite === true,
    message: typeof rec.message === "string" ? rec.message : undefined,
  };
}

export default function Step2MapAnchor({
  contour,
  cityPreset,
  defaultCenter = MANHATTAN_PRESET.defaultCenter,
  imageBase64,
  imageSourceName,
  interpretedSubject,
  onBack,
  onComplete,
}: Step2MapAnchorProps) {
  const [rotationDeg, setRotationDeg] = useState(0);
  const [scale, setScale] = useState(1);
  const [center, setCenter] = useState<[number, number]>(defaultCenter);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoHint, setAutoHint] = useState<string | null>(null);
  // A failure arms a delayed hint-clear; if the user re-runs within that
  // window the stale timer would wipe the NEW run's message mid-flight.
  const hintTimerRef = useRef<number | null>(null);
  const armHintClear = useCallback((ms: number) => {
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => setAutoHint(null), ms);
  }, []);
  useEffect(
    () => () => {
      if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    },
    [],
  );
  const leafletId = useLeafletContainerId();
  const [picks, setPicks] = useState<Top5Pick[]>([]);
  const [picksVisionUsed, setPicksVisionUsed] = useState(false);
  /**
   * Refusal offramp: set only when the find-my-route cascade ends in an
   * honest refusal. `offrampRun` is the closest blind-verified bank route
   * (by subject-feature match) to OFFER — clearly labeled, never swapped in
   * for the user's own art.
   */
  const [showOfframp, setShowOfframp] = useState(false);
  const [offrampRun, setOfframpRun] = useState<CuratedRun | null>(null);
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

  /**
   * A route search runs for minutes — long enough for the user to walk
   * away, the laptop to sleep, or the browser to discard the tab. The
   * outcome must survive all of that: every stage is mirrored to
   * localStorage, so an interrupted or failed search greets the returning
   * user with WHAT happened and WHERE, never a silently reset button.
   */
  const lastStageRef = useRef<string>("starting");
  const noteStage = useCallback((detail: string) => {
    lastStageRef.current = detail;
    setAutoHint(detail);
    try {
      window.localStorage.setItem(
        SEARCH_STATE_KEY,
        JSON.stringify({ status: "running", stage: detail, at: Date.now() }),
      );
    } catch {
      /* storage unavailable — hint alone still works */
    }
  }, []);
  const recordSearchEnd = useCallback(
    (status: "done" | "stopped" | "no-route", message?: string) => {
      try {
        window.localStorage.setItem(
          SEARCH_STATE_KEY,
          JSON.stringify({ status, stage: lastStageRef.current, message, at: Date.now() }),
        );
      } catch {
        /* storage unavailable */
      }
    },
    [],
  );
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SEARCH_STATE_KEY);
      if (!raw) return;
      const rec = JSON.parse(raw) as {
        status?: string;
        stage?: string;
        message?: string;
      };
      if (rec.status === "running") {
        // still marked running on a fresh mount = the tab reloaded or was
        // discarded mid-search; the search itself is gone.
        window.localStorage.removeItem(SEARCH_STATE_KEY);
        setAutoHint(
          `Your last route search was interrupted mid-way, during: "${rec.stage ?? "searching"}". ` +
            "The search runs in this tab, so it needs the tab open and the computer awake. " +
            "Press Find my route to run it again.",
        );
      } else if ((rec.status === "stopped" || rec.status === "no-route") && rec.message) {
        window.localStorage.removeItem(SEARCH_STATE_KEY);
        setAutoHint(rec.message);
      } else {
        window.localStorage.removeItem(SEARCH_STATE_KEY);
      }
    } catch {
      /* unreadable state — ignore */
    }
  }, []);

  /**
   * ONE button, the whole funnel (Ralph, July 28: "multiple options that
   * all fail is terrible"). Cascade: try the art exactly as drawn ->
   * verified street placement; if the judge refuses and we have the
   * original image, redraw it street-ready automatically and place that.
   * Ends in verified picks or ONE honest final answer — never a menu of
   * dead ends.
   */
const applyResult = useCallback((result: WowPlaceResultPayload, redrawn: boolean, likenessJudged = false) => {
    const subjectLabel = result.subject ?? "your art";
    const mapped: Top5Pick[] = result.picks.map((p) => ({
      placement: {
        center: p.center,
        rotationDeg: p.rotDeg,
        scale: p.extentM / 2000,
      },
      anchorLatLngs: p.anchorLatLngs,
      routeCoords: p.coordinates,
      snappedRoute: {
        coordinates: p.coordinates,
        distanceMeters: Math.round(p.km * 1000),
        blockWaypoints: p.coordinates,
        preserveBlockWaypoints: true,
      },
      previewDataUrl: `data:image/png;base64,${p.previewPngBase64}`,
      distanceKm: p.km,
      qualityScore: Math.min(100, p.primed * 10),
      shapeMatchScore: Math.max(1, Math.min(100, Math.round(100 - p.dev))),
      sourceMatchScore: Math.min(100, p.primed * 10),
      verifiedRoute: !p.fallbackDraft,
      verificationLabel: p.fallbackDraft
        ? "BEST RUNNABLE DRAFT"
        : p.blindGuess
          ? "BLIND-VERIFIED 3/3"
          : `AI JUDGE ${p.primed}/10`,
      reason: p.fallbackDraft
        ? `${p.fallbackReason ?? "Strict judging did not pass."} This is the best real-street draft we found, so you can inspect and edit it instead of getting a dead end.`
        : p.blindGuess
          ? `A judge shown this route with zero context named it "${p.blindGuess}" three times out of three.`
          : likenessJudged
            ? `A vision judge compared this street route against your original image and scored the likeness ${p.primed}/10 before we showed it to you.`
            : `A vision judge, told only "${subjectLabel}", scored this street route ${p.primed}/10 before we showed it to you.`,
    }));
    setPicks(mapped);
    setPicksVisionUsed(true);
    const first = mapped[0]!;
    setCenter([...first.placement.center] as [number, number]);
    setRotationDeg(first.placement.rotationDeg);
    setScale(first.placement.scale);
    setSelectedPickIdx(0);
    setPreferredSnappedRoute(routeFromPick(first));
    setSelectedAnchorLatLngs(first.anchorLatLngs ?? null);
    setFitNonce((n) => n + 1);
    const hasFallbackDraft = result.picks.some((p) => p.fallbackDraft);
    setAutoHint(
      hasFallbackDraft
        ? `We read your art as ${subjectLabel}. No strict route passed, so here is the best runnable street draft to inspect and edit.`
        : redrawn
          ? `Your art as-drawn didn't survive the streets, so we redrew it as ${subjectLabel} - ${mapped.length} judge-checked placements. Tap one to try it.`
          : `We read your art as ${subjectLabel} - here are ${mapped.length} judge-checked placements. Tap one to try it.`,
    );
    window.setTimeout(() => {
      document
        .getElementById("step2-picks")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }, [routeFromPick]);

const applyArtistLoopResult = useCallback((result: ArtistLoopResultPayload) => {
    const recognizedPct = Math.round((Math.min(3, Math.max(0, result.recognizedCount)) / 3) * 100);
    const confidencePct = Math.round(Math.min(1, Math.max(0, result.medianConfidence)) * 100);
    const routeCleanPct = Math.max(45, Math.min(95, Math.round(100 - result.meanDeviationMeters * 2)));
    const guessText = result.guesses.length ? ` Judges guessed: ${result.guesses.join(", ")}.` : "";
    const pick: Top5Pick = {
      placement: {
        center: result.center,
        rotationDeg: 0,
        scale: 1,
      },
      anchorLatLngs: result.sketchLatLngs,
      designIntent: result.description,
      routeCoords: result.chain,
      snappedRoute: {
        coordinates: result.chain,
        distanceMeters: Math.round(result.distanceMeters),
        blockWaypoints: result.chain,
        preserveBlockWaypoints: true,
      },
      previewDataUrl: renderRouteToDataUrl(result.chain, 640, { padding: 96 }) ?? "",
      distanceKm: result.distanceMeters / 1000,
      qualityScore: routeCleanPct,
      shapeMatchScore: Math.max(55, Math.min(95, Math.round((recognizedPct + confidencePct) / 2))),
      sourceMatchScore: Math.max(45, Math.min(95, Math.round((recognizedPct * 0.7) + (confidencePct * 0.3)))),
      verifiedRoute: result.recognizedCount >= 2,
      verificationLabel: `ARTIST LOOP ${result.recognizedCount}/3`,
      reason:
        `${result.label}: design-first street route compiled on real Manhattan streets after ${result.roundsRun} round${result.roundsRun === 1 ? "" : "s"}. ` +
        `${result.recognizedCount}/3 blind judges recognized it.${guessText}`,
    };
    setPicks([pick]);
    setPicksVisionUsed(true);
    setCenter([...pick.placement.center] as [number, number]);
    setRotationDeg(pick.placement.rotationDeg);
    setScale(pick.placement.scale);
    setSelectedPickIdx(0);
    setPreferredSnappedRoute(routeFromPick(pick));
    setSelectedAnchorLatLngs(pick.anchorLatLngs ?? null);
    setFitNonce((n) => n + 1);
    setAutoHint(
      result.recognizedCount >= 2
        ? `Design-first route found: ${result.recognizedCount}/3 blind judges recognized it. Tap it to inspect, then continue.`
        : `Design-first route found, but only ${result.recognizedCount}/3 blind judges recognized it. Showing the best real-street draft instead of failing.`,
    );
    window.setTimeout(() => {
      document
        .getElementById("step2-picks")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return result.recognizedCount >= 2;
  }, [routeFromPick]);

const applyStudioResult = useCallback((result: StudioRoutePayload) => {
    const chain = result.chain ?? [];
    if (chain.length < 8) return false;
    const distanceMeters = Math.round((result.km ?? 0) * 1000);
    const lat = chain.reduce((a, p) => a + p[0], 0) / chain.length;
    const lng = chain.reduce((a, p) => a + p[1], 0) / chain.length;
    const guessText = result.verdicts?.length
      ? ` Judges guessed: ${result.verdicts.map((v) => v.guess).join(", ")}.`
      : "";
    const pick: Top5Pick = {
      placement: { center: [lat, lng], rotationDeg: 0, scale: 1 },
      anchorLatLngs: chain,
      designIntent: result.subject ?? "your art, traced on real streets",
      routeCoords: chain,
      snappedRoute: {
        coordinates: chain,
        distanceMeters,
        blockWaypoints: chain,
        preserveBlockWaypoints: true,
      },
      previewDataUrl: renderRouteToDataUrl(chain, 640, { padding: 96 }) ?? "",
      distanceKm: result.km ?? distanceMeters / 1000,
      qualityScore: 90,
      shapeMatchScore: 90,
      sourceMatchScore: 85,
      verifiedRoute: true,
      verificationLabel: "STUDIO 2/2",
      reason:
        `Studio lane: your shape traced directly on real streets at hero scale. ` +
        `Both blind judges named it "${result.subject ?? "your subject"}" with zero context.${guessText}`,
    };
    setPicks([pick]);
    setPicksVisionUsed(true);
    setCenter([...pick.placement.center] as [number, number]);
    setRotationDeg(0);
    setScale(1);
    setSelectedPickIdx(0);
    setPreferredSnappedRoute(routeFromPick(pick));
    setSelectedAnchorLatLngs(pick.anchorLatLngs ?? null);
    setFitNonce((n) => n + 1);
    setAutoHint(
      `Studio route found: 2/2 blind judges recognized it as "${result.subject}". Tap it to inspect, then continue.`,
    );
    window.setTimeout(() => {
      document
        .getElementById("step2-picks")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return true;
  }, [routeFromPick]);

  // ---- async job lane state ----------------------------------------------
  const [notifyEmail, setNotifyEmail] = useState("");
  useEffect(() => {
    try {
      setNotifyEmail(window.localStorage.getItem(NOTIFY_EMAIL_KEY) ?? "");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const jobPollRef = useRef<number | null>(null);
  const stopJobWatch = useCallback(() => {
    if (jobPollRef.current !== null) {
      window.clearInterval(jobPollRef.current);
      jobPollRef.current = null;
    }
  }, []);
  useEffect(() => stopJobWatch, [stopJobWatch]);

  const applyJobResult = useCallback(
    (payload: RouteJobStatusPayload): void => {
      // Keep the job pointer on success (marked done) so a reload or a
      // return visit re-applies the finished result — with async search,
      // coming back later IS the normal flow. Only dead ends clear it.
      const keepPointer = () => {
        try {
          const raw = window.localStorage.getItem(ACTIVE_JOB_KEY);
          const rec = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          window.localStorage.setItem(
            ACTIVE_JOB_KEY,
            JSON.stringify({ ...rec, jobId: payload.jobId, done: true }),
          );
        } catch {
          /* storage unavailable */
        }
      };
      const dropPointer = () => {
        try {
          window.localStorage.removeItem(ACTIVE_JOB_KEY);
        } catch {
          /* storage unavailable */
        }
      };
      const r = payload.result;
      if (!r) {
        dropPointer();
        setAutoHint(
          payload.error
            ? `Route search failed: ${payload.error}`
            : "Route search finished without a result — press Find my route to run it again.",
        );
        return;
      }
      if (r.kind === "studio" && r.studio && applyStudioResult(r.studio)) {
        keepPointer();
        recordSearchEnd("done");
        return;
      }
      if (r.kind === "wow" && r.wow) {
        const picks = Array.isArray(r.wow.picks)
          ? r.wow.picks.map(cleanWowPick).filter((p): p is WowPlacePickPayload => p !== null)
          : [];
        if (picks.length) {
          applyResult(
            {
              picks,
              subject: typeof r.wow.subject === "string" ? r.wow.subject : null,
              message: typeof r.wow.message === "string" ? r.wow.message : undefined,
            },
            r.redrawn === true,
            r.composite === true,
          );
          keepPointer();
          recordSearchEnd("done");
          return;
        }
      }
      if (r.kind === "artist" && r.artist) {
        const artist = cleanArtistLoopResult(r.artist);
        if (artist) {
          applyArtistLoopResult(artist);
          keepPointer();
          recordSearchEnd("done");
          return;
        }
      }
      dropPointer();
      const message =
        r.kind === "none" && typeof r.message === "string" && r.message
          ? `${r.message} You can place it yourself: drag the art where you want it and continue.`
          : "The search finished but its result could not be loaded — press Find my route to run it again.";
      setAutoHint(message);
      recordSearchEnd("no-route", message);
      setShowOfframp(true);
    },
    [applyStudioResult, applyResult, applyArtistLoopResult, recordSearchEnd],
  );

  const watchRouteJob = useCallback(
    (jobId: string, email: string | null) => {
      stopJobWatch();
      const poll = async () => {
        const payload = await fetchRouteJobStatus(jobId);
        if (!payload) return; // transient network blip — next tick retries
        if (payload.status === "gone") {
          stopJobWatch();
          try {
            window.localStorage.removeItem(ACTIVE_JOB_KEY);
          } catch {
            /* storage unavailable */
          }
          return;
        }
        if (payload.status === "done") {
          stopJobWatch();
          applyJobResult(payload);
          return;
        }
        if (payload.status === "failed") {
          stopJobWatch();
          try {
            window.localStorage.removeItem(ACTIVE_JOB_KEY);
          } catch {
            /* storage unavailable */
          }
          setAutoHint(
            `Route search failed: ${payload.error ?? "unknown error"}. Press Find my route to try again.`,
          );
          return;
        }
        if (typeof payload.stageNote === "string" && payload.stageNote) {
          setAutoHint(`${searchRunningLine(email)} Now: ${payload.stageNote}`);
        }
      };
      void poll();
      jobPollRef.current = window.setInterval(() => void poll(), 20_000);
    },
    [applyJobResult, stopJobWatch],
  );

  // Pick up a job from the email link (?job=) or a previous visit.
  useEffect(() => {
    let jobId: string | null = null;
    let email: string | null = null;
    try {
      const q = new URL(window.location.href).searchParams.get("job");
      if (q && /^[0-9a-f]{32}$/.test(q)) jobId = q;
      if (!jobId) {
        const raw = window.localStorage.getItem(ACTIVE_JOB_KEY);
        if (raw) {
          const rec = JSON.parse(raw) as { jobId?: string; email?: string | null };
          if (typeof rec.jobId === "string" && /^[0-9a-f]{32}$/.test(rec.jobId)) {
            jobId = rec.jobId;
            email = rec.email ?? null;
          }
        }
      }
    } catch {
      /* storage unavailable */
    }
    if (!jobId) return;
    setAutoHint("Checking on your route search…");
    watchRouteJob(jobId, email);
    // mount-only: the stored/linked job id cannot change after load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runWowFind = useCallback(async () => {
    if (cityPreset.id !== "manhattan") {
      setAutoHint("Route finding currently supports Manhattan only.");
      armHintClear(6000);
      return;
    }

    // Async lane: hand the search to the server so the user can close the
    // tab ("we'll email you"). Existing running job → re-attach instead of
    // double-submitting. Falls back to the live in-tab cascade only when
    // the job store is not configured.
    try {
      const raw = window.localStorage.getItem(ACTIVE_JOB_KEY);
      if (raw) {
        const rec = JSON.parse(raw) as { jobId?: string; email?: string | null };
        if (typeof rec.jobId === "string" && /^[0-9a-f]{32}$/.test(rec.jobId)) {
          const st = await fetchRouteJobStatus(rec.jobId);
          if (st && (st.status === "running" || st.status === "queued")) {
            setAutoHint(searchRunningLine(rec.email ?? null));
            watchRouteJob(rec.jobId, rec.email ?? null);
            return;
          }
        }
      }
    } catch {
      /* storage unavailable — proceed to a fresh submit */
    }
    {
      const email = notifyEmail.trim();
      try {
        window.localStorage.setItem(NOTIFY_EMAIL_KEY, email);
      } catch {
        /* storage unavailable */
      }
      setPicks([]);
      setShowOfframp(false);
      setOfframpRun(null);
      setSelectedPickIdx(null);
      setPreferredSnappedRoute(null);
      setSelectedAnchorLatLngs(null);
      setAutoHint("Handing your search to our servers…");
      const created = await createRouteJob({
        contour,
        cityId: cityPreset.id,
        cityLabel: cityPreset.label,
        subject: interpretedSubject ?? undefined,
        imageBase64: imageBase64 ?? undefined,
        sourceName: imageSourceName ?? undefined,
        email: email || undefined,
      });
      if (created && created !== "unavailable") {
        try {
          window.localStorage.setItem(
            ACTIVE_JOB_KEY,
            JSON.stringify({ jobId: created.jobId, email: email || null, at: Date.now() }),
          );
        } catch {
          /* storage unavailable */
        }
        setAutoHint(searchRunningLine(email || null));
        watchRouteJob(created.jobId, email || null);
        return;
      }
      // Store not configured (503) or submit failed — run the proven live
      // cascade in this tab instead.
    }
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    setAutoBusy(true);
    // Keep the machine awake for the duration — a multi-minute search dies
    // silently when the laptop sleeps. Released in finally; the browser
    // also auto-releases it if the tab is hidden.
    let wakeLock: WakeLockSentinel | null = null;
    try {
      wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* unsupported or denied — search still runs */
    }
    noteStage("Trying your art exactly as drawn…");
    setPicks([]);
    setShowOfframp(false);
    setOfframpRun(null);
    setSelectedPickIdx(null);
    setPreferredSnappedRoute(null);
    setSelectedAnchorLatLngs(null);
    window.setTimeout(() => {
      document
        .getElementById("step2-status")
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 80);

    const applyAutoFindResult = (result: Awaited<ReturnType<typeof autoFindTop5>>) => {
      if (!result.picks.length || result.relaxedQuality) return false;
      setPicks(result.picks);
      setPicksVisionUsed(result.visionUsed);
      const first = result.picks[0]!;
      setCenter([...first.placement.center] as [number, number]);
      setRotationDeg(first.placement.rotationDeg);
      setScale(first.placement.scale);
      setSelectedPickIdx(0);
      setPreferredSnappedRoute(routeFromPick(first));
      setSelectedAnchorLatLngs(first.anchorLatLngs ?? null);
      setFitNonce((n) => n + 1);
      const failures = result.snapFailures ? ` (${result.snapFailures} street-check retries failed)` : "";
      setAutoHint(
        result.relaxedQuality
          ? `Found ${result.picks.length} runnable route-native starter${result.picks.length === 1 ? "" : "s"}${failures}. Tap one to try it.`
          : `Found ${result.picks.length} route-native street fit${result.picks.length === 1 ? "" : "s"}${failures}. Tap one to try it.`,
      );
      window.setTimeout(() => {
        document
          .getElementById("step2-picks")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 120);
      return true;
    };

    try {
      // Stage 0: the studio lane — trace the approved shape directly on the
      // street graph at hero scale and blind-judge the rendered route. This
      // is the offline pipeline that produced the verified keeper batch;
      // only a fully verified result (both judges correct) is shown, and
      // anything else falls through to the normal cascade untouched.
      if (cityPreset.id === "manhattan") {
        const studio = await fetchStudioRoute(
          {
            contour,
            cityId: cityPreset.id,
            subject: interpretedSubject ?? undefined,
            imageBase64: !interpretedSubject && imageBase64 ? imageBase64 : undefined,
          },
          noteStage,
        );
        if (studio?.ok && studio.verified && applyStudioResult(studio)) {
          recordSearchEnd("done");
          return;
        }
      }

      // Stage 1: the user's art, exactly as approved. A stage that dies
      // (function limit, network) must fall through to the next stage -
      // Aug 30: a real upload ended the whole search at "24/100 areas".
      const stageFailed = (stage: string, err: unknown): string => {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(`[Step2] ${stage} failed, continuing:`, err);
        noteStage(`${stage} didn't finish (${detail}) - moving on to the next approach…`);
        return detail;
      };
      let literal: WowPlaceResultPayload;
      try {
        literal = await fetchWowPlace(
          {
            contour,
            cityId: cityPreset.id,
            subject: interpretedSubject ?? undefined,
          },
          noteStage,
        );
      } catch (err) {
        literal = { picks: [], subject: null, message: stageFailed("Placing your art as drawn", err) };
      }
      if (literal.picks.length) {
        applyResult(literal, false);
        recordSearchEnd("done");
        return;
      }

      // Stage 2: automatic street-ready redraw, then place that.
      if (!imageBase64) {
        const noRouteMessage =
          literal.message ??
          "Nothing cleared the judge's bar. Bold, simple shapes work best — or drag the art where you want it and continue; we'll fit it to the streets.";
        setAutoHint(noRouteMessage);
        recordSearchEnd("no-route", noRouteMessage);
        setShowOfframp(true);
        setOfframpRun(
          matchVerifiedBankRun([literal.subject, interpretedSubject, imageSourceName]),
        );
        return;
      }
      /**
       * Stage 2+: automatic redraw-and-place ROUNDS. Each interpret draws
       * fresh, so retrying genuinely explores new art — the old cascade ran
       * one round and told the user to press the button again ("a system
       * where an upload gets denied is not a system" — Ralph, Aug 10). The
       * system is now its own retry loop; the user only ever sees the final
       * outcome. Standards never drop: every round faces the same blind
       * acceptance gate.
       */
      // 8 rounds with a wall-clock budget: the offline recipe's wins took
      // up to ~12 rounds; each round is a fresh draw of the dice (tonight's
      // runs verified DIFFERENT subjects per run). The time budget keeps
      // the worst case bounded for the user — more rounds only while
      // they're fast.
      const MAX_REDRAW_ROUNDS = 8;
      const REDRAW_BUDGET_MS = 7 * 60_000;
      const cascadeStart = Date.now();
      let lastInterp: Awaited<ReturnType<typeof fetchInterpret>> | null = null;
      let lastPlaced: WowPlaceResultPayload | null = null;
      let roundsTried = 0;
      for (let round = 1; round <= MAX_REDRAW_ROUNDS; round++) {
        if (round > 1 && Date.now() - cascadeStart > REDRAW_BUDGET_MS) break;
        roundsTried = round;
        noteStage(
          round === 1
            ? "Your art as-drawn didn't pass the street judges — redrawing it street-ready…"
            : `Attempt ${round}: drawing a fresh street-ready version…`,
        );
        let interp: Awaited<ReturnType<typeof fetchInterpret>>;
        try {
          interp = await fetchInterpret(imageBase64, noteStage);
        } catch (err) {
          stageFailed(`Redraw attempt ${round}`, err);
          continue;
        }

        if (!interp.contour) {
          lastInterp = lastInterp ?? interp;
          continue;
        }
        lastInterp = interp;
        let placed: WowPlaceResultPayload;
        try {
          placed = await fetchWowPlace(
            {
              contour: interp.contour,
              cityId: cityPreset.id,
              subject: interp.subject ?? undefined,
              // Composite (multi-element logo) redraws: send the upload so
              // placement judges by likeness to it — the primed single-subject
              // question scores a full logo unfairly (measured 3/10 on a
              // pump+figure+hose route it was asked to read as one element).
              imageBase64: interp.composite ? imageBase64 : undefined,
            },
            noteStage,
          );
        } catch (err) {
          stageFailed(`Placing redraw ${round}`, err);
          continue;
        }
        lastPlaced = placed;
        if (placed.picks.length) {
          applyResult(placed, true, interp.composite);
          recordSearchEnd("done");
          return;
        }
      }
      if (imageBase64) {
        noteStage("Blind-verified placement did not pass - running the design-first street artist loop...");
        let artistRoute: ArtistLoopResultPayload | null = null;
        try {
          artistRoute = await fetchArtistLoop(
            {
              imageBase64,
              cityId: cityPreset.id,
              cityLabel: cityPreset.label,
              sourceName: imageSourceName ?? undefined,
            },
            noteStage,
          );
        } catch (err) {
          stageFailed("The design-first artist loop", err);
        }
        if (artistRoute) {
          applyArtistLoopResult(artistRoute);
          recordSearchEnd("done");
          return;
        }

        noteStage("Design-first route did not return a usable route - checking strict route-native fallbacks...");
        try {
          const routeNative = await autoFindTop5(contour, cityPreset, {
            anchorSource: "image",
            imageBase64,
            imageSourceName: imageSourceName ?? undefined,
            topK: 5,
          });
          if (applyAutoFindResult(routeNative)) {
            recordSearchEnd("done");
            return;
          }
        } catch (err) {
          stageFailed("The route-native fallback", err);
        }
      }
      const exhaustedMessage = `We tried your art as-drawn plus ${roundsTried} fresh street-ready redraws${lastInterp?.subject ? ` (as ${lastInterp.subject})` : ""} - nothing cleared the blind judge's bar. ${lastPlaced?.message ?? lastInterp?.message ?? ""} You can place it yourself: drag the art where you want it and continue, and we'll fit it to the streets faithfully.`;
      setAutoHint(exhaustedMessage);
      recordSearchEnd("no-route", exhaustedMessage);
      setShowOfframp(true);
      setOfframpRun(
        matchVerifiedBankRun([
          lastInterp?.subject,
          lastPlaced?.subject,
          literal.subject,
          interpretedSubject,
          imageSourceName,
        ]),
      );
    } catch (err) {
      console.warn("[Step2] find-my-route cascade failed:", err);
      // Persistent on purpose: the user may come back minutes later and
      // must find the outcome, not a silently reset button.
      const detail = err instanceof Error ? err.message : "Route finding failed.";
      const message =
        `Route search stopped during: "${lastStageRef.current}" — ${detail} ` +
        "This can happen if the computer sleeps or the tab stays in the background too long. " +
        "Keep this tab visible and press Find my route to try again.";
      setAutoHint(message);
      recordSearchEnd("stopped", message);
    } finally {
      try {
        void wakeLock?.release();
      } catch {
        /* already released */
      }
      setAutoBusy(false);
    }
  }, [contour, cityPreset, imageBase64, imageSourceName, interpretedSubject, routeFromPick, armHintClear, noteStage, recordSearchEnd, applyResult, applyArtistLoopResult, applyStudioResult, notifyEmail, watchRouteJob]);

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
    setShowOfframp(false);
    setOfframpRun(null);
    setSelectedPickIdx(null);
    setPreferredSnappedRoute(null);
    setSelectedAnchorLatLngs(null);
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
            <label className="font-dm flex flex-col gap-1 text-[10px] text-pace-muted">
              <span>Email me when it&apos;s found (optional — you can close the page)</span>
              <input
                type="email"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full border border-pace-line bg-pace-white px-2 py-1.5 text-xs text-pace-ink placeholder:text-pace-muted/50"
              />
            </label>
            <button
              type="button"
              disabled={
                autoBusy || !contour.length || cityPreset.id !== "manhattan"
              }
              onClick={() => void runWowFind()}
              className="pace-toolbar-btn-primary mt-1 w-full py-2.5 text-[11px] font-semibold disabled:opacity-50 sm:text-xs"
              title={
                cityPreset.id === "manhattan"
                  ? "Tries your art exactly as drawn, and if the street judges refuse, automatically redraws it street-ready and tries again. Shows only routes an AI judge verified — or one honest answer."
                  : "Route finding currently supports Manhattan only."
              }
            >
              {autoBusy ? "Finding your route…" : "Find my route"}
            </button>
            <p className="text-[10px] leading-snug text-pace-muted">
              Prefer to place it yourself? Drag the yellow dot, then continue —
              we&apos;ll fit your art to the streets exactly where you put it.
            </p>
            <div id="step2-status">
              {autoHint ? (
                <p className="text-[11px] leading-snug text-pace-muted">{autoHint}</p>
              ) : null}
              {showOfframp && !autoBusy ? (
                <div className="mt-2 rounded border border-pace-line bg-white p-2">
                  {offrampRun ? (
                    <div className="flex items-center gap-2.5">
                      {/* eslint-disable-next-line @next/next/no-img-element -- small local thumbnail, plain img keeps the Leaflet-heavy step light */}
                      <img
                        src={`/curated/${offrampRun.id}.png`}
                        alt={`${offrampRun.title} — verified route preview`}
                        className="h-16 w-16 shrink-0 rounded border border-pace-line object-cover"
                      />
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold leading-snug text-pace-ink">
                          Meanwhile: a blind-verified {offrampRun.title} already
                          exists.
                        </p>
                        <p className="mt-0.5 truncate text-[10px] text-pace-muted">
                          {offrampRun.area}
                        </p>
                        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                          <a
                            href={`/api/curated-gpx/${offrampRun.id}`}
                            download
                            className="text-[11px] font-semibold text-pace-blue hover:underline"
                          >
                            Download the GPX
                          </a>
                          <a
                            href="/gallery"
                            className="text-[11px] font-semibold text-pace-blue hover:underline"
                          >
                            All verified routes →
                          </a>
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] leading-snug text-pace-muted">
                      Meanwhile: the{" "}
                      <a
                        href="/gallery"
                        className="font-semibold text-pace-blue hover:underline"
                      >
                        gallery
                      </a>{" "}
                      has blind-verified routes ready to run today.
                    </p>
                  )}
                </div>
              ) : null}
            </div>
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
            <div
              id="step2-picks"
              className="mt-3 flex flex-col gap-2 rounded border border-pace-line bg-pace-warm/50 p-2"
            >
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
            disabled={!anchorLatLngs.length || autoBusy}
            title={
              autoBusy
                ? "Finding your route — this continues automatically when it's done."
                : preferredSnappedRoute
                  ? "Continue with the verified route shown on the map."
                  : "Skip the search and fit your art to the streets exactly where you placed it."
            }
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
            className="pace-toolbar-btn-primary flex-1 font-bebas tracking-[0.08em] disabled:opacity-40"
          >
            {preferredSnappedRoute ? "Continue with this route →" : "Place it myself →"}
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
