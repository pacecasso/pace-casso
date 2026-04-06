/**
 * Public Mapbox token for Directions API (client-side).
 * Set NEXT_PUBLIC_MAPBOX_TOKEN in `.env.local` (local dev) or your host’s env (production).
 * Do not commit real tokens — GitHub push protection blocks pushes that contain them.
 */
export const MAPBOX_PUBLIC_TOKEN =
  process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? "";
