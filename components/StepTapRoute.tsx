"use client";

/**
 * Manual drawing, onthegomap-style: tap the map and each new leg follows
 * walkable streets from the last point. Drag a point to move it, drag the
 * line to bend it, right-click / long-press for per-point and per-leg
 * options, switch to the ruler for straight lines. Distance and run time
 * update live in the corner.
 *
 * The route is points + one mode per leg (lib/tapRoute); leg geometry lives
 * in a cache keyed by (from, to, mode), so undo/redo never refetches a leg
 * it has already routed and a late fetch can never overwrite a newer edit.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Map as LeafletMap, LeafletMouseEvent } from "leaflet";
import { fetchMapboxWalkingDirectionsJson } from "../lib/mapboxClient";
import {
  EMPTY_TAP_ROUTE,
  addPoint,
  assembleLegs,
  closeLoop,
  insertPoint,
  isClosedLoop,
  joinLegs,
  legCount,
  lineLengthMeters,
  missingStreetLegs,
  movePoint,
  outAndBack,
  removeLastPoint,
  removePoint,
  reverseRoute,
  setLegMode,
  type LatLng,
  type LegGeometry,
  type LegMode,
  type TapRouteState,
} from "../lib/tapRoute";
import { useRunnerProfile } from "../lib/runnerProfile";
import MapChunkFallback from "./MapChunkFallback";
import MapStepSplitLayout from "./MapStepSplitLayout";
import type { RouteContextRequest } from "./routeMap/RouteMapLayers";
import {
  DistanceBadge,
  Icons,
  isTypingTarget,
  MapPill,
  PillButton,
  RouteContextMenu,
  type ContextMenuItem,
} from "./routeMap/RouteMapChrome";

const StepTapRouteMap = dynamic(() => import("./StepTapRouteMap"), {
  ssr: false,
  loading: () => <MapChunkFallback className="h-full min-h-0" />,
});

const HISTORY_LIMIT = 200;

async function routeWalkingLeg(from: LatLng, to: LatLng): Promise<LegGeometry> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    try {
      const data = (await fetchMapboxWalkingDirectionsJson({
        coordinates: [from, to],
        steps: false,
        overview: "full",
      })) as { routes?: { geometry?: { coordinates?: [number, number][] } }[] };
      const coords = data.routes?.[0]?.geometry?.coordinates;
      if (coords && coords.length >= 2) {
        return { coords: coords.map(([lng, lat]) => [lat, lng] as LatLng), fallback: false };
      }
    } catch {
      /* retry */
    }
  }
  return { coords: [from, to], fallback: true };
}

export type TapRouteResult = {
  route: TapRouteState;
  coordinates: [number, number][];
  distanceMeters: number;
};

type Props = {
  defaultCenter: [number, number];
  initialRoute?: TapRouteState | null;
  onBack: () => void;
  onSwitchToSketch?: () => void;
  onComplete: (r: TapRouteResult) => void;
};

