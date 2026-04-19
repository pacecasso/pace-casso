/**
 * Client-side Canvas rendering for candidate GPS routes.
 *
 * Used in two places:
 * 1. The composite grid image sent to Claude vision for ranking.
 * 2. The small preview thumbnails shown to the user for the top-5 picks.
 *
 * No map backdrop — shape-only. The vision ranker compares gestalt of the
 * route outline against the reference image; map tiles would just add noise.
 */

type RenderOptions = {
  background?: string;
  stroke?: string;
  lineWidth?: number;
  padding?: number;
};

const DEFAULT_TILE = 256;
const DEFAULT_PADDING = 10;

/**
 * Draw a route polyline into a rectangular region of an existing canvas context.
 * Coords are `[lat, lng]`. Lat maps to Y (inverted — north is up).
 */
export function renderRouteOnCanvas(
  ctx: CanvasRenderingContext2D,
  route: [number, number][],
  x: number,
  y: number,
  w: number,
  h: number,
  options: RenderOptions = {},
): void {
  const pad = options.padding ?? DEFAULT_PADDING;
  const bg = options.background ?? "#ffffff";
  const stroke = options.stroke ?? "#111111";
  const lineWidth = options.lineWidth ?? 2.5;

  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);

  if (route.length < 2) return;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of route) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const latSpan = maxLat - minLat || 1e-6;
  const lngSpan = maxLng - minLng || 1e-6;
  const drawW = w - 2 * pad;
  const drawH = h - 2 * pad;
  const scale = Math.min(drawW / lngSpan, drawH / latSpan);
  const scaledW = lngSpan * scale;
  const scaledH = latSpan * scale;
  const ox = x + pad + (drawW - scaledW) / 2;
  const oy = y + pad + (drawH - scaledH) / 2;

  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < route.length; i++) {
    const [lat, lng] = route[i]!;
    const px = ox + ((lng - minLng) / lngSpan) * scaledW;
    const py = oy + scaledH - ((lat - minLat) / latSpan) * scaledH;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

/**
 * Render one route to a standalone PNG data URL. Used for UI preview tiles.
 * Returns null when Canvas isn't available (non-browser context).
 */
export function renderRouteToDataUrl(
  route: [number, number][],
  size = DEFAULT_TILE,
  options: RenderOptions = {},
): string | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  renderRouteOnCanvas(ctx, route, 0, 0, size, size, options);
  return canvas.toDataURL("image/png");
}
