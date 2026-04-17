/**
 * Server-only Mapbox token for `/api/mapbox/*` routes.
 * Prefer `MAPBOX_ACCESS_TOKEN` (secret); fall back to `NEXT_PUBLIC_MAPBOX_TOKEN` for local dev.
 */
export function getServerMapboxToken(): string | null {
  const secret = process.env.MAPBOX_ACCESS_TOKEN?.trim();
  if (secret) return secret;
  return process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? null;
}
