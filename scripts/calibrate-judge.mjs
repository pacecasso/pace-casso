// Calibrate "the eye": find a judge (model + prompt) that scores Ralph's
// GOOD references clearly above our KNOWN-BAD blobs. Without an eye that
// matches Ralph's, nothing downstream can work — this is step one.
//
// Labeled set (Ralph's verdicts, not mine):
//   GOOD  = the reference art he admires
//   BAD   = routes he rejected today
// A prompt is "calibrated" if mean(GOOD) - mean(BAD) is large & consistent.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");

const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
const key = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) throw new Error("ANTHROPIC_API_KEY missing");

const MODEL = process.argv[2] ?? "claude-opus-4-8";
const SAMPLES = 2;

// Ralph's ground-truth ratings (his taste = craft/quality AS the subject,
// NOT cold recognizability). "target" is what the calibrated eye must match.
const SET = [
  { file: "lion.webp", subject: "lion", target: 8.5 },
  { file: "TIGER.webp", subject: "tiger", target: 8.5 },
  { file: "HEART.webp", subject: "heart", target: 8.5 },
  { file: "LOVE.png", subject: "the word LOVE", target: 8.5 },
  { file: "tmp-trace/apple/map-clean.png", subject: "an apple", target: 1 },
  { file: "tmp-fill-designs/heart-island/3-map.png", subject: "a heart", target: 1 },
  { file: "tmp-interp-designs/lion/3-map.png", subject: "a lion", target: 3 },
  { file: "tmp-interp-designs/gas-v7/3-map.png", subject: "a person wearing headphones (a logo figure)", target: 2 },
];

// Subject-aware prompts: the eye is TOLD the intended subject and rates
// craft/clarity as that subject (matching how Ralph judges).
const PROMPTS = {
  quality: (s) => `This GPS running route is an attempt to draw ${s}. Rate how GOOD it is as a recognizable, well-crafted ${s}: 10 = a skilled, clean, clearly-a-${s} drawing you'd be proud of; 5 = rough but you can tell; 0 = a muddy/blocky blob that fails. End with exactly: SCORE: <0-10>.`,
  craft: (s) => `This route is meant to depict ${s}. Judge the CRAFTSMANSHIP as an artist would: clean intentional lines forming a clear, organic, well-proportioned ${s} scores high; blocky staircases, muddy shapelessness, or broken/incomplete forms score low. End with exactly: SCORE: <0-10>.`,
  proud: (s) => `A runner spent hours running this route to draw ${s}, to post on Strava. Would they be proud (10 = looks genuinely great, clearly a lovely ${s}) or embarrassed (1 = a blob nobody would admire)? Be honest and critical. End with exactly: SCORE: <0-10>.`,
  compare: (s) => `Rate this GPS route as a drawing of ${s} on a 0-10 scale where the best hand-made Strava art (detailed, organic, instantly lovely) is a 9-10 and a shapeless accidental blob is a 1. Where does THIS fall? End with exactly: SCORE: <0-10>.`,
};

// crop to the colored route so the shape fills the frame
async function crop(file) {
  const img = sharp(path.join(process.cwd(), file));
  const { width, height } = await img.metadata();
  const { data, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let x0 = width, y0 = height, x1 = 0, y1 = 0, n = 0;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    const i = (y * width + x) * ch, r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 150 && r - g > 50 && r - b > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; n++; }
  }
  if (n < 30) return img.resize({ width: 1000 }).jpeg({ quality: 85 }).toBuffer();
  const px = ((x1 - x0) * 0.07) | 0, py = ((y1 - y0) * 0.07) | 0;
  const L = Math.max(0, x0 - px - 15), T = Math.max(0, y0 - py - 15);
  return sharp(path.join(process.cwd(), file)).extract({ left: L, top: T, width: Math.min(width - L, x1 - x0 + 2 * px + 30), height: Math.min(height - T, y1 - y0 + 2 * py + 30) }).resize({ width: 1000, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

async function ask(buf, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } }, { type: "text", text: prompt }] }] }),
  });
  if (!res.ok) return { score: null, txt: `HTTP ${res.status}` };
  const j = await res.json();
  const txt = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
  const m = txt.match(/SCORE:\s*(\d+(?:\.\d+)?)/i);
  return { score: m ? Number(m[1]) : null, txt: txt.replace(/\s+/g, " ").slice(0, 90) };
}

const bufs = {};
for (const s of SET) bufs[s.file] = await crop(s.file);

console.log(`model: ${MODEL}   (targets = Ralph's ratings)\n`);
const summary = {};
for (const [name, promptFn] of Object.entries(PROMPTS)) {
  console.log(`\n=== PROMPT: ${name} ===`);
  let absErr = 0, n = 0;
  for (const s of SET) {
    const vals = [];
    for (let i = 0; i < SAMPLES; i++) { const r = await ask(bufs[s.file], promptFn(s.subject)); if (r.score != null) vals.push(r.score); }
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
    if (!isNaN(avg)) { absErr += Math.abs(avg - s.target); n++; }
    const tag = s.target >= 6 ? "GOOD" : "BAD ";
    console.log(`  [${tag} want ${s.target}] ${path.basename(s.file).padEnd(22)} got ${isNaN(avg) ? "??" : avg.toFixed(1)}  (${vals.join(",")})`);
  }
  summary[name] = n ? absErr / n : Infinity;
  console.log(`  --> mean error vs Ralph: ${summary[name].toFixed(2)} (lower = better eye)`);
}
console.log("\n\n=== RANKING (closest to Ralph's ratings) ===");
for (const [nm, e] of Object.entries(summary).sort((a, b) => a[1] - b[1])) console.log(`  ${nm.padEnd(9)} mean error ${e.toFixed(2)}`);
