"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import * as turf from "@turf/turf";
import { haversineMeters as haversineMetersLatLng } from "../lib/haversine";
import {
  interpretationMatchPercent,
  shapeAccuracyPercent,
} from "../lib/shapeMatchScore";
import type { Map as LeafletMap } from "leaflet";
import type { AnchorLocation, RouteLineString } from "./WorkflowController";
import { fetchMapboxWalkingDirectionsJson } from "../lib/mapboxClient";
import { simplifyPolylineToBendWaypoints } from "../lib/simplifyPolylineToBendWaypoints";
import {
  estimateSeconds,
  formatDistance,
  formatDuration,
  useRunnerProfile,
} from "../lib/runnerProfile";
import MapChunkFallback from "./MapChunkFallback";
import MapStepSplitLayout from "./MapStepSplitLayout";
import ShapeMatchMeter from "./ShapeMatchMeter";

const Step4LeafletMap = dynamic(() => import("./Step4LeafletMap"), {
  ssr: false,
  loading: () => <MapChunkFallback className="h-full min-h-0" />,
});

type Waypoint = [number, number];

async function mapboxWalkingPolyline(
  from: Waypoint,
  to: Waypoint,
): Promise<Waypoint[]> {
  const data = (await fetchMapboxWalkingDirectionsJson({
    coordinates: [from, to],
    steps: false,
    overview: "full",
  })) as {
    routes?: { geometry?: { coordinates?: [number, number][] } }[];
  };
  const coords = data.routes?.[0]?.geometry?.coordinates;
  if (!coords?.length) throw new Error("no route");
  return coords.map(([lng, lat]) => [lat, lng] as Waypoint);
}

/** Fallback when Mapbox fails — dense great-circle for a visible connector. */
function greatCircleSpur(from: Waypoint, to: Waypoint, steps = 20): Waypoint[] {
  const out: Waypoint[] = [from];
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    out.push([
      from[0] + t * (to[0] - from[0]),
      from[1] + t * (to[1] - from[1]),
    ]);
  }
  out.push(to);
  return out;
}

/**
 * Retry the walking-polyline fetch a few times before falling back to a
 * straight-line spur. Most single-leg failures are transient 5xx / timeout /
 * rate-limit; retrying with short backoff recovers silently so users don't
 * see a "teleport" segment that won't walk.
 *
 * Returns both the coordinates and whether we had to fall back — callers tag
 * the leg so the UI can warn the user that this segment isn't street-snapped.
 */
async function mapboxWalkingPolylineWithRetry(
  from: Waypoint,
  to: Waypoint,
  maxAttempts = 3,
): Promise<{ coords: Waypoint[]; isSpur: boolean }> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const backoffMs = 250 * 2 ** (attempt - 1); // 250, 500, 1000…
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    try {
      const coords = await mapboxWalkingPolyline(from, to);
      return { coords, isSpur: false };
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn(
    "[Step4RouteEditor] walking-polyline failed after retries; using spur",
    lastErr,
  );
  return { coords: greatCircleSpur(from, to), isSpur: true };
}

/** Per-leg override: geometry plus whether it's a straight-line fallback. */
type LegOverride = { coords: Waypoint[]; isSpur: boolean };

/**
 * Click-on-line threshold. If the user double-clicks (or drops a drag) within
 * this distance of the visible red route, the editor treats it as a polyline
 * edit — snap to the line, no Mapbox call. Beyond this, it's a detour request
 * and Mapbox routes a real walking path.
 *
 * 60 m covers double-click imprecision on a phone (two-finger zoom range) and
 * small drag-along-same-street moves. Anything farther is clearly intentional.
 */
const NEAR_LINE_SNAP_METERS = 60;

type LegClosest = {
  legIndex: number;
  segIndex: number;
  t: number;
  point: Waypoint;
  dist: number;
};

/**
 * Closest point on any leg polyline to `p`. Returned `legIndex` tells us which
 * leg to split (for insert) or which legs flank the drop (for drag).
 */
function closestPointOnLegs(legs: Waypoint[][], p: Waypoint): LegClosest | null {
  let best: LegClosest | null = null;
  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li];
    for (let i = 0; i < leg.length - 1; i++) {
      const a = leg[i];
      const b = leg[i + 1];
      const t = projectScalarOnSegment(a, b, p);
      const cx = a[0] + t * (b[0] - a[0]);
      const cy = a[1] + t * (b[1] - a[1]);
      const d = haversineMetersLatLng(p, [cx, cy]);
      if (!best || d < best.dist) {
        best = { legIndex: li, segIndex: i, t, point: [cx, cy], dist: d };
      }
    }
  }
  return best;
}

/**
 * Split a leg at `(segIndex, t)` into two new legs. Each half includes the
 * split point; no duplicate-vertex noise after the merge pass.
 */
function splitLegAt(
  leg: Waypoint[],
  segIndex: number,
  splitPoint: Waypoint,
): { left: Waypoint[]; right: Waypoint[] } {
  const left: Waypoint[] = [...leg.slice(0, segIndex + 1), splitPoint];
  const right: Waypoint[] = [splitPoint, ...leg.slice(segIndex + 1)];
  return { left, right };
}

/** Concat two legs that share a joint — drops duplicate joint if within 1 m. */
function mergeLegs(left: Waypoint[], right: Waypoint[]): Waypoint[] {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  const joint = left[left.length - 1];
  const out = [...left];
  const start =
    haversineMetersLatLng(joint, right[0]) < 1 ? 1 : 0;
  for (let i = start; i < right.length; i++) out.push(right[i]);
  return out;
}

function snapToStreetLine(line: [number, number][], raw: Waypoint): Waypoint {
  if (line.length < 2) return raw;
  try {
    const ls = turf.lineString(
      line.map(([lat, lng]) => [lng, lat] as [number, number]),
    );
    const np = turf.nearestPointOnLine(ls, [raw[1], raw[0]], {
      units: "kilometers",
    });
    const [lng, lat] = np.geometry.coordinates;
    return [lat, lng];
  } catch {
    return raw;
  }
}

/** Arc length along polyline to closest point to p (meters). */
function distanceAlongLineToPoint(line: Waypoint[], p: Waypoint): number {
  let bestAlong = 0;
  let bestDist = Infinity;
  let cumulative = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = haversineMeters(a, b);
    const t = projectScalarOnSegment(a, b, p);
    const cx = a[0] + t * (b[0] - a[0]);
    const cy = a[1] + t * (b[1] - a[1]);
    const d = haversineMeters(p, [cx, cy]);
    if (d < bestDist) {
      bestDist = d;
      bestAlong = cumulative + t * segLen;
    }
    cumulative += segLen;
  }
  return bestAlong;
}

/** Keep waypoint order consistent with travel along the snapped street line. */
function orderWaypointsAlongLine(line: Waypoint[], wps: Waypoint[]): Waypoint[] {
  if (line.length < 2 || wps.length === 0) return wps.slice();
  const scored = wps.map((p) => ({
    p,
    s: distanceAlongLineToPoint(line, p),
  }));
  scored.sort((a, b) => a.s - b.s);
  const out: Waypoint[] = [];
  for (const { p } of scored) {
    if (out.length && haversineMeters(out[out.length - 1], p) < 3) continue;
    out.push(p);
  }
  if (out.length >= 2) return out;
  return scored.map((x) => x.p);
}

function nearSameWaypoint(a: Waypoint, b: Waypoint, epsM: number): boolean {
  return haversineMeters(a, b) < epsM;
}

/**
 * Merge per-leg paths into one LineString. Uses each `waypoints[i]` as the joint
 * between leg i-1 and leg i so Mapbox endpoints and street-slice endpoints
 * (often meters apart) do not create visible chord segments.
 */
