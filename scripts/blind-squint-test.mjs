// Blind squint test — the ONLY valid judge of route recognizability.
// In-session self-assessment has failed twice (gas v4, heart "mitten"):
// once you know the intent you cannot un-see it. This shows a route to a
// different model with zero design context and asks what it depicts.
//
// Two fixes over v1: (1) crop the map render to the red route's bounding
// box so the shape fills the frame like a human would look at it, and
// (2) max_tokens high enough that thinking doesn't eat the answer.
//
// Usage: node scripts/blind-squint-test.mjs [--model=claude-opus-4-8] <img> [img2 ...]
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");

const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
const key = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("ANTHROPIC_API_KEY not in .env.local");

const args = process.argv.slice(2);
const MODEL = args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "claude-opus-4-8";
const files = args.filter((a) => !a.startsWith("--"));

// Crop to the reddest pixels (the route overlay). Returns a JPEG buffer.
async function cropToRoute(file) {
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const { data, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let minX = width, minY = height, maxX = 0, maxY = 0, found = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // route reds: strong red, low green/blue. also catch orange refs.
      if (r > 150 && r - g > 55 && r - b > 45) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        found++;
      }
    }
  }
  if (found < 30) {
    return await sharp(file).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  }
  const padX = Math.round((maxX - minX) * 0.08) + 20;
  const padY = Math.round((maxY - minY) * 0.08) + 20;
  const left = Math.max(0, minX - padX), top = Math.max(0, minY - padY);
  const w = Math.min(width - left, maxX - minX + 2 * padX);
  const h = Math.min(height - top, maxY - minY + 2 * padY);
  return await sharp(file).extract({ left, top, width: w, height: h })
    .resize({ width: 1000, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

const PROMPT =
  "The red line is a GPS route someone recorded while running — they were trying to \"draw\" a recognizable picture, shape, letter, or object with their path (like Strava art). " +
  "What were they trying to draw? Reply in this exact format:\n" +
  "GUESS: <1-3 words, or \"nothing recognizable\">\n" +
  "CONFIDENCE: <0-10, how obvious it is at a glance>";

async function judge(file) {
  const buf = await cropToRoute(file);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });
    if (!res.ok) { out.push(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`); continue; }
    const json = await res.json();
    const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    out.push(text ? text.replace(/\s+/g, " ") : `EMPTY (stop=${json.stop_reason})`);
  }
  return out;
}

console.log(`judge model: ${MODEL}\n`);
for (const file of files) {
  console.log(`=== ${file}`);
  for (const r of await judge(file)) console.log("   " + r);
  console.log();
}
