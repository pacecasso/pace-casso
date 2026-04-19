"use client";

import { useEffect } from "react";
import { useMap } from "react-leaflet";

/**
 * Call `invalidateSize` when the map container resizes (split layout, panel
 * toggle, orientation change).
 *
 * Hardened against unmount races: the `ResizeObserver` + `requestAnimationFrame`
 * chain can keep firing after the parent step has unmounted. Touching a
 * torn-down Leaflet map throws `Cannot read properties of undefined` on
 * `_leaflet_pos`. A cancelled flag + a rAF handle + try/catch around the
 * container read keeps the console clean.
 */
export default function LeafletInvalidateOnResize() {
  const map = useMap();
  useEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;

    let el: HTMLElement;
    try {
      el = map.getContainer();
    } catch {
      return;
    }

    const run = () => {
      if (cancelled) return;
      rafId = requestAnimationFrame(() => {
        if (cancelled) return;
        try {
          const container = map.getContainer();
          if (!container || !document.body.contains(container)) return;
          map.invalidateSize({ animate: false });
        } catch {
          // Map already torn down mid-frame — silent skip.
        }
      });
    };

    run();

    const ro = new ResizeObserver(run);
    ro.observe(el);
    window.addEventListener("orientationchange", run);

    return () => {
      cancelled = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener("orientationchange", run);
    };
  }, [map]);
  return null;
}
