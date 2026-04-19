import { useState } from "react";

/**
 * Stable-per-mount unique id for a Leaflet `MapContainer`.
 *
 * React Strict Mode double-mounts components in development — Leaflet
 * interprets the second mount as trying to initialise a map on a DOM node that
 * is already an active map, and throws "Map container is being reused by
 * another instance." Giving each mount a fresh, unique id sidesteps the
 * collision entirely.
 */
export function useLeafletContainerId(): string {
  const [id] = useState(
    () => `lmap-${Math.random().toString(36).slice(2, 10)}`,
  );
  return id;
}
