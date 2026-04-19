import { extractNormalizedContourFromLineMask } from "./extractNormalizedContourFromLineMask";
import type { AreaDesignContour } from "./areaDesignTemplates";

/**
 * Render a single emoji (or short glyph string) to a canvas at large size,
 * convert the rasterised result into a binary ink mask, and run it through
 * the same contour-extraction pipeline we use for uploaded photos. The
 * output is a normalised 0–1 contour ready to feed into Step 2 as an
 * `AreaDesignContour[]`.
 *
 * Returns null on any failure (non-browser environment, emoji font missing,
 * contour extractor gave up, etc.) so callers can gracefully fall back to
 * the Photo / Draw manual paths.
 */

const DEFAULT_SIZE = 320;

export function emojiToContour(
  emoji: string,
  size = DEFAULT_SIZE,
): AreaDesignContour[] | null {
  if (typeof document === "undefined") return null;
  if (!emoji || emoji.trim().length === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Solid white background so non-white pixels register as "ink."
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);

  // Cross-platform system emoji stack. On Windows the emoji font is Segoe UI
  // Emoji (outline-based), on Mac it's Apple Color Emoji (fills), etc. All
  // render something recognisable — the contour extractor cares about the
  // silhouette, not the fine detail.
  ctx.fillStyle = "#000000";
  ctx.font = `${Math.floor(size * 0.78)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, size / 2, size / 2);

  const img = ctx.getImageData(0, 0, size, size);
  const mask = new Uint8Array(size * size);
  let inkPixels = 0;
  for (let i = 0; i < size * size; i++) {
    const r = img.data[i * 4]!;
    const g = img.data[i * 4 + 1]!;
    const b = img.data[i * 4 + 2]!;
    const a = img.data[i * 4 + 3]!;
    // Any pixel meaningfully different from pure white counts as ink.
    // (Emoji are usually coloured, so we can't just look for dark pixels.)
    const distFromWhite =
      Math.abs(r - 255) + Math.abs(g - 255) + Math.abs(b - 255);
    if (a > 128 && distFromWhite > 60) {
      mask[i] = 255;
      inkPixels++;
    }
  }

  // If the emoji font didn't render this glyph (Tofu / missing), the canvas
  // will have near-zero ink. Bail cleanly so the UI can fall back.
  if (inkPixels < size * size * 0.005) return null;

  const contour = extractNormalizedContourFromLineMask(mask, 0.5, size, size);
  if (!contour || contour.length < 4) return null;
  return contour;
}