function mergeLegPolylinesWithWaypoints(
  legs: Waypoint[][],
  waypoints: Waypoint[],
): Waypoint[] {
  if (!legs.length) return [];
  const jointEpsM = 22;

  if (waypoints.length !== legs.length + 1) {
    const out: Waypoint[] = [...legs[0]];
    for (let i = 1; i < legs.length; i++) {
      const seg = legs[i];
      if (!seg.length) continue;
      for (let k = 1; k < seg.length; k++) out.push(seg[k]);
    }
    return out;
  }

  const out: Waypoint[] = [...legs[0]];
  for (let i = 1; i < legs.length; i++) {
    const seg = legs[i];
    if (!seg.length) continue;
    const joint = waypoints[i];
    if (!nearSameWaypoint(out[out.length - 1], joint, jointEpsM)) {
      out.push(joint);
    }
    let k0 = 0;
    while (k0 < seg.length && nearSameWaypoint(seg[k0], joint, jointEpsM)) {
      k0++;
    }
    if (k0 >= seg.length) {
      const wEnd = waypoints[i + 1];
      if (wEnd && !nearSameWaypoint(out[out.length - 1], wEnd, jointEpsM)) {
        out.push(wEnd);
      }
      continue;
    }
    for (let k = k0; k < seg.length; k++) out.push(seg[k]);
  }
  return out;
}

function projectScalarOnSegment(
  a: Waypoint,
  b: Waypoint,
  p: Waypoint,
): number {
  const ax = a[1];
  const ay = a[0];
  const bx = b[1];
  const by = b[0];
  const px = p[1];
  const py = p[0];
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const denom = abx * abx + aby * aby;
  if (denom < 1e-18) return 0;
  const t = (apx * abx + apy * aby) / denom;
  return Math.max(0, Math.min(1, t));
}

type ClosestOnLine = {
  segIndex: number;
  t: number;
  point: Waypoint;
  distAlong: number;
};

function locateClosestOnPolyline(fullLine: Waypoint[], p: Waypoint): ClosestOnLine {
  let bestDist = Infinity;
  let best: ClosestOnLine = {
    segIndex: 0,
    t: 0,
    point: fullLine[0],
    distAlong: 0,
  };
  let cumulative = 0;
  for (let i = 0; i < fullLine.length - 1; i++) {
    const a = fullLine[i];
    const b = fullLine[i + 1];
    const segLen = haversineMeters(a, b);
    const t = projectScalarOnSegment(a, b, p);
    const cx = a[0] + t * (b[0] - a[0]);
    const cy = a[1] + t * (b[1] - a[1]);
    const d = haversineMeters(p, [cx, cy]);
    if (d < bestDist) {
      bestDist = d;
      best = {
        segIndex: i,
        t,
        point: [cx, cy],
        distAlong: cumulative + t * segLen,
      };
    }
    cumulative += segLen;
  }
  return best;
}

const FORWARD_POLYLINE_SLACK_M = 38;

function locateClosestOnPolylineForward(
  fullLine: Waypoint[],
  p: Waypoint,
  minDistAlong: number,
): ClosestOnLine {
  const slack = FORWARD_POLYLINE_SLACK_M;
  const minWin = Math.max(0, minDistAlong - slack);
  let bestDist = Infinity;
  let best: ClosestOnLine | null = null;
  let cumulative = 0;

  for (let i = 0; i < fullLine.length - 1; i++) {
    const a = fullLine[i];
    const b = fullLine[i + 1];
    const segLen = haversineMeters(a, b);
    const segEnd = cumulative + segLen;
    if (segEnd < minWin - 0.5) {
      cumulative += segLen;
      continue;
    }
    const t = projectScalarOnSegment(a, b, p);
    const cx = a[0] + t * (b[0] - a[0]);
    const cy = a[1] + t * (b[1] - a[1]);
    const d = haversineMeters(p, [cx, cy]);
    const distAlong = cumulative + t * segLen;
    if (distAlong + 0.5 < minWin) {
      cumulative += segLen;
      continue;
    }
    if (d < bestDist) {
      bestDist = d;
      best = {
        segIndex: i,
        t,
        point: [cx, cy],
        distAlong,
      };
    }
    cumulative += segLen;
  }

  if (!best) return locateClosestOnPolyline(fullLine, p);
  return best;
}

function sliceBetweenOrderedLocations(
  fullLine: Waypoint[],
  start: ClosestOnLine,
  end: ClosestOnLine,
): Waypoint[] {
  const epsM = 0.05;
  const pushDeduped = (arr: Waypoint[], q: Waypoint) => {
    if (!arr.length || haversineMeters(arr[arr.length - 1], q) >= epsM) {
      arr.push(q);
    }
  };

  let swapped = false;
  let s = start;
  let e = end;
  if (s.distAlong > e.distAlong) {
    swapped = true;
    [s, e] = [e, s];
  }

  const i0 = s.segIndex;
  const i1 = e.segIndex;
  const path: Waypoint[] = [];

  pushDeduped(path, s.point);

  if (i0 === i1) {
    pushDeduped(path, e.point);
  } else if (i0 < i1) {
    for (let idx = i0 + 1; idx <= i1; idx++) {
      pushDeduped(path, fullLine[idx]);
    }
    pushDeduped(path, e.point);
  } else {
    for (let idx = i0; idx > i1; idx--) {
      pushDeduped(path, fullLine[idx]);
    }
    pushDeduped(path, e.point);
  }

  if (swapped) path.reverse();

  if (path.length < 2) {
    return greatCircleSpur(start.point, end.point);
  }
  return path;
}

function buildSequentialLegSlices(fullLine: Waypoint[], wp: Waypoint[]): Waypoint[][] {
  if (fullLine.length < 2 || wp.length < 2) return [];

  const legs: Waypoint[][] = [];
  let A = locateClosestOnPolyline(fullLine, wp[0]);

  for (let i = 0; i < wp.length - 1; i++) {
    let B = locateClosestOnPolylineForward(fullLine, wp[i + 1], A.distAlong);
    if (B.distAlong + 2 < A.distAlong) {
      B = locateClosestOnPolyline(fullLine, wp[i + 1]);
    }
    legs.push(sliceBetweenOrderedLocations(fullLine, A, B));
    A = B;
  }

  return legs;
}

function clickProgressAlongLeg(
  leg: Waypoint[],
  clickLat: number,
  clickLng: number,
): { along: number; total: number } {
  const p: Waypoint = [clickLat, clickLng];
  let total = 0;
  let bestAlong = 0;
  let bestDist = Infinity;
  let cum = 0;
  for (let i = 0; i < leg.length - 1; i++) {
    const a = leg[i];
    const b = leg[i + 1];
    const segLen = haversineMeters(a, b);
    const t = projectScalarOnSegment(a, b, p);
    const cx = a[0] + t * (b[0] - a[0]);
    const cy = a[1] + t * (b[1] - a[1]);
    const d = haversineMeters(p, [cx, cy]);
    if (d < bestDist) {
      bestDist = d;
      bestAlong = cum + t * segLen;
    }
    cum += segLen;
  }
  return { along: bestAlong, total: cum };
}

/** Shortest distance from a point to a polyline leg (meters). */
function distancePointToLegMeters(
  leg: Waypoint[],
  lat: number,
  lng: number,
): number {
  const p: Waypoint = [lat, lng];
  let bestDist = Infinity;
  for (let i = 0; i < leg.length - 1; i++) {
    const a = leg[i];
    const b = leg[i + 1];
    const t = projectScalarOnSegment(a, b, p);
    const cx = a[0] + t * (b[0] - a[0]);
    const cy = a[1] + t * (b[1] - a[1]);
    const d = haversineMeters(p, [cx, cy]);
    if (d < bestDist) bestDist = d;
  }
  return bestDist;
}

type Props = {
  anchorLocation: AnchorLocation;
  snappedRoute: RouteLineString;
  /** Photo trace shows sketch overlay + match bar; freehand omits them. */
  routeSource: "image" | "freehand";
  onBack: () => void;
  onComplete: (route: RouteLineString) => void;
};

function bboxOfWaypoints(pts: Waypoint[]): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} | null {
  if (!pts.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [la, ln] of pts) {
    minLat = Math.min(minLat, la);
    maxLat = Math.max(maxLat, la);
    minLng = Math.min(minLng, ln);
    maxLng = Math.max(maxLng, ln);
  }
  return { minLat, maxLat, minLng, maxLng };
}

