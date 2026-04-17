/**
 * Mapbox token routing: direct public token vs same-origin API proxy (server token).
 */

export function mapboxUseProxy(): boolean {
  return (
    typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_MAPBOX_PROXY === "1"
  );
}

/** Client-side Mapbox token when not using the proxy (may be empty). */
export function mapboxPublicToken(): string {
  return process.env.NEXT_PUBLIC_MAPBOX_TOKEN?.trim() ?? "";
}
