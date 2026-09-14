/**
 * corpus-lines.ts — pull the drawn GPS line out of each corpus image and
 * measure it. ZERO model calls: pure pixel work with sharp.
 *
 * Most gallery pieces are app screenshots: one saturated route line (Strava
 * red/orange, sometimes blue or purple) over a pale map. We find the dominant
 * saturated hue, mask pixels near it, thin the mask to a 1 px skeleton and
 * record simple structure numbers per piece:
 *   - line_px: skeleton length in pixels (proxy for drawn length)
 *   - components: separate ink pieces (1 = one continuous line)
 *   - endpoints / junctions: skeleton ends and branch points (spurs, crossings)
 *   - holes + small_holes: enclosed background regions; small ones are the
 *     tiny loops artists use for eyes, nostrils, dots
 *   - bbox_aspect, fill: silhouette proportions and how much of the box is ink
 * It also writes the mask as a small PNG so the moves can be looked at later.
 *
 *   npx tsx scripts/corpus-lines.ts [--dir=tmp-corpus/stravart] [--limit=N]
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { zhangSuenThinInPlace } from "../lib/centerlineFromMask";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const DIR = args.dir ?? "tmp-corpus/stravart";
const LIMIT = Number(args.limit ?? Infinity);
const W = 1000;

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx / 255];
}

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Count 4-connected regions of `val` in img; returns sizes and whether each touches the border. */
function regions(img: Uint8Array, w: number, h: number, val: number) {
  const seen = new Uint8Array(w * h);
  const out: { size: number; border: boolean }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || img[i] !== val) continue;
    let size = 0;
    let border = false;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && !seen[q] && img[q] === val) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    out.push({ size, border });
  }
  return out;
}

function dilate(img: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(img);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (img[i]) continue;
      if (img[i - 1] || img[i + 1] || img[i - w] || img[i + w]) out[i] = 1;
    }
  return out;
}

async function analyse(file: string) {
  const { data, info } = await sharp(file).resize({ width: W }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const n = w * h;

  // 1. Dominant saturated hue = the route line colour.
  const bins = new Array(36).fill(0);
  const hsv = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [hh, s, v] = rgbToHsv(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
    hsv[i * 3] = hh;
    hsv[i * 3 + 1] = s;
    hsv[i * 3 + 2] = v;
    if (s > 0.6 && v > 0.35) bins[Math.floor(hh / 10) % 36]++;
  }
  const best = bins.indexOf(Math.max(...bins));
  const lineHue = best * 10 + 5;
  const satCount = bins[best] + bins[(best + 1) % 36] + bins[(best + 35) % 36];

  // 2. Mask pixels near that hue.
  const mask = new Uint8Array(n);
  let ink = 0;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let i = 0; i < n; i++) {
    if (hsv[i * 3 + 1] > 0.45 && hsv[i * 3 + 2] > 0.3 && hueDist(hsv[i * 3], lineHue) < 18) {
      mask[i] = 1;
      ink++;
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (ink < 200) return { ok: false as const, reason: "no line colour found", line_hue: lineHue };

  // Thicken by 2 px so a thin anti-aliased line stays one connected stroke.
  const thick = dilate(dilate(mask, w, h), w, h);

  // Drop specks: keep ink components larger than 0.5 % of total ink.
  const inkRegions = regions(thick, w, h, 1);
  const bigInk = inkRegions.filter((r) => r.size > ink * 0.005).length;

  // 3. Enclosed background regions = holes (loops in the drawing).
  const bg = regions(thick, w, h, 0).filter((r) => !r.border);
  const boxArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
  const holes = bg.filter((r) => r.size > 12);
  const smallHoles = holes.filter((r) => r.size < boxArea * 0.004);

  // 4. Skeleton topology.
  const skel = new Uint8Array(thick);
  zhangSuenThinInPlace(skel, w, h);
  let linePx = 0;
  let endpoints = 0;
  const junctionMask = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!skel[i]) continue;
      linePx++;
      // Crossing number: 0-to-1 transitions walking the 8 neighbours in order.
      const ring = [i - w, i - w + 1, i + 1, i + w + 1, i + w, i + w - 1, i - 1, i - w - 1].map((q) => skel[q]);
      let t = 0;
      for (let k = 0; k < 8; k++) if (!ring[k] && ring[(k + 1) % 8]) t++;
      if (t === 1 && ring.reduce((a, b) => a + b, 0) <= 2) endpoints++;
      else if (t >= 3) junctionMask[i] = 1;
    }
  }

  // A crossing smears over a few skeleton pixels; count clusters, not pixels.
  const junctions = regions(dilate(junctionMask, w, h), w, h, 1).length;

  const png = Buffer.alloc(n);
  for (let i = 0; i < n; i++) png[i] = mask[i] ? 0 : 255;
  const maskFile = path.join(DIR, "masks", path.basename(file).replace(/\.[a-z]+$/i, ".png"));
  await sharp(png, { raw: { width: w, height: h, channels: 1 } }).png().toFile(maskFile);

  return {
    ok: true as const,
    line_hue: lineHue,
    line_colour_px: satCount,
    ink_px: ink,
    line_px: linePx,
    stroke_px: +(ink / Math.max(1, linePx)).toFixed(2),
    components: bigInk,
    endpoints,
    junctions,
    holes: holes.length,
    small_holes: smallHoles.length,
    bbox_aspect: +((maxX - minX + 1) / (maxY - minY + 1)).toFixed(2),
    bbox_frac: +(boxArea / n).toFixed(3),
    fill: +(ink / boxArea).toFixed(3),
  };
}

async function main() {
  fs.mkdirSync(path.join(DIR, "masks"), { recursive: true });
  const pieces = fs
    .readFileSync(path.join(DIR, "pieces.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { file: string; category: string; subject_hint: string });
  const out: string[] = [];
  let ok = 0;
  let bad = 0;
  for (const p of pieces.slice(0, LIMIT)) {
    try {
      const r = await analyse(path.join(DIR, "images", p.file));
      if (r.ok) ok++;
      else bad++;
      out.push(JSON.stringify({ file: p.file, category: p.category, subject_hint: p.subject_hint, ...r }));
    } catch (e) {
      bad++;
      out.push(JSON.stringify({ file: p.file, category: p.category, ok: false, reason: String(e) }));
    }
    if ((ok + bad) % 250 === 0) console.log(`  analysed ${ok + bad} (no line: ${bad})`);
  }
  fs.writeFileSync(path.join(DIR, "lines.jsonl"), out.join("\n") + "\n");
  console.log(JSON.stringify({ analysed: ok + bad, line_found: ok, no_line: bad, model_calls: 0 }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