/** Block handles clustered on one leg while the snap line spans a 2D loop → bad legs in fine-tune. */
function blockWaypointsSpanPolyline(
  line: Waypoint[],
  block: Waypoint[],
  minRatio = 0.22,
): boolean {
  const sb = bboxOfWaypoints(line);
  const wb = bboxOfWaypoints(block);
  if (!sb || !wb) return true;
  const latSpanS = sb.maxLat - sb.minLat;
  const lngSpanS = sb.maxLng - sb.minLng;
  const latSpanW = wb.maxLat - wb.minLat;
  const lngSpanW = wb.maxLng - wb.minLng;
  const eps = 1.2e-4;
  const needLat = latSpanS > eps;
  const needLng = lngSpanS > eps;
  const latOk = !needLat || latSpanW / latSpanS >= minRatio;
  const lngOk = !needLng || lngSpanW / lngSpanS >= minRatio;
  return latOk && lngOk;
}

function sampleWaypointsAlongPolyline(coords: Waypoint[], n: number): Waypoint[] {
  if (coords.length < 2) return coords.slice() as Waypoint[];
  const capped = Math.min(n, coords.length);
  const out: Waypoint[] = [];
  for (let k = 0; k < capped; k++) {
    const t = capped === 1 ? 0 : k / (capped - 1);
    const idx = t * (coords.length - 1);
    const i = Math.floor(idx);
    const j = Math.min(i + 1, coords.length - 1);
    const f = idx - i;
    const a = coords[i];
    const b = coords[j];
    out.push([
      a[0] + f * (b[0] - a[0]),
      a[1] + f * (b[1] - a[1]),
    ]);
  }
  return out;
}

function initialWaypoints(route: RouteLineString): Waypoint[] {
  const coords = route.coordinates as Waypoint[];
  const block = route.blockWaypoints;
  if (block && block.length >= 2) {
    const useBlock =
      coords.length < 2 || blockWaypointsSpanPolyline(coords, block);
    if (useBlock) {
      if (coords.length >= 2) {
        /**
         * Waypoints only at direction changes. The previous config forced a
         * handle every ~286 m on straight streets so the user always had
         * something to drag mid-block, but that made long straights look
         * cluttered (6+ identical dots along one block face) and trained
         * users to think each dot meant a turn. With polyline-first editing
         * in place (double-tap the line to drop a handle anywhere), the
         * forced mid-straight anchors are no longer useful — users can add
         * one in a single tap when they actually want to pull the route
         * sideways.
         *
         * maxStraightRunM effectively disabled (50 km > any real route);
         * minTurnDeg raised slightly so only meaningful turns count, not
         * gentle bearing drift along curvy streets.
         */
        const bends = simplifyPolylineToBendWaypoints(
          coords as [number, number][],
          {
            minTurnDeg: 28,
            maxStraightRunM: 50_000,
            minCornerSeparationM: 20,
          },
        );
        if (bends.length >= 2) {
          return bends as Waypoint[];
        }
      }
      return block.map(([a, b]) => [a, b] as Waypoint);
    }
  }
  if (coords.length < 2) return coords.slice() as Waypoint[];
  const n = Math.min(12, coords.length);
  return sampleWaypointsAlongPolyline(coords, n);
}

