"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";

/** Call invalidateSize when the map container is resized (split layout, panel toggle, etc.). */
export default function LeafletInvalidateOnResize() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const run = () => {
      requestAnimationFrame(() => map.invalidateSize({ animate: false }));
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(el);
    window.addEventListener("orientationchange", run);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", run);
    };
  }, [map]);
  return null;
}
