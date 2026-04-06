"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import * as turf from "@turf/turf";
import { shapeAccuracyPercent } from "../lib/shapeMatchScore";
import type { Map as LeafletMap } from "leaflet";
import type { AnchorLocation, RouteLineString } from "./WorkflowController";
import { MAPBOX_PUBLIC_TOKEN } from "../lib/mapboxToken";
import MapChunkFallback from "./MapChunkFallback";
import MapStepSplitLayout from "./MapStepSplitLayout";

const Step4LeafletMap = dynamic(() => import("./Step4LeafletMap"), {
  ssr: false,
  loading: () => <MapChunkFallback className="h-full min-h-0" />,
});

type Waypoint = [number, number];

async function mapboxWalkingPolyline(
  from: Waypoint,
  to: Waypoint,
): Promise<Waypoint[]> {
  const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${from[1]},${from[0]};${to[1]},${to[0]}?geometries=geojson&overview=full&access_token=${MAPBOX_PUBLIC_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as {
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
  onBack,
  onComplete,
}: Props) {
  const [waypoints, setWaypoints] = useState<Waypoint[]>(() =>
    initialWaypoints(snappedRoute),
  );
  const [showOriginalArt, setShowOriginalArt] = useState(true);
  /** When off, hide full Mapbox polyline so stray tails past your waypoints disappear. */
  const [showFullSnapReference, setShowFullSnapReference] = useState(false);
  /** When off, hide orange waypoint handles to preview the final red route (and green art) only. */
  const [showWaypointDots, setShowWaypointDots] = useState(true);
  const [selectedWaypointIndex, setSelectedWaypointIndex] = useState<
    number | null
  >(null);
  /** Shift+click toggles indices; Delete removes all selected (or one). */
  const [shiftSelectedIndices, setShiftSelectedIndices] = useState<number[]>([]);
  /** Per-leg geometry when Mapbox spur replaces lineSlice (length = waypoints.length - 1). */
  const [legOverrides, setLegOverrides] = useState<(Waypoint[] | null)[]>([]);
  const [spurBusy, setSpurBusy] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [quickTipsOpen, setQuickTipsOpen] = useState(true);
  const [undoPast, setUndoPast] = useState<Waypoint[][]>([]);
  const [redoFuture, setRedoFuture] = useState<Waypoint[][]>([]);

  const mapRef = useRef<LeafletMap | null>(null);
  const waypointsRef = useRef(waypoints);
  const legOverridesRef = useRef(legOverrides);
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

  const routeMatchPct = useMemo(
    () => shapeAccuracyPercent(originalArt, streetLine),
    [originalArt, streetLine],
  );

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

  const legPolylines = useMemo(() => {
    if (waypoints.length < 2) return [];
    const legs: Waypoint[][] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const ov = legOverrides[i];
      if (ov && ov.length >= 2) {
        legs.push(ov);
      } else if (sequentialStreetLegs[i]?.length >= 2) {
        legs.push(sequentialStreetLegs[i]!);
      } else if (streetLine.length >= 2) {
        legs.push(greatCircleSpur(waypoints[i], waypoints[i + 1]));
      } else {
        legs.push(greatCircleSpur(waypoints[i], waypoints[i + 1]));
      }
    }
    return legs;
  }, [waypoints, legOverrides, streetLine, sequentialStreetLegs]);

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
    (next: Waypoint[], nextLegOverrides?: (Waypoint[] | null)[]) => {
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
      setSelectedWaypointIndex((sel) => adjustIndexAfterRemoval(sel, index));
      setShiftSelectedIndices((ids) =>
        adjustMultiSelectAfterRemoval(ids, index),
      );
      const next = wp.filter((_, i) => i !== index);
      commitWaypoints(orderWaypointsAlongLine(streetLine, next));
    },
    [commitWaypoints, streetLine],
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
        const newOv = new Array(nLegs).fill(null) as (Waypoint[] | null)[];

        let segWtoP: Waypoint[];
        try {
          segWtoP = await mapboxWalkingPolyline(W, P);
        } catch {
          segWtoP = greatCircleSpur(W, P);
        }
        newOv[nearestI] = segWtoP;

        if (nearestI < wp.length - 1) {
          const oldRight = wp[nearestI + 1];
          try {
            newOv[nearestI + 1] = await mapboxWalkingPolyline(P, oldRight);
          } catch {
            newOv[nearestI + 1] = greatCircleSpur(P, oldRight);
          }
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
      const ovs: Waypoint[][] = [];
      for (let i = 0; i < nL; i++) {
        const a = next[i];
        const b = next[i + 1];
        if (!a || !b) continue;
        try {
          ovs.push(await mapboxWalkingPolyline(a, b));
        } catch {
          ovs.push(greatCircleSpur(a, b));
        }
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
      const ovs: Waypoint[][] = [];
      for (let i = 0; i < nL; i++) {
        try {
          ovs.push(await mapboxWalkingPolyline(ordered[i], ordered[i + 1]));
        } catch {
          ovs.push(greatCircleSpur(ordered[i], ordered[i + 1]));
        }
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
      wp[index] = [lat, lng];

      const nLegs = Math.max(0, wp.length - 1);
      if (nLegs === 0) {
        commitWaypoints(wp);
        setShiftSelectedIndices([]);
        setSelectedWaypointIndex(index);
        return;
      }

      const prevOv = legOverridesRef.current;
      const nextOv: (Waypoint[] | null)[] = new Array(nLegs).fill(null);
      for (let i = 0; i < nLegs; i++) {
        if (i !== index - 1 && i !== index) {
          nextOv[i] = prevOv[i] ?? null;
        }
      }

      setSpurBusy(true);
      try {
        if (index > 0) {
          const from = wp[index - 1];
          const to = wp[index];
          try {
            nextOv[index - 1] = await mapboxWalkingPolyline(from, to);
          } catch {
            nextOv[index - 1] = greatCircleSpur(from, to);
          }
        }
        if (index < wp.length - 1) {
          const from = wp[index];
          const to = wp[index + 1];
          try {
            nextOv[index] = await mapboxWalkingPolyline(from, to);
          } catch {
            nextOv[index] = greatCircleSpur(from, to);
          }
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
          <div className="pace-highlight flex flex-col gap-1">
            <span className="font-bebas text-xs tracking-[0.12em] text-pace-yellow">
              Tune your route
            </span>
            <span className="font-dm text-[11px] leading-relaxed text-pace-muted">
              <strong className="text-pace-ink">Double-tap</strong> the map to
              add a waypoint · <strong className="text-pace-ink">Drag</strong>{" "}
              dots · <strong className="text-pace-ink">Shift+click</strong>{" "}
              multi-select · <strong className="text-pace-ink">Delete</strong> key
              removes selected.{" "}
              <span className="text-emerald-600">Green dashed</span> = your art.
              Toggle dots off for a clean preview.
              {spurBusy ? (
                <span className="ml-1 font-medium text-pace-yellow">
                  Connecting…
                </span>
              ) : null}
            </span>
          </div>

          <div className="mt-3 rounded-md border border-pace-line bg-pace-panel/60 px-2.5 py-2 font-dm text-[10px] leading-snug text-pace-muted">
            <span className="font-bebas text-[9px] tracking-[0.12em] text-pace-yellow">
              Keyboard
            </span>
            <p className="mt-1 text-pace-muted">
              <kbd className="rounded border border-pace-line bg-pace-white px-1 py-0.5 font-mono text-[9px] text-pace-ink">
                Delete
              </kbd>{" "}
              or{" "}
              <kbd className="rounded border border-pace-line bg-pace-white px-1 py-0.5 font-mono text-[9px] text-pace-ink">
                Backspace
              </kbd>{" "}
              — remove selected ·{" "}
              <kbd className="rounded border border-pace-line bg-pace-white px-1 py-0.5 font-mono text-[9px] text-pace-ink">
                Shift
              </kbd>
              + click — multi-select · Double-tap map — add waypoint
            </p>
          </div>

          <div className="mt-4 flex flex-col gap-2 border-t border-pace-line pt-4">
            <button type="button" onClick={onBack} className="pace-toolbar-btn">
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
              className="pace-toolbar-btn-primary font-bebas tracking-[0.08em]"
            >
              Looks good →
            </button>
          </div>

          <div className="mt-5 flex flex-col gap-4 border-t border-pace-line pt-4 text-sm">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-3">
                  <span className="font-bebas text-[10px] tracking-[0.12em] text-pace-muted">
                    Your art
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showOriginalArt}
                    aria-label="Toggle original artwork overlay"
                    onClick={() => setShowOriginalArt((v) => !v)}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                      showOriginalArt ? "bg-emerald-500" : "bg-pace-line"
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 block h-5 w-5 rounded-full bg-pace-white shadow transition-transform ${
                        showOriginalArt ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bebas text-[10px] tracking-[0.12em] text-pace-muted">
                    Full snap
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showFullSnapReference}
                    aria-label="Show full Mapbox snapped polyline behind your route"
                    onClick={() => setShowFullSnapReference((v) => !v)}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow ${
                      showFullSnapReference ? "bg-pace-yellow" : "bg-pace-line"
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 block h-5 w-5 rounded-full bg-pace-white shadow transition-transform ${
                        showFullSnapReference ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bebas text-[10px] tracking-[0.12em] text-pace-muted">
                    Dots
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showWaypointDots}
                    aria-label="Show waypoint handles on the map"
                    onClick={() => setShowWaypointDots((v) => !v)}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-pace-blue/50 ${
                      showWaypointDots ? "bg-pace-blue" : "bg-pace-line"
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 block h-5 w-5 rounded-full bg-pace-white shadow transition-transform ${
                        showWaypointDots ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>
              <div className="min-w-0 w-full">
                <div className="mb-1 flex items-center justify-between gap-2 font-bebas text-[10px] tracking-[0.12em] text-pace-muted">
                  <span>Match to art</span>
                  <span className="tabular-nums text-pace-ink">
                    {routeMatchPct}%
                  </span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-pace-line"
                  title="How closely the street route follows your outline."
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-pace-yellow via-emerald-400 to-emerald-500 transition-[width] duration-300"
                    style={{ width: `${routeMatchPct}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="tabular-nums text-pace-muted">
                {waypoints.length} pts
              </span>
              <button
                type="button"
                onClick={undo}
                disabled={!undoPast.length}
                className="rounded-full bg-pace-panel px-2 py-1 font-semibold text-pace-ink ring-1 ring-pace-line hover:bg-pace-line/80 disabled:opacity-40"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={!redoFuture.length}
                className="rounded-full bg-pace-panel px-2 py-1 font-semibold text-pace-ink ring-1 ring-pace-line hover:bg-pace-line/80 disabled:opacity-40"
              >
                Redo
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
                <span className="text-[10px] text-pace-muted">Zoom</span>
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
              <span className="font-semibold tabular-nums text-pace-ink">
                ~{distanceKm.toFixed(2)} km
              </span>
            </div>
          </div>
        </>
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
            showOriginalArt={showOriginalArt}
            legPolylines={legPolylines}
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
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function polylineLengthMeters(coords: Waypoint[]): number {
  let m = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    m += haversineMeters(coords[i], coords[i + 1]);
  }
  return m;
}
