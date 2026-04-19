import { mapboxPublicToken, mapboxUseProxy } from "./mapboxAccess";
import { encodePolyline } from "./polylineEncode";

/**
 * Client-side helpers for Mapbox Static Images with a route path overlay.
 * Used by the top-5 preview tiles and by the composite grid the vision ranker
 * looks at. A real map backdrop (streets + water + parks) under the route is
 * what lets Claude reject candidates that cross rivers or sit in parks.
 */

const DEFAULT_STYLE = "light-v11";

type StaticMapOptions = {
  size?: number;
  style?: "light-v11" | "streets-v12" | "outdoors-v12";
};

export function buildRouteStaticMapUrl(
  route: [number, number][],
  options: StaticMapOptions = {},
): string | null {
  if (route.length < 2) return null;
  const size = options.size ?? 256;
  const style = options.style ?? DEFAULT_STYLE;
  const encoded = encodePolyline(route);

  if (mapboxUseProxy()) {
    const params = new URLSearchParams({
      encoded,
      size: String(size),
      style,
    });
    return `/api/mapbox/static-map?${params.toString()}`;
  }

  const token = mapboxPublicToken();
  if (!token) return null;
  const path = `path-4+e60000(${encodeURIComponent(encoded)})`;
  return `https://api.mapbox.com/styles/v1/mapbox/${style}/static/${path}/auto/${size}x${size}?padding=12&access_token=${token}`;
}

/**
 * Load the static map as an HTMLImageElement so it can be drawn onto a canvas
 * (for the composite grid). Returns null on any failure — caller should fall
 * back to an outline-only tile.
 */
export function loadRouteStaticMapImage(
  route: [number, number][],
  options: StaticMapOptions = {},
): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = buildRouteStaticMapUrl(route, options);
    if (!url) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