export default function Step4RouteEditor({
  anchorLocation,
  snappedRoute,
  routeSource,
  onBack,
  onComplete,
}: Props) {
  const showArtControls = routeSource === "image";

  const [waypoints, setWaypoints] = useState<Waypoint[]>(() =>
    initialWaypoints(snappedRoute),
  );
  /**
   * Default OFF even for image uploads. When it was on by default, users
   * would see stray bits of their traced outline (parts the street snap
   * couldn't follow — e.g. pen jitter, a hooked stroke) and think they were
   * routing artifacts they should edit away. Waypoint tools can't touch this
   * overlay, so the UX dead-ended. Off by default keeps the view clean; the
   * toggle is still available for users who want the shape-vs-route compare.
   */
  const [showOriginalArt, setShowOriginalArt] = useState(false);
  /** When off, hide full Mapbox polyline so stray tails past your waypoints disappear. */
  const [showFullSnapReference, setShowFullSnapReference] = useState(false);
  /** When off, hide orange waypoint handles to preview the final red route only. */
  const [showWaypointDots, setShowWaypointDots] = useState(true);
  const [selectedWaypointIndex, setSelectedWaypointIndex] = useState<
    number | null
  >(null);
  /** Shift+click toggles indices; Delete removes all selected (or one). */
  const [shiftSelectedIndices, setShiftSelectedIndices] = useState<number[]>([]);
  /** Per-leg geometry when Mapbox spur replaces lineSlice (length = waypoints.length - 1). */
  const [legOverrides, setLegOverrides] = useState<(LegOverride | null)[]>([]);
  const [spurBusy, setSpurBusy] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [quickTipsOpen, setQuickTipsOpen] = useState(true);
  /** Collapsed by default on mobile so the toggles + meters row doesn't
   *  dominate the short sidebar. Always visible on desktop via `lg:block`. */
  const [mobileOptionsOpen, setMobileOptionsOpen] = useState(false);
  const [runnerProfile] = useRunnerProfile();
  const [undoPast, setUndoPast] = useState<Waypoint[][]>([]);
  const [redoFuture, setRedoFuture] = useState<Waypoint[][]>([]);
  /**
   * One-shot toast the first time a user deletes a middle waypoint, so they
   * learn that the line is intentionally preserved (polyline-first edits).
   * Remembered in localStorage so returning users don't see it again.
   */
  const [deleteHint, setDeleteHint] = useState<string | null>(null);

  const mapRef = useRef<LeafletMap | null>(null);
  const waypointsRef = useRef(waypoints);
  const legOverridesRef = useRef(legOverrides);
  /** Snapshot of the current rendered legs; callbacks use this for polyline-
   *  first edits (snap-to-line, split-on-insert) without a render round-trip. */
  const legPolylinesRef = useRef<Waypoint[][]>([]);
  const initialRef = useRef(snappedRoute);

  waypointsRef.current = waypoints;
  legOverridesRef.current = legOverrides;

  const streetLine = useMemo(
    () => (snappedRoute.coordinates ?? []) as Waypoint[],
    [snappedRoute.coordinates],
  );

  const originalArt = useMemo(
    () => (anchorLocation?.anchorLatLngs ?? []) as Waypoint[],
    [anchorLocation?.anchorLatLngs],
  );

  const routeInterpretationPct = useMemo(
    () => interpretationMatchPercent(originalArt, streetLine),
    [originalArt, streetLine],
  );

  const routeTightFitPct = useMemo(
    () => shapeAccuracyPercent(originalArt, streetLine),
    [originalArt, streetLine],
  );

  const matchMeterLabel =
    routeSource === "freehand"
      ? "Interpretation (sketch)"
      : "Interpretation (your art)";
  const matchMeterTitle =
    "GPS-art style score on the initial full snap: silhouette, not pixel tracing.";
  const tightMeterTitle =
    "Strict mean distance between outline and route (often lower on real streets).";

  /**
   * Geometry used only for FitRouteBounds — must not depend on showOriginalArt
   * or toggling the art overlay will refit the map and feel like a “reset”.
   */
  const fitBoundsStaticLine = useMemo(() => {
    const parts: Waypoint[] = [];
    if (originalArt.length >= 2) {
      parts.push(...originalArt);
    }
    if (streetLine.length >= 2) {
      parts.push(...streetLine);
    }
    if (parts.length >= 2) return parts;
    if (streetLine.length >= 2) return streetLine;
    return null;
  }, [originalArt, streetLine]);

  const sequentialStreetLegs = useMemo(
    () => buildSequentialLegSlices(streetLine, waypoints),
    [streetLine, waypoints],
  );

  /** When polyline slicing fails (common near T-junctions), fetch real walking legs instead of straight chords. */
  useEffect(() => {
    if (waypoints.length < 2 || streetLine.length < 2) return;
    const legs = buildSequentialLegSlices(streetLine, waypoints);
    const weakIndices: number[] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (!legs[i] || legs[i].length < 2) weakIndices.push(i);
    }
    if (!weakIndices.length) return;

    let cancelled = false;
    const wpSnap = waypoints.map((p) => [p[0], p[1]] as Waypoint);

    void (async () => {
      const fetched: (LegOverride | null)[] = new Array(
        wpSnap.length - 1,
      ).fill(null);
      for (const i of weakIndices) {
        if (cancelled) return;
        const a = wpSnap[i];
        const b = wpSnap[i + 1];
        if (!a || !b) continue;
        const r = await mapboxWalkingPolylineWithRetry(a, b);
        if (r.coords.length >= 2) fetched[i] = r;
      }
      if (cancelled) return;
      setLegOverrides((prev) => {
        const n = waypointsRef.current.length - 1;
        if (n < 1) return prev;
        const out = prev.slice(0, n);
        while (out.length < n) out.push(null);
        let changed = false;
        for (let i = 0; i < n; i++) {
          if (out[i] != null) continue;
          if (fetched[i] != null) {
            out[i] = fetched[i];
            changed = true;
          }
        }
        return changed ? out : prev;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [waypoints, streetLine]);

  const legPolylines = useMemo(() => {
    if (waypoints.length < 2) return [];
    const legs: Waypoint[][] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const ov = legOverrides[i];
      if (ov && ov.coords.length >= 2) {
        legs.push(ov.coords);
      } else if (sequentialStreetLegs[i]?.length >= 2) {
        legs.push(sequentialStreetLegs[i]!);
      } else {
        legs.push(greatCircleSpur(waypoints[i], waypoints[i + 1]));
      }
    }
    return legs;
  }, [waypoints, legOverrides, sequentialStreetLegs]);

  legPolylinesRef.current = legPolylines;

  /**
   * Which legs are currently rendered as straight-line spurs rather than real
   * walking paths. Picked up by the sidebar warning banner and by the map so
   * spur segments render with an amber dashed overlay.
   */
  const spurLegIndices = useMemo(() => {
    if (waypoints.length < 2) return [] as number[];
    const out: number[] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const ov = legOverrides[i];
      if (ov) {
        if (ov.isSpur) out.push(i);
        continue;
      }
      if (!sequentialStreetLegs[i] || sequentialStreetLegs[i]!.length < 2) {
        out.push(i);
      }
    }
    return out;
  }, [waypoints, legOverrides, sequentialStreetLegs]);

  /**
   * Traffic-light verdict for "is this route good enough to run?". Replaces
   * the raw interpretation-% meter as the primary signal Dan sees — the %
   * stays available in View Options for users who want the detail, but
   * most users just need the green/amber/red call. Inputs are all things
   * we already track: waypoint count, spur legs, interpretation score.
   */
  const verdict = useMemo((): {
    tone: "ready" | "check" | "blocked";
    title: string;
    detail: string;
  } => {
    if (waypoints.length < 2) {
      return {
        tone: "blocked",
        title: "No route yet",
        detail:
          "Add at least two waypoints by double-tapping the map to get started.",
      };
    }
    const spurs = spurLegIndices.length;
    if (spurs > 0) {
      return {
        tone: "check",
        title: `${spurs} segment${spurs === 1 ? "" : "s"} not street-snapped`,
        detail:
          "Amber dashed = straight-line placeholders. Tap the re-snap button above the options, or drag those handles onto walkable streets.",
      };
    }
    if (waypoints.length < 4) {
      return {
        tone: "check",
        title: "Looks short",
        detail:
          "Only a few waypoints — fine if that's the shape, otherwise double-tap the map to drop more.",
      };
    }
    if (
      routeSource === "image" &&
      Number.isFinite(routeInterpretationPct) &&
      routeInterpretationPct > 0 &&
      routeInterpretationPct < 35
    ) {
      return {
        tone: "check",
        title: "Shape doesn't read well",
        detail:
          "The street route strays a lot from your outline. Try re-running auto-find at a different scale, or keep editing.",
      };
    }
    return {
      tone: "ready",
      title: "Ready to run",
      detail: "Clean route, all on walkable streets. Hit Looks good below.",
    };
  }, [
    waypoints.length,
    spurLegIndices,
    routeInterpretationPct,
    routeSource,
  ]);

  const activeRouteLine = useMemo(
    () => mergeLegPolylinesWithWaypoints(legPolylines, waypoints),
    [legPolylines, waypoints],
  );

  const showFaintFullStreet =
    showFullSnapReference ||
    waypoints.length < 2 ||
    activeRouteLine.length < 2;

  const center: Waypoint = useMemo(() => {
    if (waypoints.length > 0) return waypoints[0];
    if (streetLine.length > 0) return streetLine[0];
    const c = anchorLocation?.center;
    if (c) return [c[0], c[1]];
    return [40.7831, -73.9712];
  }, [anchorLocation?.center, streetLine, waypoints]);

  useEffect(() => {
    const sl = (snappedRoute.coordinates ?? []) as Waypoint[];
    const raw = initialWaypoints(snappedRoute);
    setWaypoints(
      sl.length >= 2 ? orderWaypointsAlongLine(sl, raw) : raw,
    );
    initialRef.current = snappedRoute;
    setUndoPast([]);
    setRedoFuture([]);
    setSelectedWaypointIndex(null);
    setShiftSelectedIndices([]);
    setLegOverrides([]);
  }, [snappedRoute]);

  const commitWaypoints = useCallback(
    (next: Waypoint[], nextLegOverrides?: (LegOverride | null)[]) => {
      setUndoPast((past) => [...past, waypointsRef.current]);
      setRedoFuture([]);
      setWaypoints(next);
      const n = Math.max(0, next.length - 1);
      if (nextLegOverrides === undefined) {
        setLegOverrides(new Array(n).fill(null));
      } else {
        const padded = nextLegOverrides.slice(0, n);
        while (padded.length < n) padded.push(null);
        setLegOverrides(padded);
      }
    },
    [],
  );

  const undo = useCallback(() => {
    setUndoPast((past) => {
      if (!past.length) return past;
      const prev = past[past.length - 1];
      setRedoFuture((f) => [waypointsRef.current, ...f]);
      setWaypoints(prev);
      setShiftSelectedIndices([]);
      setLegOverrides([]);
      setSelectedWaypointIndex(null);
      return past.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoFuture((future) => {
      if (!future.length) return future;
      const next = future[0];
      setUndoPast((p) => [...p, waypointsRef.current]);
      setWaypoints(next);
      setShiftSelectedIndices([]);
      setLegOverrides([]);
      setSelectedWaypointIndex(null);
      return future.slice(1);
    });
  }, []);

  const restart = useCallback(() => {
    const sl = (initialRef.current.coordinates ?? []) as Waypoint[];
    const raw = initialWaypoints(initialRef.current);
    const next = sl.length >= 2 ? orderWaypointsAlongLine(sl, raw) : raw;
    setUndoPast((p) => [...p, waypointsRef.current]);
    setRedoFuture([]);
    setWaypoints(next);
    setSelectedWaypointIndex(null);
    setShiftSelectedIndices([]);
    setLegOverrides([]);
  }, []);

  function adjustIndexAfterRemoval(
    idx: number | null,
    removed: number,
  ): number | null {
    if (idx === null) return null;
    if (idx === removed) return null;
    if (idx > removed) return idx - 1;
    return idx;
  }

  function adjustMultiSelectAfterRemoval(
    indices: number[],
    removed: number,
  ): number[] {
    return indices
      .filter((i) => i !== removed)
      .map((i) => (i > removed ? i - 1 : i))
      .sort((a, b) => a - b);
  }

  const removeAt = useCallback(
    (index: number) => {
      const wp = waypointsRef.current;
      if (wp.length <= 1) return;
      const isMiddle = index > 0 && index < wp.length - 1;
      setSelectedWaypointIndex((sel) => adjustIndexAfterRemoval(sel, index));
      setShiftSelectedIndices((ids) =>
        adjustMultiSelectAfterRemoval(ids, index),
      );
      if (isMiddle) {
        try {
          const seen = window.localStorage.getItem(
            "pacecasso-step4-middle-delete-hint-v1",
          );
          if (!seen) {
            setDeleteHint(
              "Handle removed — line preserved. Delete more to simplify, or edit waypoints to reshape.",
            );
            window.localStorage.setItem(
              "pacecasso-step4-middle-delete-hint-v1",
              "1",
            );
            window.setTimeout(() => setDeleteHint(null), 5000);
          }
        } catch {
          /* ignore private-mode / quota errors */
        }
      }
      const next = wp.filter((_, i) => i !== index);
      /**
       * Preserve the VISIBLE red line across a delete. If you're removing a
       * middle waypoint, legs (index-1) and (index) merge into one override
       * so the route doesn't snap back to a stale sequentialStreetLegs slice
       * (and doesn't need a Mapbox reroute that could produce a detour). If
       * you're removing the first or last waypoint, the tail simply drops.
       */
      const legs = legPolylinesRef.current;
      const prevOv = legOverridesRef.current;
      const nLegsNew = Math.max(0, next.length - 1);
      const newOv: (LegOverride | null)[] = new Array(nLegsNew).fill(null);

      for (let j = 0; j < index - 1; j++) {
        newOv[j] = prevOv[j] ?? (legs[j] ? { coords: legs[j], isSpur: false } : null);
      }
      // Merged leg: spans what used to be wp[index-1] → wp[index] → wp[index+1]
      if (index > 0 && index < wp.length - 1) {
        const leftLeg = legs[index - 1];
        const rightLeg = legs[index];
        if (leftLeg && rightLeg && leftLeg.length >= 2 && rightLeg.length >= 2) {
          newOv[index - 1] = {
            coords: mergeLegs(leftLeg, rightLeg),
            // Merged override inherits spur-ness from either half so the
            // warning/overlay surfaces if any piece was a fallback.
            isSpur:
              (prevOv[index - 1]?.isSpur ?? false) ||
              (prevOv[index]?.isSpur ?? false),
          };
        }
      }
      // Legs after the removed waypoint shift left by one
      for (let j = index + 1; j < wp.length - 1; j++) {
        const src = prevOv[j];
        const fallback = legs[j] ? { coords: legs[j], isSpur: false } : null;
        newOv[j - 1] = src ?? fallback;
      }
      commitWaypoints(next, newOv);
    },
    [commitWaypoints],
  );

  const handleMapDoubleClick = useCallback(
    async (lat: number, lng: number) => {
      const P: Waypoint = [lat, lng];
      const wp = waypointsRef.current;

      for (const w of wp) {
        if (haversineMeters(P, w) < 2) return;
      }

      if (wp.length === 0) {
        commitWaypoints([P]);
        setShiftSelectedIndices([]);
        setSelectedWaypointIndex(0);
        return;
      }

      /**
       * Polyline-first insert. When the double-click lands within 60 m of the
       * visible red route, we snap the new handle onto the nearest leg and
       * split that leg locally — no Mapbox call, no detour risk, instant
       * feedback. The insert goes between the waypoints that currently flank
       * the nearest leg, which is what the user naturally expects.
       */
      const legs = legPolylinesRef.current;
      const closest = legs.length > 0 ? closestPointOnLegs(legs, P) : null;
      if (closest && closest.dist <= NEAR_LINE_SNAP_METERS) {
        const { legIndex, segIndex, point } = closest;
        const leg = legs[legIndex];
        if (leg && leg.length >= 2) {
          const { left, right } = splitLegAt(leg, segIndex, point);
          const newWp: Waypoint[] = [
            ...wp.slice(0, legIndex + 1),
            point,
            ...wp.slice(legIndex + 1),
          ];
          const prevOv = legOverridesRef.current;
          const newOv: (LegOverride | null)[] = [];
          for (let j = 0; j < legs.length; j++) {
            if (j === legIndex) {
              const parentSpur = prevOv[j]?.isSpur ?? false;
              newOv.push({ coords: left, isSpur: parentSpur });
              newOv.push({ coords: right, isSpur: parentSpur });
            } else {
              newOv.push(
                prevOv[j] ?? { coords: legs[j], isSpur: false },
              );
            }
          }
          commitWaypoints(newWp, newOv);
          setShiftSelectedIndices([]);
          setSelectedWaypointIndex(legIndex + 1);
          return;
        }
      }

      /**
       * Far from the route — user wants an explicit detour. Route through the
       * click via Mapbox so the new segment follows real streets, not a
       * straight chord across blocks.
       */
      if (spurBusy) return;
      setSpurBusy(true);
      try {
        let nearestI = 0;
        let bestD = Infinity;
        for (let j = 0; j < wp.length; j++) {
          const d = haversineMeters(P, wp[j]);
          if (d < bestD) {
            bestD = d;
            nearestI = j;
          }
        }

        const W = wp[nearestI];
        const newWp = [...wp.slice(0, nearestI + 1), P, ...wp.slice(nearestI + 1)];
        const nLegs = newWp.length - 1;
        // Preserve every other existing leg so the original route doesn't
        // vanish during the off-line detour fetch.
        const prevOv = legOverridesRef.current;
        const newOv = new Array(nLegs).fill(null) as (LegOverride | null)[];
        for (let j = 0; j < nearestI; j++) {
          newOv[j] = prevOv[j] ?? (legs[j] ? { coords: legs[j], isSpur: false } : null);
        }
        for (let j = nearestI + 1; j < wp.length - 1; j++) {
          newOv[j + 1] = prevOv[j] ?? (legs[j] ? { coords: legs[j], isSpur: false } : null);
        }

        newOv[nearestI] = await mapboxWalkingPolylineWithRetry(W, P);
        if (nearestI < wp.length - 1) {
          const oldRight = wp[nearestI + 1];
          newOv[nearestI + 1] = await mapboxWalkingPolylineWithRetry(P, oldRight);
        }

        commitWaypoints(newWp, newOv);
        setShiftSelectedIndices([]);
        setSelectedWaypointIndex(nearestI + 1);
      } finally {
        setSpurBusy(false);
      }
    },
    [commitWaypoints, spurBusy],
  );

  const handleWaypointMarkerClick = useCallback(
    (index: number, shiftKey: boolean) => {
      setSelectedWaypointIndex(index);
      if (!shiftKey) {
        setShiftSelectedIndices([index]);
        return;
      }
      setShiftSelectedIndices((prev) => {
        const s = new Set(prev);
        if (s.has(index)) s.delete(index);
        else s.add(index);
        return [...s].sort((a, b) => a - b);
      });
    },
    [],
  );

  const clearRouteRangeSelection = useCallback(() => {
    setShiftSelectedIndices([]);
    setSelectedWaypointIndex(null);
  }, []);

  const makeSelectedWaypointStart = useCallback(async () => {
    if (spurBusy) return;
    const wp = waypointsRef.current;
    if (wp.length < 2) return;
    if (shiftSelectedIndices.length > 1) return;

    const k =
      shiftSelectedIndices.length === 1
        ? shiftSelectedIndices[0]
        : selectedWaypointIndex;
    if (k === null || k < 1 || k >= wp.length) return;

    const next = [...wp.slice(k), ...wp.slice(0, k)];
    setSpurBusy(true);
    try {
      const nL = next.length - 1;
      const ovs: (LegOverride | null)[] = [];
      for (let i = 0; i < nL; i++) {
        const a = next[i];
        const b = next[i + 1];
        if (!a || !b) {
          ovs.push(null);
          continue;
        }
        ovs.push(await mapboxWalkingPolylineWithRetry(a, b));
      }
      commitWaypoints(next, ovs);
      setSelectedWaypointIndex(0);
      setShiftSelectedIndices([0]);
    } finally {
      setSpurBusy(false);
    }
  }, [
    spurBusy,
    shiftSelectedIndices,
    selectedWaypointIndex,
    commitWaypoints,
  ]);

  const deleteSelectedWaypoints = useCallback(async () => {
    if (spurBusy) return;
    const wp = waypointsRef.current;
    const sel = [...shiftSelectedIndices];
    if (!sel.length) return;
    const toRemove = [...sel].sort((a, b) => b - a);
    let next = [...wp];
    for (const idx of toRemove) {
      if (next.length <= 1) break;
      if (idx < 0 || idx >= next.length) continue;
      next = next.filter((_, i) => i !== idx);
    }
    if (next.length === wp.length) return;

    const ordered = orderWaypointsAlongLine(streetLine, next);
    const bulk = toRemove.length > 1;

    if (!bulk || ordered.length < 2) {
      commitWaypoints(ordered);
      setShiftSelectedIndices([]);
      setSelectedWaypointIndex(null);
      return;
    }

    setSpurBusy(true);
    try {
      const nL = ordered.length - 1;
      const ovs: (LegOverride | null)[] = [];
      for (let i = 0; i < nL; i++) {
        ovs.push(
          await mapboxWalkingPolylineWithRetry(ordered[i], ordered[i + 1]),
        );
      }
      commitWaypoints(ordered, ovs);
      setShiftSelectedIndices([]);
      setSelectedWaypointIndex(null);
    } finally {
      setSpurBusy(false);
    }
  }, [commitWaypoints, shiftSelectedIndices, spurBusy, streetLine]);

  const handleWaypointDragEnd = useCallback(
    async (index: number, lat: number, lng: number) => {
      const wp = [...waypointsRef.current];
      if (index < 0 || index >= wp.length) return;
      const drop: Waypoint = [lat, lng];

      const nLegs = Math.max(0, wp.length - 1);
      if (nLegs === 0) {
        wp[index] = drop;
        commitWaypoints(wp);
        setShiftSelectedIndices([]);
        setSelectedWaypointIndex(index);
        return;
      }

      const legs = legPolylinesRef.current;
      const prevOv = legOverridesRef.current;

      /**
       * Polyline-first drag. If the drop is within 60 m of the current red
       * route, we snap to the nearest point on either adjacent leg and
       * rebuild those legs locally (no Mapbox, no detour). This makes
       * small moves — e.g., sliding a handle one block along the same
       * street — feel instant and predictable. The full active line is
       * searched so you can drag toward either neighbour; the adjacent
       * legs are then resliced so the red line stays connected.
       */
      const neighborLegIndices: number[] = [];
      if (index > 0) neighborLegIndices.push(index - 1);
      if (index < wp.length - 1) neighborLegIndices.push(index);

      const localLegs = neighborLegIndices
        .map((li) => ({ li, coords: legs[li] }))
        .filter((r) => r.coords && r.coords.length >= 2);

      let snapped: { legIndex: number; segIndex: number; point: Waypoint; dist: number } | null = null;
      for (const { li, coords } of localLegs) {
        const c = closestPointOnLegs([coords], drop);
        if (c && (!snapped || c.dist < snapped.dist)) {
          snapped = { legIndex: li, segIndex: c.segIndex, point: c.point, dist: c.dist };
        }
      }

      if (snapped && snapped.dist <= NEAR_LINE_SNAP_METERS) {
        // Snap the handle to the route.
        wp[index] = snapped.point;
        const nextOv: (LegOverride | null)[] = new Array(nLegs).fill(null);
        for (let i = 0; i < nLegs; i++) {
          nextOv[i] = prevOv[i] ?? (legs[i] ? { coords: legs[i], isSpur: false } : null);
        }

        if (snapped.legIndex === index - 1 && index > 0) {
          // Drop landed on the LEFT neighbor leg. Split it and merge right
          // half into the right-neighbor leg, so the handle still lives on
          // the visible line between wp[index-1] and wp[index+1].
          const leftLeg = legs[index - 1]!;
          const { left: splitLeft, right: splitRight } = splitLegAt(
            leftLeg,
            snapped.segIndex,
            snapped.point,
          );
          nextOv[index - 1] = {
            coords: splitLeft,
            isSpur: prevOv[index - 1]?.isSpur ?? false,
          };
          if (index < wp.length - 1) {
            const rightLeg = legs[index]!;
            nextOv[index] = {
              coords: mergeLegs(splitRight, rightLeg),
              isSpur:
                (prevOv[index - 1]?.isSpur ?? false) ||
                (prevOv[index]?.isSpur ?? false),
            };
          } else {
            // Dragged handle is the last waypoint — truncate to splitRight side.
            nextOv[index - 1] = {
              coords: splitLeft,
              isSpur: prevOv[index - 1]?.isSpur ?? false,
            };
          }
        } else if (snapped.legIndex === index && index < wp.length - 1) {
          // Drop landed on the RIGHT neighbor leg. Symmetric case.
          const rightLeg = legs[index]!;
          const { left: splitLeft, right: splitRight } = splitLegAt(
            rightLeg,
            snapped.segIndex,
            snapped.point,
          );
          nextOv[index] = {
            coords: splitRight,
            isSpur: prevOv[index]?.isSpur ?? false,
          };
          if (index > 0) {
            const leftLeg = legs[index - 1]!;
            nextOv[index - 1] = {
              coords: mergeLegs(leftLeg, splitLeft),
              isSpur:
                (prevOv[index - 1]?.isSpur ?? false) ||
                (prevOv[index]?.isSpur ?? false),
            };
          }
        }

        commitWaypoints(wp, nextOv);
        setShiftSelectedIndices([]);
        setSelectedWaypointIndex(index);
        return;
      }

      /**
       * Drop is far from the current route — user is re-routing through a
       * new area. Fetch real walking paths to/from the dropped position.
       * All non-adjacent legs are preserved from the previous overrides.
       */
      wp[index] = drop;
      const nextOv: (LegOverride | null)[] = new Array(nLegs).fill(null);
      for (let i = 0; i < nLegs; i++) {
        if (i !== index - 1 && i !== index) {
          nextOv[i] = prevOv[i] ?? (legs[i] ? { coords: legs[i], isSpur: false } : null);
        }
      }

      setSpurBusy(true);
      try {
        if (index > 0) {
          const from = wp[index - 1];
          const to = wp[index];
          nextOv[index - 1] = await mapboxWalkingPolylineWithRetry(from, to);
        }
        if (index < wp.length - 1) {
          const from = wp[index];
          const to = wp[index + 1];
          nextOv[index] = await mapboxWalkingPolylineWithRetry(from, to);
        }
        commitWaypoints(wp, nextOv);
        setShiftSelectedIndices([]);
        setSelectedWaypointIndex(index);
      } finally {
        setSpurBusy(false);
      }
    },
    [commitWaypoints],
  );

  const handleMapReady = useCallback((map: LeafletMap) => {
    mapRef.current = map;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = e.target as HTMLElement;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable
      ) {
        return;
      }
      if (shiftSelectedIndices.length > 0) {
        e.preventDefault();
        deleteSelectedWaypoints();
        return;
      }
      if (selectedWaypointIndex === null) return;
      e.preventDefault();
      removeAt(selectedWaypointIndex);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    shiftSelectedIndices,
    selectedWaypointIndex,
    removeAt,
    deleteSelectedWaypoints,
  ]);

  const resnapSpurLegs = useCallback(async () => {
    if (spurBusy) return;
    const wp = waypointsRef.current;
    if (wp.length < 2) return;
    const indices = [...spurLegIndices];
    if (indices.length === 0) return;

    setSpurBusy(true);
    try {
      const prev = legOverridesRef.current;
      const next = prev.slice();
      while (next.length < wp.length - 1) next.push(null);
      for (const i of indices) {
        const a = wp[i];
        const b = wp[i + 1];
        if (!a || !b) continue;
        next[i] = await mapboxWalkingPolylineWithRetry(a, b);
      }
      setLegOverrides(next);
    } finally {
      setSpurBusy(false);
    }
  }, [spurBusy, spurLegIndices]);

  function zoomBy(delta: number) {
    const m = mapRef.current;
    if (!m) return;
    m.setZoom((m.getZoom() ?? 13) + delta);
  }

  const distanceMeters =
    activeRouteLine.length >= 2
      ? polylineLengthMeters(activeRouteLine)
      : polylineLengthMeters(waypoints);
  const distanceKm = distanceMeters / 1000;

  const makeStartCandidateIndex =
    shiftSelectedIndices.length === 1
      ? shiftSelectedIndices[0]
      : selectedWaypointIndex;
  const canMakeStartingPoint =
    waypoints.length >= 2 &&
    shiftSelectedIndices.length <= 1 &&
    makeStartCandidateIndex !== null &&
    makeStartCandidateIndex > 0;

  return (
    <MapStepSplitLayout
      railCollapsed={railCollapsed}
      onToggleRail={() => setRailCollapsed((c) => !c)}
      sidebar={
        <>
          {/* Traffic-light verdict — the primary "is this good?" signal, lifted
              out of the raw interpretation % meter. Tells the user whether to
              keep editing or commit. Detailed shape-match meter stays behind
              View Options for users who want the number. */}
          <div
            className={`mb-3 flex items-start gap-2 rounded-md border-2 px-3 py-2 text-[11px] leading-snug ${
              verdict.tone === "ready"
                ? "border-emerald-500/70 bg-emerald-50 text-emerald-900"
                : verdict.tone === "check"
                  ? "border-amber-400 bg-amber-50 text-amber-900"
                  : "border-red-400 bg-red-50 text-red-900"
            }`}
            role="status"
            aria-live="polite"
          >
            <span
              aria-hidden
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${
                verdict.tone === "ready"
                  ? "bg-emerald-500"
                  : verdict.tone === "check"
                    ? "bg-amber-500"
                    : "bg-red-500"
              }`}
            >
              {verdict.tone === "ready" ? "✓" : verdict.tone === "check" ? "!" : "×"}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={`block font-bebas tracking-[0.12em] ${
                  verdict.tone === "ready"
                    ? "text-emerald-800"
                    : verdict.tone === "check"
                      ? "text-amber-800"
                      : "text-red-800"
                }`}
              >
                {verdict.tone === "ready"
                  ? "READY TO RUN"
                  : verdict.tone === "check"
                    ? "CHECK THIS"
                    : "NOT YET"}
                <span className="ml-2 font-dm text-[11px] font-normal normal-case tracking-normal opacity-80">
                  {verdict.title}
                </span>
              </span>
              <span className="mt-0.5 block font-dm">{verdict.detail}</span>
            </span>
          </div>
          <div className="pace-highlight flex flex-col gap-1">
            <span className="font-bebas text-xs tracking-[0.12em] text-pace-yellow">
              Tune your route
            </span>
            <span className="font-dm text-[11px] leading-relaxed text-pace-muted">
              <strong className="text-pace-ink">Double-tap</strong> near the
              red line to add a handle · <strong className="text-pace-ink">Drag</strong>{" "}
              along the line to slide it · <strong className="text-pace-ink">Delete</strong>{" "}
              joins neighbours. Double-tap far away to route a detour there.{" "}
              {showArtControls ? (
                <>
                  <span className="text-emerald-600">Green dashed</span> = your
                  art. Toggle dots off for a clean preview.
                </>
              ) : (
                <>
                  Interpretation rewards the overall street read (like grid GPS
                  art); tight fit is stricter. Toggle dots off for a clean preview.
                </>
              )}
              {spurBusy ? (
                <span className="ml-1 font-medium text-pace-yellow">
                  Connecting…
                </span>
              ) : null}
            </span>
          </div>

          {deleteHint ? (
            <div
              className="mt-3 flex items-start gap-2 rounded-md border border-pace-blue/40 bg-pace-blue/5 px-2.5 py-2 text-[11px] leading-snug text-pace-ink"
              role="status"
              aria-live="polite"
            >
              <span aria-hidden className="mt-0.5 text-pace-blue">ℹ</span>
              <span>{deleteHint}</span>
            </div>
          ) : null}

          {spurLegIndices.length > 0 && !spurBusy ? (
            /* Straight-line "teleport" segments — Mapbox couldn't route them.
               Surface this so users fix it before exporting (otherwise the
               GPX has invisible chords that won't walk). */
            <div
              className="mt-3 flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-900"
              role="alert"
            >
              <span className="flex items-center gap-1.5 font-bebas text-[11px] tracking-[0.12em] text-amber-900">
                <span aria-hidden>⚠</span>
                {spurLegIndices.length} segment
                {spurLegIndices.length === 1 ? "" : "s"} not street-snapped
              </span>
              <span>
                Shown as amber dashed lines on the map. Mapbox couldn&apos;t
                route these — usually a transient hiccup.
              </span>
              <button
                type="button"
                onClick={resnapSpurLegs}
                className="mt-0.5 w-fit rounded border border-amber-400 bg-white px-2.5 py-1 font-bebas text-[11px] tracking-[0.12em] text-amber-900 transition hover:border-amber-600 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                ↻ Re-snap {spurLegIndices.length === 1 ? "this segment" : "all"}
              </button>
            </div>
          ) : null}

          <div className="mt-3 rounded-md border border-pace-line bg-pace-panel/60 px-2.5 py-2 font-dm text-[11px] leading-snug text-pace-muted">
            <span className="font-bebas text-[10px] tracking-[0.12em] text-pace-yellow">
              Keyboard
            </span>
            <p className="mt-1 text-pace-muted">
              <kbd className="rounded border border-pace-line bg-pace-white px-1 py-0.5 font-mono text-[10px] text-pace-ink">
                Delete
              </kbd>{" "}
              or{" "}
              <kbd className="rounded border border-pace-line bg-pace-white px-1 py-0.5 font-mono text-[10px] text-pace-ink">
                Backspace
              </kbd>{" "}
              — remove selected ·{" "}
              <kbd className="rounded border border-pace-line bg-pace-white px-1 py-0.5 font-mono text-[10px] text-pace-ink">
                Shift
              </kbd>
              + click — multi-select · Double-tap map — add waypoint
            </p>
          </div>

          <div className="mt-5 flex flex-col gap-4 border-t border-pace-line pt-4 text-sm">
            <button
              type="button"
              onClick={() => setMobileOptionsOpen((v) => !v)}
              aria-expanded={mobileOptionsOpen}
              className="flex items-center justify-between rounded-md border border-pace-line bg-pace-panel/60 px-3 py-2 font-bebas text-[11px] tracking-[0.14em] text-pace-ink transition hover:bg-pace-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow lg:hidden"
            >
              <span>View options · shape match</span>
              <span
                aria-hidden
                className={`transition-transform ${mobileOptionsOpen ? "rotate-180" : ""}`}
              >
                ▾
              </span>
            </button>
            <div
              className={`flex flex-col gap-3 ${mobileOptionsOpen ? "" : "hidden"} lg:flex`}
            >
              {/* Chip-style toggles in a 3-column grid so "Outline · Full snap ·
                  Dots" always fit on one row instead of wrapping. On/off is
                  carried by background color, not a separate switch widget —
                  the whole chip is the button, bigger touch target, less
                  horizontal budget spent. */}
              <div
                className={`grid gap-2 ${showArtControls ? "grid-cols-3" : "grid-cols-2"}`}
              >
                {showArtControls ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showOriginalArt}
                    aria-label="Toggle the green dashed overlay of your traced outline from Step 1"
                    title="Show the outline you traced in Step 1 on top of the route — for comparing shape vs. walkable path."
                    onClick={() => setShowOriginalArt((v) => !v)}
                    className={`flex min-h-[32px] items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 font-bebas text-[11px] tracking-[0.08em] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                      showOriginalArt
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-800"
                        : "border-pace-line bg-pace-white text-pace-muted hover:border-emerald-400 hover:text-pace-ink"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${showOriginalArt ? "bg-emerald-500" : "bg-pace-line"}`}
                    />
                    Outline
                  </button>
                ) : null}
                <button
                  type="button"
                  role="switch"
                  aria-checked={showFullSnapReference}
                  aria-label="Show full Mapbox snapped polyline behind your route"
                  title="Show the full original snap as a faint reference under your current route."
                  onClick={() => setShowFullSnapReference((v) => !v)}
                  className={`flex min-h-[32px] items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 font-bebas text-[11px] tracking-[0.08em] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow ${
                    showFullSnapReference
                      ? "border-pace-yellow bg-pace-yellow/15 text-pace-ink"
                      : "border-pace-line bg-pace-white text-pace-muted hover:border-pace-yellow hover:text-pace-ink"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${showFullSnapReference ? "bg-pace-yellow" : "bg-pace-line"}`}
                  />
                  Full snap
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={showWaypointDots}
                  aria-label="Show waypoint handles on the map"
                  title="Show the orange waypoint dots so you can drag or double-tap to edit the route."
                  onClick={() => setShowWaypointDots((v) => !v)}
                  className={`flex min-h-[32px] items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 font-bebas text-[11px] tracking-[0.08em] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-pace-blue/50 ${
                    showWaypointDots
                      ? "border-pace-blue bg-pace-blue/10 text-pace-ink"
                      : "border-pace-line bg-pace-white text-pace-muted hover:border-pace-blue hover:text-pace-ink"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${showWaypointDots ? "bg-pace-blue" : "bg-pace-line"}`}
                  />
                  Dots
                </button>
              </div>
              {showArtControls ? (
                <p className="font-dm text-[11px] leading-snug text-pace-muted">
                  The dashed <span className="text-emerald-600">green</span>{" "}
                  overlay is the outline you traced in Step 1 — a reference for
                  comparison, not part of the route. Bits that stick out from
                  the red line are places streets can&apos;t follow your shape
                  exactly; you can&apos;t edit those with waypoints. Toggle{" "}
                  <strong className="text-pace-ink">Traced outline</strong> off
                  if it&apos;s distracting.
                </p>
              ) : (
                <p className="font-dm text-[11px] leading-snug text-pace-muted">
                  Same idea as photo traces: we care how the route reads at
                  city scale, not every corner hugging the sketch.
                </p>
              )}
              <ShapeMatchMeter
                label={matchMeterLabel}
                percent={routeInterpretationPct}
                title={matchMeterTitle}
                secondaryPercent={routeTightFitPct}
                secondaryLabel="Tight fit"
                secondaryTitle={tightMeterTitle}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="tabular-nums text-pace-muted">
                {waypoints.length} pts
              </span>
              <button
                type="button"
                onClick={undo}
                disabled={!undoPast.length}
                aria-label={
                  undoPast.length
                    ? `Undo last edit (${undoPast.length} step${undoPast.length === 1 ? "" : "s"} available)`
                    : "Undo — nothing to undo yet"
                }
                title={
                  undoPast.length
                    ? `Undo (${undoPast.length} step${undoPast.length === 1 ? "" : "s"})`
                    : "Nothing to undo yet — edit a waypoint first"
                }
                className="min-h-[32px] rounded-full bg-pace-panel px-2 py-1 font-semibold text-pace-ink ring-1 ring-pace-line transition hover:bg-pace-line/80 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ↶ Undo
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={!redoFuture.length}
                aria-label={
                  redoFuture.length
                    ? `Redo last undone edit (${redoFuture.length} step${redoFuture.length === 1 ? "" : "s"} available)`
                    : "Redo — nothing to redo"
                }
                title={
                  redoFuture.length
                    ? `Redo (${redoFuture.length} step${redoFuture.length === 1 ? "" : "s"})`
                    : "Nothing to redo — undo something first"
                }
                className="min-h-[32px] rounded-full bg-pace-panel px-2 py-1 font-semibold text-pace-ink ring-1 ring-pace-line transition hover:bg-pace-line/80 disabled:cursor-not-allowed disabled:opacity-40"
              >
                ↷ Redo
              </button>
              <button
                type="button"
                onClick={() => void makeSelectedWaypointStart()}
                disabled={spurBusy || !canMakeStartingPoint}
                title={
                  shiftSelectedIndices.length > 1
                    ? "Select only one waypoint (Shift+click others off)"
                    : makeStartCandidateIndex === 0
                      ? "This point is already the start"
                      : "Rotate the route so the selected waypoint is first (same path, new beginning)"
                }
                className="rounded-full bg-pace-panel px-2 py-1 font-semibold text-pace-ink ring-1 ring-pace-line hover:bg-pace-line/80 disabled:opacity-40"
              >
                Set start
              </button>
              <button
                type="button"
                onClick={restart}
                className="rounded-full bg-pace-panel px-2 py-1 font-semibold text-pace-ink ring-1 ring-pace-line hover:bg-pace-line/80"
              >
                Reset
              </button>
              <div className="flex items-center gap-1 rounded-full border border-pace-line bg-pace-panel px-2 py-1">
                <span className="text-[11px] text-pace-muted">Zoom</span>
                <button
                  type="button"
                  className="rounded bg-pace-white px-1.5 text-xs font-bold text-pace-ink shadow-sm ring-1 ring-pace-line"
                  onClick={() => zoomBy(1)}
                >
                  +
                </button>
                <button
                  type="button"
                  className="rounded bg-pace-white px-1.5 text-xs font-bold text-pace-ink shadow-sm ring-1 ring-pace-line"
                  onClick={() => zoomBy(-1)}
                >
                  −
                </button>
              </div>
              <span
                className="font-semibold tabular-nums text-pace-ink"
                title="Distance · estimated time at your easy pace (edit on the final step)"
              >
                ~{formatDistance(distanceKm, runnerProfile.unit)}
                <span className="ml-1 text-pace-muted">
                  ·{" "}
                  {formatDuration(
                    estimateSeconds(distanceKm, runnerProfile.paceSecPerKm),
                  )}
                </span>
              </span>
            </div>
          </div>
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
            disabled={waypoints.length < 2}
            onClick={() =>
              onComplete({
                coordinates:
                  activeRouteLine.length >= 2
                    ? (activeRouteLine as [number, number][])
                    : (waypoints as [number, number][]),
                distanceMeters,
                blockWaypoints: waypoints as [number, number][],
              })
            }
            className="pace-toolbar-btn-primary flex-1 font-bebas tracking-[0.08em]"
          >
            Looks good →
          </button>
        </div>
      }
      map={
        <div className="relative h-full min-h-0 w-full">
          {quickTipsOpen ? (
            <div className="absolute inset-x-4 bottom-4 z-[500] max-w-sm rounded-xl border border-pace-line bg-pace-white/95 p-3 font-dm text-[11px] text-pace-muted shadow-lg backdrop-blur-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="font-bebas text-xs tracking-[0.12em] text-pace-yellow">
                  Quick tips
                </p>
                <button
                  type="button"
                  onClick={() => setQuickTipsOpen(false)}
                  className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 font-dm text-lg leading-none text-pace-muted transition hover:bg-pace-line/80 hover:text-pace-ink"
                  aria-label="Close quick tips"
                >
                  ×
                </button>
              </div>
              <p className="mt-1 leading-snug pr-1">
                Pick one dot, tap{" "}
                <strong className="text-pace-ink">Set start</strong> to rotate
                where the route begins (great for loops).{" "}
                <strong className="text-pace-ink">Shift+click</strong> for
                multi-select. <strong className="text-pace-ink">Delete</strong>{" "}
                removes selected and rebuilds the path.
              </p>
            </div>
          ) : null}

          <Step4LeafletMap
            center={center}
            fitBoundsStaticLine={fitBoundsStaticLine}
            fitBoundsFallbackLine={waypoints}
            streetLine={streetLine}
            showFaintFullStreet={showFaintFullStreet}
            activeRouteLine={activeRouteLine}
            originalArt={originalArt}
            showOriginalArt={showArtControls && showOriginalArt}
            legPolylines={legPolylines}
            spurLegIndices={spurLegIndices}
            showWaypoints={showWaypointDots}
            waypoints={waypoints}
            selectedWaypointIndex={selectedWaypointIndex}
            shiftSelectedIndices={shiftSelectedIndices}
            onClearSelection={clearRouteRangeSelection}
            onWaypointMarkerClick={handleWaypointMarkerClick}
            onWaypointDragEnd={handleWaypointDragEnd}
            onMapDoubleClickLatLng={handleMapDoubleClick}
            onMapReady={handleMapReady}
          />
        </div>
      }
    />
  );
}

function haversineMeters(a: Waypoint, b: Waypoint): number {
  return haversineMetersLatLng(a, b);
}

function polylineLengthMeters(coords: Waypoint[]): number {
  let m = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    m += haversineMeters(coords[i], coords[i + 1]);
  }
  return m;
}
