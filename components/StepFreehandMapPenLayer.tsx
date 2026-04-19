"use client";

import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

/** Second tap within this window (ms) and slop (px) counts as double-tap anchor (touch/pen). */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 38;

type Props = {
  mode: "draw" | "pan";
  onStrokeStart: (lat: number, lng: number) => void;
  onStrokePoint: (lat: number, lng: number) => void;
  onStrokeEnd: () => void;
  onDoubleClickAnchor: (lat: number, lng: number) => void;
};

/**
 * Pointer capture only in draw mode. Each pointer gesture is one stroke (no linking strokes).
 */
export default function StepFreehandMapPenLayer({
  mode,
  onStrokeStart,
  onStrokePoint,
  onStrokeEnd,
  onDoubleClickAnchor,
}: Props) {
  const map = useMap();
  const startRef = useRef(onStrokeStart);
  const pointRef = useRef(onStrokePoint);
  const endRef = useRef(onStrokeEnd);
  const anchorRef = useRef(onDoubleClickAnchor);
  startRef.current = onStrokeStart;
  pointRef.current = onStrokePoint;
  endRef.current = onStrokeEnd;
  anchorRef.current = onDoubleClickAnchor;

  useEffect(() => {
    const el = map.getContainer();
    if (mode === "pan") {
      el.style.touchAction = "";
      map.dragging.enable();
      map.doubleClickZoom?.enable();
      return;
    }

    // On mobile, the browser's native touch handling interprets a single-
    // finger drag as a pan BEFORE Leaflet's pointer listeners get to decide
    // otherwise. `touch-action: pinch-zoom` tells the browser: no native pan
    // or tap-zoom on single-finger gestures (we handle those with JS), but
    // keep two-finger pinch-zoom working for the user to zoom the map.
    el.style.touchAction = "pinch-zoom";
    map.dragging.disable();
    /** Prop `doubleClickZoom={mode === "pan"}` on MapContainer often does not update after mount. */
    map.doubleClickZoom?.disable();
    let drawing = false;
    let lastTapT = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    const toLatLng = (ev: PointerEvent) =>
      map.mouseEventToLatLng(ev as unknown as MouseEvent);

    const toLatLngMouse = (ev: MouseEvent) => map.mouseEventToLatLng(ev);

    /**
     * Chromium often leaves `PointerEvent.detail` at 0 on pointerdown, so double-click
     * anchors must use the native `dblclick` event (capture). The second
     * pointerdown may start a one-point stroke; pointerup trims it before the
     * anchor is applied.
     */
    const onDblClickCapture = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const ll = toLatLngMouse(ev);
      anchorRef.current(ll.lat, ll.lng);
    };
    el.addEventListener("dblclick", onDblClickCapture, true);

    const onDown = (ev: PointerEvent) => {
      if (ev.pointerType === "mouse" && ev.button !== 0) return;

      /** Reliable fallback: Shift+click drops an anchor (detail on pointerdown is unreliable). */
      if (ev.shiftKey && ev.pointerType === "mouse") {
        const ll = toLatLng(ev);
        anchorRef.current(ll.lat, ll.lng);
        return;
      }

      if (ev.pointerType === "touch" || ev.pointerType === "pen") {
        const now = Date.now();
        const dx = ev.clientX - lastTapX;
        const dy = ev.clientY - lastTapY;
        if (
          now - lastTapT < DOUBLE_TAP_MS &&
          dx * dx + dy * dy < DOUBLE_TAP_PX * DOUBLE_TAP_PX
        ) {
          lastTapT = 0;
          const ll = toLatLng(ev);
          anchorRef.current(ll.lat, ll.lng);
          return;
        }
        lastTapT = now;
        lastTapX = ev.clientX;
        lastTapY = ev.clientY;
      }

      // Stop the browser from interpreting this as a pan / scroll, and stop
      // Leaflet's pre-registered listeners (tap, drag start) from racing us.
      // Only safe to preventDefault() for touch/pen; mouse-preventDefault
      // kills focus/click behaviour elsewhere on the page.
      if (ev.pointerType !== "mouse") {
        ev.preventDefault();
      }
      ev.stopPropagation();

      drawing = true;
      try {
        el.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      const ll = toLatLng(ev);
      startRef.current(ll.lat, ll.lng);
    };

    const onMove = (ev: PointerEvent) => {
      if (!drawing) return;
      if (ev.pointerType !== "mouse") {
        ev.preventDefault();
      }
      const ll = toLatLng(ev);
      pointRef.current(ll.lat, ll.lng);
    };

    const end = (ev: PointerEvent) => {
      if (!drawing) return;
      drawing = false;
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      endRef.current();
    };

    // Capture phase + passive:false so preventDefault() actually blocks the
    // browser's native touch handling. Leaflet registers bubble-phase tap /
    // drag listeners; we run first and stop propagation when we claim the
    // gesture for drawing.
    const opts: AddEventListenerOptions = { capture: true, passive: false };
    el.addEventListener("pointerdown", onDown, opts);
    el.addEventListener("pointermove", onMove, opts);
    el.addEventListener("pointerup", end, opts);
    el.addEventListener("pointercancel", end, opts);

    return () => {
      el.style.touchAction = "";
      el.removeEventListener("dblclick", onDblClickCapture, true);
      el.removeEventListener("pointerdown", onDown, opts);
      el.removeEventListener("pointermove", onMove, opts);
      el.removeEventListener("pointerup", end, opts);
      el.removeEventListener("pointercancel", end, opts);
      map.dragging.enable();
      map.doubleClickZoom?.enable();
    };
  }, [mode, map]);

  return null;
}
