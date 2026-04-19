import { renderRouteOnCanvas } from "./renderRouteImage";

/**
 * Compose candidate routes into a single numbered grid PNG for Claude vision
 * ranking. Each tile shows the route on a real map backdrop (streets + water
 * visible) — without that, the vision model can't tell a candidate that
 * crosses water from one on solid streets.
 *
 * Falls back to outline-only rendering for any tile whose static map image
 * failed to load (network hiccup, token issue) so the grid is still complete.
 */

type GridOptions = {
  tileSize?: number;
  cols?: number;
  gap?: number;
};

type GridTile = {
  route: [number, number][];
  /** Pre-loaded Mapbox static map image (route drawn on real map). */
  mapImage: HTMLImageElement | null;
};

export type CompositeGridResult = {
  /** Full `data:image/png;base64,...` URL. */
  dataUrl: string;
  /** Just the base64 payload, ready for the Anthropic image source `data` field. */
  rawBase64: string;
  cols: number;
  rows: number;
  tileSize: number;
};

export function buildCompositeGridDataUrl(
  tiles: GridTile[],
  options: GridOptions = {},
): CompositeGridResult | null {
  if (typeof document === "undefined") return null;
  if (tiles.length === 0) return null;

  const tile = options.tileSize ?? 256;
  const cols = options.cols ?? Math.min(5, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const gap = options.gap ?? 4;

  const W = cols * tile + (cols + 1) * gap;
  const H = rows * tile + (rows + 1) * gap;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < tiles.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = gap + col * (tile + gap);
    const y = gap + row * (tile + gap);
    const t = tiles[i]!;

    if (t.mapImage) {
      // Cover the tile with the pre-rendered Mapbox map (route already drawn).
      ctx.drawImage(t.mapImage, x, y, tile, tile);
    } else {
      // Fallback: outline on white so the grid stays complete.
      renderRouteOnCanvas(ctx, t.route, x, y, tile, tile);
    }

    // High-contrast number badge so Claude can reference candidates by id.
    const label = String(i + 1);
    const badgeW = label.length > 1 ? 30 : 24;
    ctx.fillStyle = "rgba(0,0,0,0.92)";
    ctx.fillRect(x + 4, y + 4, badgeW, 22);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(label, x + 9, y + 7);
  }

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch (err) {
    // A tainted canvas (cross-origin image without CORS) throws here.
    console.warn("[compositeRouteGrid] canvas.toDataURL failed:", err);
    return null;
  }
  const rawBase64 = dataUrl.split(",")[1] ?? "";
  return { dataUrl, rawBase64, cols, rows, tileSize: tile };
}
