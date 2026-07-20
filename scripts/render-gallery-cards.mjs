/**
 * Regenerate the gallery card images in public/curated/.
 *
 * The originals were near-white maps with a hairline route — at card size
 * you couldn't tell a turtle from a duck. These render the same real routes
 * Strava-style: a light, low-contrast basemap so the line owns the frame, a
 * fat orange stroke with a white halo, and a tight crop around the route so
 * the shape fills the card instead of floating in a sea of map.
 *
 * Run: node scripts/render-gallery-cards.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(path.join(process.cwd(), "package.json"));
const sharp = require("sharp");

const SIZE = 900;
const TILE = 256;
const lonToX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

const tileCache = new Map();
async function tile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  try {
    const res = await fetch(`https://tile.openstreetmap.org/${key}.png`, {
      headers: { "User-Agent": "pace-casso gallery render (dev)" },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    tileCache.set(key, buf);
    return buf;
  } catch {
    return null;
  }
}

async function render(coords, outFile) {
  // Choose the tightest zoom that still fits the route with a small margin,
  // so the drawing fills the card.
  let zoom = 13;
  for (let z = 17; z >= 11; z--) {
    const xs = coords.map((p) => lonToX(p[1], z));
    const ys = coords.map((p) => latToY(p[0], z));
    if (
      Math.max(...xs) - Math.min(...xs) <= SIZE * 0.9 &&
      Math.max(...ys) - Math.min(...ys) <= SIZE * 0.9
    ) {
      zoom = z;
      break;
    }
  }
  const xs = coords.map((p) => lonToX(p[1], zoom));
  const ys = coords.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - SIZE / 2;
  const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - SIZE / 2;

  const parts = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + SIZE) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + SIZE) / TILE); ty++) {
      const buf = await tile(zoom, tx, ty);
      if (!buf) continue;
      parts.push({
        input: buf,
        left: Math.round(tx * TILE - vx),
        top: Math.round(ty * TILE - vy),
      });
    }
  }

  const base = await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: "#f7f6f4" },
  })
    .composite(parts)
    .png()
    .toBuffer();
  // Wash the map back so the route reads first. modulate alone leaves OSM's
  // dark label text at full contrast, which fights the line at card size;
  // the linear() pass compresses everything toward white so the basemap
  // becomes texture rather than content.
  const light = await sharp(base)
    .modulate({ saturation: 0.1, brightness: 1.1 })
    .linear(0.42, 148)
    .png()
    .toBuffer();

  const d = coords
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`,
    )
    .join(" ");
  const overlay = Buffer.from(
    `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="17" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>` +
      `<path d="${d}" fill="none" stroke="#fc5200" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`,
  );
  const composed = await sharp(light)
    .composite([{ input: overlay, left: 0, top: 0 }])
    .png()
    .toBuffer();

  // Zoom moves in powers of two, so the route can end up floating in a lot
  // of empty map. Crop to the route's own bounds (square, with margin) so
  // every card is framed the same and the shape fills it.
  const px = coords.map((p) => lonToX(p[1], zoom) - vx);
  const py = coords.map((p) => latToY(p[0], zoom) - vy);
  const minX = Math.min(...px), maxX = Math.max(...px);
  const minY = Math.min(...py), maxY = Math.max(...py);
  const side = Math.max(maxX - minX, maxY - minY) * 1.16;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const left = Math.round(Math.max(0, Math.min(SIZE - side, cx - side / 2)));
  const top = Math.round(Math.max(0, Math.min(SIZE - side, cy - side / 2)));
  const box = Math.round(Math.min(side, SIZE - left, SIZE - top));

  await sharp(composed)
    .extract({ left, top, width: box, height: box })
    .resize(SIZE, SIZE)
    .png({ quality: 92 })
    .toFile(outFile);
}

async function main() {
  const src = await fs.readFile(path.join(process.cwd(), "lib", "curatedManhattanRuns.ts"), "utf8");
  const runs = [];
  const re = /id:\s*"([^"]+)"[\s\S]*?coords:\s*(\[\[[\s\S]*?\]\])\s*,\s*\n\s*\}/g;
  let m;
  while ((m = re.exec(src))) {
    runs.push({ id: m[1], coords: JSON.parse(m[2]) });
  }
  if (!runs.length) throw new Error("no curated runs parsed");
  const outDir = path.join(process.cwd(), "public", "curated");
  for (const run of runs) {
    const out = path.join(outDir, `${run.id}.png`);
    await render(run.coords, out);
    console.log(`rendered ${run.id} (${run.coords.length} pts) -> ${out}`);
  }
  // Hero image used on the marketing page, same treatment.
  const heart = runs.find((r) => r.id === "les-heart");
  if (heart) {
    const hero = path.join(outDir, "les-heart-hero.png");
    await render(heart.coords, hero);
    console.log(`rendered hero -> ${hero}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
