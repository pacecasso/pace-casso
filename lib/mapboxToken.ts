/**
 * Public Mapbox token when calling Mapbox directly from the browser.
 * Set `NEXT_PUBLIC_MAPBOX_TOKEN` in `.env.local` (local dev) or your host’s env (production).
 *
 * **Proxy mode:** set `NEXT_PUBLIC_MAPBOX_PROXY=1` and configure `MAPBOX_ACCESS_TOKEN`
 * on the server so requests go through `/api/mapbox/*` (rate limits + optional caching).
 * Do not commit real tokens — GitHub push protection blocks pushes that contain them.
 */
export const MAPBOX_PUBLIC_TOKEN =
  process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? "";
