/**
 * Render the "Your route line" preview from the trace screen, offline.
 *
 * Step 3 builds its third panel by thresholding the upload into a line mask
 * and running extractNormalizedContourFromLineMask over it. That preview was
 * unreadable for logo lockups and there was no way to see the result without
 * clicking through the browser, so this reproduces the same call and writes
 * a PNG next to a rendering of the mask it came from.
 *
 * Run: npx tsx scripts/probe-route-line.ts <image> [more images...]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { extractNormalizedContourFromLineMask } from "../lib/extractNormalizedContourFromLineMask";
import { filledSilhouetteToLineArtMask } from "../lib/filledSilhouetteToLineArtMask";

/** Matches PHOTO_LINE_ART_OUTLINE_LAYERS in Step1ImageUpload. */
const OUTLINE_LAYERS = 3;

const OUT = path.join(process.cwd(), "tmp-route-line-probe");

/** Mirror of the browser threshold step: dark pixels become ink. */
async function toLineMask(
  file: string,
  size = 320,
  threshold = 0.5,
): Promise<{ mask: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(file)
    .resize(size, size, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const mask = new Uint8Array(w * h);
  const cut = Math.round(threshold * 255);
  for (let i = 0; i < w * h; i++) {
    mask[i] = data[i * info.channels]! < cut ? 255 : 0;
  }
  return { mask, w, h };
}

function renderContour(
  pts: { x: number; y: number }[],
  size = 620,
): Buffer {
  const pad = 24;
  const s = size - pad * 2;
  const d = pts
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${(pad + p.x * s).toFixed(1)} ${(pad + p.y * s).toFixed(1)}`,
    )
    .join(" ");
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
      `<path d="${d}" fill="none" stroke="#111111" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`,
  );
}

function renderMask(mask: Uint8Array, w: number, h: number): Promise<Buffer> {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i]! > 128 ? 0 : 255;
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v;
    rgb[i * 3 + 2] = v;
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
    .resize(620, 620, { fit: "contain", background: "#ffffff" })
    .png()
    .toBuffer();
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: npx tsx scripts/probe-route-line.ts <image> [...]");
    process.exit(1);
  }
  await fs.mkdir(OUT, { recursive: true });
  for (const file of files) {
    const name = path.basename(file).replace(/\.[a-z0-9]+$/i, "");
    const { mask: filled, w, h } = await toLineMask(file);
    // Step 1 converts filled silhouettes to outline strokes before tracing;
    // do the same here or the probe skeletonises solid shapes and lies.
    const mask = filledSilhouetteToLineArtMask(filled, w, h, OUTLINE_LAYERS);
    const contour = extractNormalizedContourFromLineMask(mask, 0.5, w, h);
    if (!contour || contour.length < 4) {
      console.log(`${name}: NO CONTOUR (${contour?.length ?? 0} points)`);
      continue;
    }
    const sheet = path.join(OUT, `${name}-route-line.png`);
    const cell = 620;
    await sharp({
      create: { width: cell * 3 + 40, height: cell + 50, channels: 3, background: "#ffffff" },
    })
      .composite([
        {
          input: await sharp(file)
            .resize(cell, cell, { fit: "contain", background: "#ffffff" })
            .flatten({ background: "#ffffff" })
            .png()
            .toBuffer(),
          left: 10,
          top: 40,
        },
        { input: await renderMask(mask, w, h), left: cell + 20, top: 40 },
        { input: await sharp(renderContour(contour)).png().toBuffer(), left: cell * 2 + 30, top: 40 },
        {
          input: Buffer.from(
            `<svg width="${cell * 3}" height="34"><text x="10" y="24" font-family="Arial" font-size="20" font-weight="700" fill="#111">upload | traced line art | YOUR ROUTE LINE (${contour.length} pts)</text></svg>`,
          ),
          left: 10,
          top: 6,
        },
      ])
      .png()
      .toFile(sheet);
    console.log(`${name}: ${contour.length} points -> ${sheet}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
