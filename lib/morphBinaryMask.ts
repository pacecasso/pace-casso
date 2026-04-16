/** True if pixel is ink (any non-zero treated as ink). */
function isInk(v: number): boolean {
  return v > 127;
}

function dilateInto(
  src: Uint8Array,
  dst: Uint8Array,
  w: number,
  h: number,
  r: number,
): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ink = false;
      for (let dy = -r; dy <= r && !ink; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          if (isInk(src[yy * w + xx])) {
            ink = true;
            break;
          }
        }
      }
      dst[y * w + x] = ink ? 255 : 0;
    }
  }
}

function erodeInto(
  src: Uint8Array,
  dst: Uint8Array,
  w: number,
  h: number,
  r: number,
): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let allInk = true;
      for (let dy = -r; dy <= r && allInk; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          if (!isInk(src[yy * w + xx])) {
            allInk = false;
            break;
          }
        }
      }
      dst[y * w + x] = allInk ? 255 : 0;
    }
  }
}

/**
 * Morphological close (dilate then erode) on 0/255 ink mask.
 * Heals 1-pixel gaps in outline art and reconnects slightly broken strokes.
 */
export function morphCloseBinary255(
  mask: Uint8Array,
  w: number,
  h: number,
  radius: number,
  scratch: Uint8Array,
): void {
  if (radius <= 0) return;
  dilateInto(mask, scratch, w, h, radius);
  erodeInto(scratch, mask, w, h, radius);
}