export default function StepTapRoute({
  defaultCenter,
  initialRoute,
  onBack,
  onSwitchToSketch,
  onComplete,
}: Props) {
  const [route, setRoute] = useState<TapRouteState>(initialRoute ?? EMPTY_TAP_ROUTE);
  const [past, setPast] = useState<TapRouteState[]>([]);
  const [future, setFuture] = useState<TapRouteState[]>([]);
  const [mode, setMode] = useState<LegMode>("streets");
  const [selected, setSelected] = useState<number | null>(null);
  const [menu, setMenu] = useState<RouteContextRequest | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [profile, setProfile] = useRunnerProfile();

  // Leg geometry cache; `cacheVersion` re-renders when a fetch lands.
  const cacheRef = useRef(new Map<string, LegGeometry>());
  const inFlightRef = useRef(new Set<string>());
  const [cacheVersion, setCacheVersion] = useState(0);
  const mapRef = useRef<LeafletMap | null>(null);
  const menuClosedAtRef = useRef(0);
  const routeRef = useRef(route);
  routeRef.current = route;

  const commit = useCallback((next: TapRouteState) => {
    const cur = routeRef.current;
    if (next === cur) return;
    setPast((p) => [...p.slice(-HISTORY_LIMIT + 1), cur]);
    setFuture([]);
    setRoute(next);
    setSelected(null);
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      const prev = p[p.length - 1]!;
      setFuture((f) => [routeRef.current, ...f]);
      setRoute(prev);
      setSelected(null);
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0]!;
      setPast((p) => [...p, routeRef.current]);
      setRoute(next);
      setSelected(null);
      return f.slice(1);
    });
  }, []);

  // Route every street leg the cache does not have yet.
  useEffect(() => {
    const todo = missingStreetLegs(route, cacheRef.current).filter(
      (l) => !inFlightRef.current.has(l.key),
    );
    for (const leg of todo) {
      inFlightRef.current.add(leg.key);
      void routeWalkingLeg(leg.from, leg.to).then((geom) => {
        inFlightRef.current.delete(leg.key);
        cacheRef.current.set(leg.key, geom);
        setCacheVersion((v) => v + 1);
      });
    }
  }, [route]);

  const legs = useMemo(
    () => assembleLegs(route, cacheRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [route, cacheVersion],
  );
  const line = useMemo(() => joinLegs(legs), [legs]);
  const meters = useMemo(() => lineLengthMeters(line), [line]);
  const pending = legs.some((l) => l.pending);
  const fallbackCount = legs.filter((l) => l.fallback).length;
  const mapLegs = useMemo(
    () =>
      legs.map((l) => ({
        coords: l.coords,
        pending: l.pending,
        fallback: l.fallback,
        straight: l.mode === "straight",
      })),
    [legs],
  );

  const fitRoute = useCallback(() => {
    const m = mapRef.current;
    if (!m || line.length < 2) return;
    m.fitBounds(line.map(([a, b]) => [a, b] as [number, number]), {
      padding: [60, 60],
      maxZoom: 17,
    });
  }, [line]);

  // Reopening a saved route: frame it once the map exists.
  const didInitialFit = useRef(false);
  const handleMapReady = useCallback(
    (m: LeafletMap) => {
      mapRef.current = m;
      if (!didInitialFit.current && (initialRoute?.points.length ?? 0) >= 2) {
        didInitialFit.current = true;
        m.fitBounds(initialRoute!.points.map(([a, b]) => [a, b] as [number, number]), {
          padding: [60, 60],
          maxZoom: 17,
          animate: false,
        });
      }
    },
    [initialRoute],
  );

  const locate = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => mapRef.current?.setView([pos.coords.latitude, pos.coords.longitude], 16),
      () => {},
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);

  const toggleUnit = useCallback(() => {
    setProfile({ ...profile, unit: profile.unit === "mi" ? "km" : "mi" });
  }, [profile, setProfile]);

  const handleMapClick = useCallback(
    (at: LatLng, e: LeafletMouseEvent) => {
      // A click that only dismissed the menu must not also add a point.
      if (menu || Date.now() - menuClosedAtRef.current < 400) return;
      const oe = e.originalEvent;
      // Ctrl / Cmd flips the mode for one leg (onthegomap's control-click).
      const flip = Boolean(oe && (oe.ctrlKey || oe.metaKey));
      const legMode: LegMode = flip ? (mode === "streets" ? "straight" : "streets") : mode;
      commit(addPoint(routeRef.current, at, legMode));
    },
    [commit, menu, mode],
  );

  const handlePointClick = useCallback(
    (index: number, e: LeafletMouseEvent) => {
      const r = routeRef.current;
      if (e.originalEvent?.shiftKey) {
        commit(removePoint(r, index));
        return;
      }
      // Tapping the start closes the loop, like routing "back to here".
      if (index === 0 && r.points.length >= 3 && !isClosedLoop(r)) {
        commit(closeLoop(r, mode));
        return;
      }
      setSelected((s) => (s === index ? null : index));
    },
    [commit, mode],
  );

  const handlePointDragEnd = useCallback(
    (index: number, to: LatLng) => {
      const r = routeRef.current;
      // A closed loop's start and finish are the same place: move both.
      if (isClosedLoop(r) && (index === 0 || index === r.points.length - 1)) {
        commit(movePoint(movePoint(r, 0, to), r.points.length - 1, to));
        return;
      }
      commit(movePoint(r, index, to));
    },
    [commit],
  );

  const handleLineDragInsert = useCallback(
    (legIndex: number, _from: LatLng, to: LatLng) => {
      commit(insertPoint(routeRef.current, legIndex, to));
    },
    [commit],
  );

  const removeSelectedOrLast = useCallback(() => {
    const r = routeRef.current;
    if (selected !== null) commit(removePoint(r, selected));
    else commit(removeLastPoint(r));
  }, [commit, selected]);

  // Keyboard shortcuts (onthegomap's set where it applies).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if ((mod && k === "z" && e.shiftKey) || (!mod && k === "y") || (mod && k === "y")) {
        e.preventDefault();
        redo();
      } else if (k === "z") {
        e.preventDefault();
        undo();
      } else if (k === "delete" || k === "backspace") {
        e.preventDefault();
        removeSelectedOrLast();
      } else if (mod) {
        return;
      } else if (k === "f") {
        fitRoute();
      } else if (k === "u") {
        toggleUnit();
      } else if (k === "r") {
        setMode((m) => (m === "streets" ? "straight" : "streets"));
      } else if (k === "v") {
        commit(reverseRoute(routeRef.current));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, fitRoute, redo, removeSelectedOrLast, toggleUnit, undo]);

  const menuItems = useMemo((): ContextMenuItem[] => {
    if (!menu) return [];
    const r = route;
    if (menu.target.kind === "point") {
      const i = menu.target.index;
      const incoming = i > 0 ? r.modes[i - 1] : undefined;
      const items: ContextMenuItem[] = [];
      if (incoming) {
        items.push(
          {
            label: "Follow streets to here",
            icon: Icons.walk,
            checked: incoming === "streets",
            onSelect: () => commit(setLegMode(routeRef.current, i - 1, "streets")),
          },
          {
            label: "Straight line to here",
            icon: Icons.ruler,
            checked: incoming === "straight",
            onSelect: () => commit(setLegMode(routeRef.current, i - 1, "straight")),
          },
        );
      }
      if (i === r.points.length - 1 && r.points.length >= 3 && !isClosedLoop(r)) {
        items.push({
          label: "Route back to start",
          icon: Icons.loop,
          onSelect: () => commit(closeLoop(routeRef.current, mode)),
        });
      }
      items.push({
        label: "Remove point",
        icon: Icons.clear,
        onSelect: () => commit(removePoint(routeRef.current, i)),
      });
      return items;
    }
    const { legIndex, at } = menu.target;
    const legMode = r.modes[legIndex];
    return [
      {
        label: "Add point here",
        icon: Icons.dots,
        onSelect: () => commit(insertPoint(routeRef.current, legIndex, at)),
      },
      {
        label: "Follow streets",
        icon: Icons.walk,
        checked: legMode === "streets",
        onSelect: () => commit(setLegMode(routeRef.current, legIndex, "streets")),
      },
      {
        label: "Straight line",
        icon: Icons.ruler,
        checked: legMode === "straight",
        onSelect: () => commit(setLegMode(routeRef.current, legIndex, "straight")),
      },
    ];
  }, [menu, route, commit, mode]);

  const closeMenu = useCallback(() => {
    menuClosedAtRef.current = Date.now();
    setMenu(null);
  }, []);

  const canFinish = line.length >= 2 && !pending;
  const handleDone = useCallback(() => {
    if (!canFinish) return;
    onComplete({
      route: routeRef.current,
      coordinates: line.map(([a, b]) => [a, b] as [number, number]),
      distanceMeters: Math.round(meters),
    });
  }, [canFinish, line, meters, onComplete]);

  const nPoints = route.points.length;

  return (
    <MapStepSplitLayout
      railCollapsed={railCollapsed}
      onToggleRail={() => setRailCollapsed((c) => !c)}
      sidebar={
        <>
          <div className="pace-highlight flex flex-col gap-0.5">
            <span className="font-bebas text-xs tracking-[0.12em] text-pace-yellow">
              Draw your route
            </span>
            <span className="font-dm text-[11px] leading-snug text-pace-muted">
              Tap the map to add points. Each new leg follows walkable streets
              from your last point.
            </span>
          </div>
          <ul className="mt-3 space-y-1.5 font-dm text-[12px] leading-snug text-pace-ink/80">
            <li>
              <strong className="text-pace-ink">Drag a point</strong> to move it.{" "}
              <strong className="text-pace-ink">Drag the line</strong> to bend it.
            </li>
            <li>
              <strong className="text-pace-ink">Right-click</strong> (long-press
              on a phone) a point or the line for more options.
            </li>
            <li>
              Switch to the <strong className="text-pace-ink">ruler</strong> at
              the top of the map, or hold Ctrl while you tap, for a straight line.
            </li>
            <li>
              Tap the <span className="font-semibold text-green-700">green start</span>{" "}
              to close the loop.
            </li>
          </ul>
          {fallbackCount > 0 ? (
            <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 font-dm text-[11px] text-amber-900">
              {fallbackCount} leg{fallbackCount === 1 ? "" : "s"} couldn&apos;t
              find streets and {fallbackCount === 1 ? "is" : "are"} drawn straight
              (amber dashes). Move the nearby points onto a street.
            </p>
          ) : null}
          <p className="mt-3 hidden font-dm text-[10px] text-pace-muted lg:block">
            Keys: Z undo · Y redo · Del remove point · R ruler · V reverse · F fit · U km/mi
          </p>
          {onSwitchToSketch ? (
            <button
              type="button"
              onClick={onSwitchToSketch}
              className="mt-3 font-dm text-[11px] font-semibold text-pace-blue underline-offset-2 hover:underline"
            >
              Rather sketch it freehand?
            </button>
          ) : null}
        </>
      }
      sidebarFooter={
        <div className="flex gap-2">
          <button type="button" onClick={onBack} className="pace-toolbar-btn px-3 py-2">
            Back
          </button>
          <button
            type="button"
            disabled={!canFinish}
            onClick={handleDone}
            className="pace-toolbar-btn-primary flex-1 px-3 py-2 font-bebas tracking-[0.08em] disabled:opacity-40"
          >
            {pending ? "Routing…" : nPoints < 2 ? "Tap the map to start" : "Done — export →"}
          </button>
        </div>
      }
      map={
        <div className="relative h-full min-h-0 w-full">
          <StepTapRouteMap
            center={defaultCenter}
            legs={mapLegs}
            line={line}
            points={route.points}
            selectedIndex={selected}
            unit={profile.unit}
            onMapReady={handleMapReady}
            onMapClick={handleMapClick}
            onPointClick={handlePointClick}
            onPointDragEnd={handlePointDragEnd}
            onLineDragInsert={handleLineDragInsert}
            onContextMenu={setMenu}
          />

          <MapPill className={`top-3 ${railCollapsed ? "left-3 lg:left-[7.25rem]" : "left-3"}`}>
            <PillButton label="Clear route" onClick={() => commit(EMPTY_TAP_ROUTE)} disabled={!nPoints}>
              {Icons.clear}
            </PillButton>
            <PillButton label="Undo" shortcut="Z" onClick={undo} disabled={!past.length}>
              {Icons.undo}
            </PillButton>
            <PillButton label="Redo" shortcut="Y" onClick={redo} disabled={!future.length}>
              {Icons.redo}
            </PillButton>
            <PillButton
              label="Reverse direction"
              shortcut="V"
              onClick={() => commit(reverseRoute(route))}
              disabled={legCount(route) < 1}
            >
              {Icons.reverse}
            </PillButton>
            <PillButton
              label="Out and back"
              onClick={() => commit(outAndBack(route))}
              disabled={legCount(route) < 1}
            >
              {Icons.outBack}
            </PillButton>
            <PillButton
              label="Close the loop"
              onClick={() => commit(closeLoop(route, mode))}
              disabled={nPoints < 3 || isClosedLoop(route)}
            >
              {Icons.loop}
            </PillButton>
          </MapPill>

          <MapPill className="left-1/2 top-3 -translate-x-1/2 max-sm:left-auto max-sm:right-3 max-sm:translate-x-0">
            <PillButton
              label="Follow streets"
              shortcut="R"
              active={mode === "streets"}
              onClick={() => setMode("streets")}
            >
              {Icons.walk}
            </PillButton>
            <PillButton
              label="Straight line"
              shortcut="R"
              active={mode === "straight"}
              onClick={() => setMode("straight")}
            >
              {Icons.ruler}
            </PillButton>
          </MapPill>

          <MapPill className="bottom-3 left-3">
            <PillButton label="Fit route to screen" shortcut="F" onClick={fitRoute} disabled={line.length < 2}>
              {Icons.fit}
            </PillButton>
            <PillButton label="Find your location" onClick={locate}>
              {Icons.locate}
            </PillButton>
          </MapPill>

          <MapPill className="bottom-[5.25rem] right-3 flex-col max-sm:hidden">
            <PillButton label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
              <span className="text-lg leading-none">+</span>
            </PillButton>
            <PillButton label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
              <span className="text-lg leading-none">−</span>
            </PillButton>
          </MapPill>

          <DistanceBadge
            meters={meters}
            profile={profile}
            onToggleUnit={toggleUnit}
            busy={pending}
          />

          {nPoints === 0 ? (
            <div className="pointer-events-none absolute left-1/2 top-16 z-[1000] -translate-x-1/2 rounded-full bg-pace-ink/80 px-3 py-1.5 font-dm text-xs font-semibold text-white shadow">
              Tap the map to place your start
            </div>
          ) : null}

          {menu ? (
            <RouteContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
          ) : null}
        </div>
      }
    />
  );
}
