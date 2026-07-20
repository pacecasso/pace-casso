/**
 * Render the symbol-over-wordmark lockup for an uploaded image, so the
 * composition can be checked against the reference (nikegood.jpeg) without
 * clicking through the site.
 *
 * Run: npx tsx scripts/probe-lockup.ts <image> <WORD>
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { extractNormalizedContourFromLineMask } from "../lib/extractNormalizedContourFromLineMask";
import { filledSilhouetteToLineArtMask } from "../lib/filledSilhouetteToLineArtMask";
import {
  buildLockupStrokePoints,
  streetLockupCandidates,
} from "../lib/mapNativeDesigner";
import { CITY_PRESETS } from "../lib/cityPresets";

const OUT = path.join(process.cwd(), "tmp-lockup-probe");
const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

async function traceSymbol(file: string) {
  const size = 320;
  const { data, info } = await sharp(file)
    .resize(size, size, { fit: "contain", background: "#ffffff" })
    .flatten({ background: "#ffffff" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    filled[i] = data[i * info.channels]! < 128 ? 255 : 0;
  }
  const mask = filledSilhouetteToLineArtMask(filled, w, h, 3);
  return extractNormalizedContourFromLineMask(mask, 0.5, w, h);
}

function shapeSvg(pts: { x: number; y: number }[], size = 700): Buffer {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 30;
  const s = (size - pad * 2) / span;
  const d = pts
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${(pad + (p.x - minX) * s).toFixed(1)} ${(pad + (maxY - p.y) * s).toFixed(1)}`,
    )
    .join(" ");
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${size}" height="${size}" fill="#fff"/>` +
      `<path d="${d}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );
}

async function mapPng(coords: [number, number][], size = 700): Promise<Buffer> {
  let zoom = 13;
  for (let z = 16; z >= 11; z--) {
    const xs = coords.map((p) => lonToX(p[1], z));
    const ys = coords.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= size * 0.88 && Math.max(...ys) - Math.min(...ys) <= size * 0.88) {
      zoom = z;
      break;
    }
  }
  const xs = coords.map((p) => lonToX(p[1], zoom));
  const ys = coords.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - size / 2;
  const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - size / 2;
  const tiles: sharp.OverlayOptions[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + size) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + size) / TILE); ty++) {
      try {
        const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
          headers: { "User-Agent": "pace-casso lockup probe (dev)" },
        });
        if (!res.ok) continue;
        tiles.push({
          input: Buffer.from(await res.arrayBuffer()),
          left: Math.round(tx * TILE - vx),
          top: Math.round(ty * TILE - vy),
        });
      } catch { /* skip tile */ }
    }
  }
  const base = await sharp({ create: { width: size, height: size, channels: 4, background: "#f5f4f2" } })
    .composite(tiles).png().toBuffer();
  const light = await sharp(base).modulate({ saturation: 0.12, brightness: 1.12 }).linear(0.45, 140).png().toBuffer();
  const d = coords
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`)
    .join(" ");
  return sharp(light)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
            `<path d="${d}" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>` +
            `<path d="${d}" fill="none" stroke="#fc5200" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

async function main() {
  const file = process.argv[2];
  const word = process.argv[3];
  if (!file || !word) {
    console.error("usage: npx tsx scripts/probe-lockup.ts <image> <WORD>");
    process.exit(1);
  }
  await fs.mkdir(OUT, { recursive: true });
  const symbol = await traceSymbol(file);
  if (!symbol) throw new Error("no symbol contour");
  console.log(`symbol: ${symbol.length} pts`);

  const lockup = buildLockupStrokePoints(symbol, word);
  console.log(`lockup shape: ${lockup.length} pts`);

  const cands = streetLockupCandidates(symbol, word, CITY_PRESETS["manhattan"]!, 18);
  console.log(`lockup candidates: ${cands.length}`);
  const best = cands.slice().sort((a, b) => b.km - a.km)[0];
  if (best) console.log(`biggest: ${best.km.toFixed(1)} km`);

  const cell = 700;
  const parts: sharp.OverlayOptions[] = [
    {
      input: await sharp(file).resize(cell, cell, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).png().toBuffer(),
      left: 10,
      top: 40,
    },
    { input: await sharp(shapeSvg(lockup, cell)).png().toBuffer(), left: cell + 20, top: 40 },
  ];
  if (best) parts.push({ input: await mapPng(best.anchors, cell), left: cell * 2 + 30, top: 40 });
  parts.push({
    input: Buffer.from(
      `<svg width="${cell * 3}" height="34"><text x="10" y="24" font-family="Arial" font-size="20" font-weight="700" fill="#111">upload | lockup composition | on the map${best ? ` (${best.km.toFixed(1)} km)` : ""}</text></svg>`,
    ),
    left: 10,
    top: 6,
  });

  const out = path.join(OUT, `${path.basename(file).replace(/\.[a-z0-9]+$/i, "")}-lockup.png`);
  await sharp({ create: { width: cell * 3 + 40, height: cell + 50, channels: 3, background: "#fff" } })
    .composite(parts)
    .png()
    .toFile(out);
  console.log(`-> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
