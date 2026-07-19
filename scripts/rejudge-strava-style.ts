/**
 * Presentation A/B: take an existing artist-loop GPX, re-render it the way
 * Strava presents routes (light desaturated map, fat orange line), and
 * re-run the blind judge. Validates that the recognition gap is in the
 * presentation layer, not the geometry, without spending designer calls.
 *
 * Run: npx tsx scripts/rejudge-strava-style.ts tmp-artist-loop/witch/witch.gpx "witch,rocket ship,rocket"
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const gpxPath = process.argv[2];
const acceptable = (process.argv[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!gpxPath) {
  console.error("usage: npx tsx scripts/rejudge-strava-style.ts <gpx> <acceptable,csv>");
  process.exit(1);
}

const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

async function renderStrava(chain: [number, number][], file: string, w = 1400, h = 1100) {
  let zoom = 13;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z));
    const ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.8 && Math.max(...ys) - Math.min(...ys) <= h * 0.8) {
      zoom = z;
      break;
    }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom));
  const ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2;
  const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: sharp.OverlayOptions[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
        headers: { "User-Agent": "pace-casso route preview (dev)" },
      });
      if (!res.ok) continue;
      tiles.push({
        input: Buffer.from(await res.arrayBuffer()),
        left: Math.round(tx * TILE - vx),
        top: Math.round(ty * TILE - vy),
      });
    }
  }
  // Strava-style: desaturated near-white basemap
  const base = await sharp({ create: { width: w, height: h, channels: 4, background: "#f5f4f2" } })
    .composite(tiles)
    .png()
    .toBuffer();
  const light = await sharp(base).modulate({ saturation: 0.18, brightness: 1.22 }).png().toBuffer();
  const d = chain
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`)
    .join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>` +
      `<path d="${d}" fill="none" stroke="#fc5200" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`,
  );
  await sharp(light).composite([{ input: overlay, left: 0, top: 0 }]).png().toFile(file);
}

async function cropToRoute(file: string): Promise<Buffer> {
  const img = sharp(file);
  const meta = await img.metadata();
  const width = meta.width!, height = meta.height!;
  const { data, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let minX = width, minY = height, maxX = 0, maxY = 0, found = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * ch;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      if (r > 150 && r - g > 55 && r - b > 45) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found++;
      }
    }
  }
  if (found < 30) return sharp(file).resize({ width: 1200 }).jpeg({ quality: 85 }).toBuffer();
  const padX = Math.round((maxX - minX) * 0.08) + 20;
  const padY = Math.round((maxY - minY) * 0.08) + 20;
  const left = Math.max(0, minX - padX), top = Math.max(0, minY - padY);
  return sharp(file)
    .extract({
      left, top,
      width: Math.min(width - left, maxX - minX + 2 * padX),
      height: Math.min(height - top, maxY - minY + 2 * padY),
    })
    .resize({ width: 1000, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

const JUDGE_PROMPT =
  'The orange line is a GPS route someone recorded while running — they were trying to "draw" a recognizable picture, shape, letter, or object with their path (like Strava art). ' +
  "What were they trying to draw? Reply in this exact format:\n" +
  'GUESS: <1-3 words, or "nothing recognizable">\n' +
  "CONFIDENCE: <0-10, how obvious it is at a glance>";

async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const key = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!key) throw new Error("no ANTHROPIC_API_KEY");

  const gpx = await fs.readFile(gpxPath!, "utf8");
  const chain = [...gpx.matchAll(/lat="([\d.-]+)" lon="([\d.-]+)"/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as [number, number],
  );
  console.log(`${chain.length} points from ${gpxPath}`);

  const out = gpxPath!.replace(/\.gpx$/i, "-strava-style.png");
  await renderStrava(chain, out);
  console.log("rendered", out);

  const buf = await cropToRoute(out);
  for (let i = 0; i < 3; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
            { type: "text", text: JUDGE_PROMPT },
          ],
        }],
      }),
    });
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ").replace(/\s+/g, " ");
    console.log(`judge ${i + 1}: ${text}`);
  }
  console.log("acceptable:", acceptable.join(", "));
}

main().catch((e) => { console.error(e); process.exit(1); });
