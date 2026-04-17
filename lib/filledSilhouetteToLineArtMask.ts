/**
 * Turn a filled 0/255 silhouette into a stroke-like mask by peeling successive
 * outer (and inner-hole) boundary layers. Keeps topology (holes, separate
 * strokes) while avoiding a solid black “blob” in the line-art preview.
 */

function inkOn(mask: Uint8Array, i: number): boolean {
  return mask[i]! > 80;
}

/** 4-connected binary erosion: keep only pixels whose 4-neighbors are all ink. */
function erode4Ink(mask: Uint8Array, w: number, h: number): Uint8Array {
  const dst = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!inkOn(mask, i)) continue;
      if (
        !inkOn(mask, i - 1) ||
        !inkOn(mask, i + 1) ||
        !inkOn(mask, i - w) ||
        !inkOn(mask, i + w)
      ) {
        continue;
      }
      dst[i] = 255;
    }
  }
  return dst;
}

function anyInk(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) {
    if (inkOn(mask, i)) return true;
  }
  return false;
}

/**
 * @param filled — ink at values >80, same convention as Step1 line mask
 * @param layers — how many pixel layers to keep from each boundary (typ. 2–4)
 */
export function filledSilhouetteToLineArtMask(
  filled: Uint8Array,
  w: number,
  h: number,
  layers: number,
): Uint8Array {
  const maxLayers = Math.max(1, Math.min(Math.floor(layers), 24));
  const rem = new Uint8Array(w * h);
  for (let i = 0; i < rem.length; i++) {
    rem[i] = inkOn(filled, i) ? 255 : 0;
  }

  if (!anyInk(rem)) {
    return new Uint8Array(w * h);
  }

  const out = new Uint8Array(w * h);

  for (let layer = 0; layer < maxLayers; layer++) {
    if (!anyInk(rem)) break;
    const inner = erode4Ink(rem, w, h);
    for (let i = 0; i < rem.length; i++) {
      if (inkOn(rem, i) && !inkOn(inner, i)) {
        out[i] = 255;
      }
    }
    rem.set(inner);
  }

  if (!anyInk(out)) {
    return Uint8Array.from(filled);
  }
  return out;
}
