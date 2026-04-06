"use client";

import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

type Props = {
  mode: "draw" | "pan";
  onStrokeStart: (lat: number, lng: number) => void;
  onStrokePoint: (lat: number, lng: number) => void;
  onStrokeEnd: () => void;
};

/**
 * Pointer capture only in draw mode. Each pointer gesture is one stroke (no linking strokes).
 */
export default function StepFreehandMapPenLayer({
  mode,
  onStrokeStart,
  onStrokePoint,
  onStrokeEnd,
}: Props) {
  const map = useMap();
  const startRef = useRef(onStrokeStart);
  const pointRef = useRef(onStrokePoint);
  const endRef = useRef(onStrokeEnd);
  startRef.current = onStrokeStart;
  pointRef.current = onStrokePoint;
  endRef.current = onStrokeEnd;

  useEffect(() => {
    const el = map.getContainer();
    if (mode === "pan") {
      map.dragging.enable();
      return;
    }

    map.dragging.disable();
    let drawing = false;

    const toLatLng = (ev: PointerEvent) =>
      map.mouseEventToLatLng(ev as unknown as MouseEvent);

    const onDown = (ev: PointerEvent) => {
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
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

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      map.dragging.enable();
    };
  }, [mode, map]);

  return null;
}
