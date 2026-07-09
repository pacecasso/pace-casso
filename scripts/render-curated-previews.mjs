/**
 * Render real map preview PNGs for the six curated Manhattan runs.
 *
 * CARTO light basemap tiles + brand-red route polyline (white casing) via
 * sharp SVG compositing. Outputs square 640x640 PNGs to public/curated/<id>.png
 * plus an 800x800 hero for les-heart.
 *
 * Run: npx tsx scripts/render-curated-previews.mjs
 * (tsx, not plain node — it imports lib/curatedManhattanRuns.ts directly.)
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { CURATED_MANHATTAN_RUNS } from "../lib/curatedManhattanRuns.ts";

const outDir = path.join(process.cwd(), "public", "curated");
await fs.mkdir(outDir, { recursive: true });

const TILE_SIZE = 256;
const TILE_URL = (z, x, y) =>
  `https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`;
const USER_AGENT =
  "pace-casso-curated-previews/1.0 (GPS-art route preview renderer)";
/** Route bbox occupies this fraction of the frame (longest axis). */
const FILL = 0.75;
const MAX_TILE_ZOOM = 17;

/** Cache tiles across runs — the LES and Chelsea routes overlap heavily. */
const tileCache = new Map();

async function fetchTile(z, x, y) {
  const url = TILE_URL(z, x, y);
  if (tileCache.has(url)) return tileCache.get(url);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`tile fetch failed ${res.status}: ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  tileCache.set(url, buf);
  return buf;
}

function lonToWorldX(lon, zoom) {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function latToWorldY(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
    TILE_SIZE *
    2 ** zoom
  );
}

/**
 * Render one route to a square PNG.
 * Fractional-zoom trick for exact framing: pick the ideal fractional zoom so
 * the route bbox fills FILL of the frame, fetch tiles at the next integer
 * zoom up (sharper), composite on an oversized canvas, then resize down.
 */
async function renderRoute(coords, size, outPath, label) {
  const xsRaw = coords.map(([, lon]) => lonToWorldX(lon, 0));
  const ysRaw = coords.map(([lat]) => latToWorldY(lat, 0));
  const spanX0 = Math.max(...xsRaw) - Math.min(...xsRaw);
  const spanY0 = Math.max(...ysRaw) - Math.min(...ysRaw);
  const span0 = Math.max(spanX0, spanY0);

  // Fractional zoom where the bbox's longest side is exactly FILL * size px.
  const idealZoom = Math.log2((FILL * size) / span0);
  const tileZoom = Math.min(MAX_TILE_ZOOM, Math.ceil(idealZoom));
  // scale <= 1: how much the tile-zoom render shrinks to reach final size.
  const scale = 2 ** (idealZoom - tileZoom);
  const bigSize = Math.round(size / scale);

  const xs = coords.map(([, lon]) => lonToWorldX(lon, tileZoom));
  const ys = coords.map(([lat]) => latToWorldY(lat, tileZoom));
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const viewportX = centerX - bigSize / 2;
  const viewportY = centerY - bigSize / 2;

  const minTileX = Math.floor(viewportX / TILE_SIZE);
  const maxTileX = Math.floor((viewportX + bigSize) / TILE_SIZE);
  const minTileY = Math.floor(viewportY / TILE_SIZE);
  const maxTileY = Math.floor((viewportY + bigSize) / TILE_SIZE);

  const tileComposites = [];
  for (let tx = minTileX; tx <= maxTileX; tx++) {
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      // Sequential on purpose — be gentle with the tile CDN.
      const buf = await fetchTile(tileZoom, tx, ty);
      tileComposites.push({
        input: buf,
        left: Math.round(tx * TILE_SIZE - viewportX),
        top: Math.round(ty * TILE_SIZE - viewportY),
      });
    }
  }

  const pathData = coords
    .map(([lat, lon], i) => {
      const x = lonToWorldX(lon, tileZoom) - viewportX;
      const y = latToWorldY(lat, tileZoom) - viewportY;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  // Stroke widths are chosen in FINAL pixels, so divide by scale to hold
  // visual weight constant after the downscale.
  const casingW = (10 / scale).toFixed(2);
  const routeW = (5 / scale).toFixed(2);

  const overlay = Buffer.from(`
<svg width="${bigSize}" height="${bigSize}" viewBox="0 0 ${bigSize} ${bigSize}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${bigSize}" height="${bigSize}" fill="rgba(255,255,255,0.45)"/>
  <path d="${pathData}" fill="none" stroke="#ffffff" stroke-width="${casingW}" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
  <path d="${pathData}" fill="none" stroke="#dc2626" stroke-width="${routeW}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

  const big = await sharp({
    create: {
      width: bigSize,
      height: bigSize,
      channels: 3,
      background: "#eceae5",
    },
  })
    .composite([...tileComposites, { input: overlay, left: 0, top: 0 }])
    .png()
    .toBuffer();

  await sharp(big)
    .resize(size, size, { kernel: "lanczos3" })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toFile(outPath);

  const { size: bytes } = await fs.stat(outPath);
  console.log(
    `${label}: ${outPath} — ${(bytes / 1024).toFixed(0)} KB ` +
      `(tile z${tileZoom}, ${tileComposites.length} tiles)`,
  );
}

for (const run of CURATED_MANHATTAN_RUNS) {
  await renderRoute(
    run.coords,
    640,
    path.join(outDir, `${run.id}.png`),
    run.title,
  );
}

const heart = CURATED_MANHATTAN_RUNS.find((r) => r.id === "les-heart");
if (!heart) throw new Error("les-heart run missing");
await renderRoute(
  heart.coords,
  800,
  path.join(outDir, "les-heart-hero.png"),
  "les-heart hero",
);

console.log("done");
