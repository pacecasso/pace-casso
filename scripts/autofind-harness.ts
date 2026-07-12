/**
 * Real-path offline harness for autoFindTop5 — runs the EXACT production
 * auto-find flow headless on an uploaded image, so interpretation/scale
 * changes can be validated against what the user actually sees before
 * anything ships.
 *
 * Reproduces the production environment faithfully:
 *  - the Step-1 alpha-channel trace (same lib functions, same constants)
 *  - the Step-2 autoFindTop5 call (same options as components/Step2MapAnchor)
 *  - /api/vision-* endpoints stubbed per mode; Mapbox calls go out for real
 *
 * Modes (--vision):
 *  - "dead"  : vision endpoints return errors — mirrors production today,
 *              where ANTHROPIC_API_KEY is not configured (503s).
 *  - <file>  : vision-design serves the JSON payload in <file>; vision-hint
 *              serves a fixed creature/medium hint; vision-rank identity.
 *
 * Run: npx tsx scripts/autofind-harness.ts --image gas.png --vision dead --out tmp-autofind-harness/baseline
 * Requires NEXT_PUBLIC_MAPBOX_TOKEN in .env.local. Makes real Mapbox calls.
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// --- env before anything reads it ---------------------------------------
async function loadEnv() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// --- browser shims --------------------------------------------------------
class FakeImage {
  onload: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  crossOrigin = "";
  set src(_v: string) {
    setTimeout(() => this.onerror?.(new Error("no-dom")), 0);
  }
}
(globalThis as Record<string, unknown>).Image = FakeImage;

type VisionMode = { kind: "dead" } | { kind: "drafts"; payload: unknown };

function installFetchStub(mode: VisionMode) {
  const realFetch = globalThis.fetch.bind(globalThis);
  const stats = { mapboxCalls: 0, visionDesign: 0, visionHint: 0, visionRank: 0 };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.startsWith("/api/vision-design")) {
      stats.visionDesign++;
      if (mode.kind === "dead") {
        return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured on server" }), { status: 503 });
      }
      return new Response(JSON.stringify(mode.payload), { status: 200 });
    }
    if (url.startsWith("/api/vision-hint")) {
      stats.visionHint++;
      if (mode.kind === "dead") {
        return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured on server" }), { status: 503 });
      }
      return new Response(
        JSON.stringify({
          shapeClass: "creature",
          rotationStrategy: "upright",
          scaleHint: "medium",
          reason: "harness fixed hint",
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("/api/vision-rank")) {
      stats.visionRank++;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const count = typeof body.count === "number" ? body.count : 5;
      const topK = typeof body.topK === "number" ? body.topK : 5;
      return new Response(
        JSON.stringify({
          ranked: Array.from({ length: Math.min(topK, count) }, (_, i) => ({
            id: i + 1,
            reason: "harness identity rank",
          })),
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "harness: unstubbed api" }), { status: 404 });
    }
    if (url.includes("api.mapbox.com")) stats.mapboxCalls++;
    return realFetch(url, init);
  }) as typeof fetch;
  return stats;
}

// --- production Step-1 alpha trace, replicated with the same lib fns ------
const BOX_SIZE = 300;
const LUM_SAMPLE_SUPER = 2;
const LUM_SAMPLE_PX = BOX_SIZE * LUM_SAMPLE_SUPER;
const DEFAULT_CONTOUR_LEVEL = 0.22;
const PHOTO_LINE_ART_OUTLINE_LAYERS = 3;

function labelConnectedComponents4(binary: Uint8Array, w: number, h: number): Int32Array {
  const labels = new Int32Array(w * h);
  let nextLabel = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (binary[i] === 0 || labels[i] !== 0) continue;
      nextLabel++;
      const stack: number[] = [i];
      while (stack.length) {
        const j = stack.pop()!;
        if (labels[j] !== 0 || binary[j] === 0) continue;
        labels[j] = nextLabel;
        const jx = j % w;
        const jy = (j / w) | 0;
        if (jx > 0) stack.push(j - 1);
        if (jx < w - 1) stack.push(j + 1);
        if (jy > 0) stack.push(j - w);
        if (jy < h - 1) stack.push(j + w);
      }
    }
  }
  return labels;
}

const PHOTO_BLUR_SIGMA = 1.0;

function gaussianBlurFloat32(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.ceil(sigma * 2.5);
  const ks = 2 * radius + 1;
  const kernel = new Float32Array(ks);
  let ksum = 0;
  for (let i = 0; i < ks; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    ksum += kernel[i];
  }
  for (let i = 0; i < ks; i++) kernel[i] /= ksum;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < ks; k++) v += src[y * w + Math.max(0, Math.min(w - 1, x + k - radius))] * kernel[k];
      tmp[y * w + x] = v;
    }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < ks; k++) v += tmp[Math.max(0, Math.min(h - 1, y + k - radius)) * w + x] * kernel[k];
      out[y * w + x] = v;
    }
  return out;
}

/** Ink strength per production luminanceFromRgba: transparent → 0, else 1-gray. */
function inkFromRgba(data: Buffer, idx: number): number {
  const a = data[idx + 3];
  if (a < 128) return 0;
  return 1 - (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255;
}

async function traceImageProductionPath(imagePath: string): Promise<{ x: number; y: number }[]> {
  const { fillLineMaskSignificantComponents } = await import("../lib/inkMaskUnionEnclosed");
  const { filledSilhouetteToLineArtMask } = await import("../lib/filledSilhouetteToLineArtMask");
  const { extractNormalizedContourFromLineMask } = await import("../lib/extractNormalizedContourFromLineMask");
  const { otsuInkThreshold } = await import("../lib/otsuThreshold");

  const img = sharp(imagePath).ensureAlpha().resize(LUM_SAMPLE_PX, LUM_SAMPLE_PX, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });

  // Production decides alpha vs luminance by transparent-pixel fraction.
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  const transparentFrac = transparent / (LUM_SAMPLE_PX * LUM_SAMPLE_PX);

  let lum: Float32Array;
  let threshold: number;
  let useAlpha = transparentFrac > 0.1;
  if (useAlpha) {
    // buildAlphaMaskFloat32: 2x2 max-pool on alpha >= 128
    const alphaLum = new Float32Array(BOX_SIZE * BOX_SIZE);
    let fg = 0;
    for (let y = 0; y < BOX_SIZE; y++)
      for (let x = 0; x < BOX_SIZE; x++) {
        let maxA = 0;
        for (let dy = 0; dy < LUM_SAMPLE_SUPER; dy++)
          for (let dx = 0; dx < LUM_SAMPLE_SUPER; dx++) {
            const a = data[((y * LUM_SAMPLE_SUPER + dy) * LUM_SAMPLE_PX + (x * LUM_SAMPLE_SUPER + dx)) * 4 + 3];
            if (a > maxA) maxA = a;
          }
        const v = maxA >= 128 ? 1 : 0;
        alphaLum[y * BOX_SIZE + x] = v;
        fg += v;
      }
    // Opaque-background guard (alpha covers ~everything → uninformative)
    if (fg / alphaLum.length > 0.92) {
      useAlpha = false;
    } else {
      lum = alphaLum;
      threshold = 0.5;
    }
  }
  if (!useAlpha) {
    // buildLuminanceMinPool2x2: 2x2 MIN-pool on ink strength, then blur + Otsu
    const raw = new Float32Array(BOX_SIZE * BOX_SIZE);
    for (let y = 0; y < BOX_SIZE; y++)
      for (let x = 0; x < BOX_SIZE; x++) {
        let minL = 1;
        for (let dy = 0; dy < LUM_SAMPLE_SUPER; dy++)
          for (let dx = 0; dx < LUM_SAMPLE_SUPER; dx++) {
            const l = inkFromRgba(data, ((y * LUM_SAMPLE_SUPER + dy) * LUM_SAMPLE_PX + (x * LUM_SAMPLE_SUPER + dx)) * 4);
            if (l < minL) minL = l;
          }
        raw[y * BOX_SIZE + x] = minL;
      }
    lum = gaussianBlurFloat32(raw, BOX_SIZE, BOX_SIZE, PHOTO_BLUR_SIGMA);
    threshold = otsuInkThreshold(lum);
  }
  console.log(`[harness] trace path: ${useAlpha ? "alpha" : "luminance"} (transparent ${(transparentFrac * 100).toFixed(1)}%, threshold ${threshold!.toFixed(2)})`);

  const binary = new Uint8Array(BOX_SIZE * BOX_SIZE);
  for (let i = 0; i < binary.length; i++) binary[i] = lum![i] >= threshold! ? 1 : 0;
  const labels = labelConnectedComponents4(binary, BOX_SIZE, BOX_SIZE);
  let maxLabel = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
  const counts = new Array<number>(maxLabel + 1).fill(0);
  for (let i = 0; i < labels.length; i++) if (labels[i] > 0) counts[labels[i]]++;
  const entries = [];
  for (let L = 1; L <= maxLabel; L++) if (counts[L] > 0) entries.push({ label: L, count: counts[L] });
  entries.sort((a, b) => b.count - a.count);
  if (entries.length === 0) throw new Error("no foreground");

  const filled = new Uint8Array(BOX_SIZE * BOX_SIZE);
  fillLineMaskSignificantComponents(labels, entries, 0, filled, BOX_SIZE, BOX_SIZE);
  const outline = filledSilhouetteToLineArtMask(filled, BOX_SIZE, BOX_SIZE, PHOTO_LINE_ART_OUTLINE_LAYERS);
  const contour = extractNormalizedContourFromLineMask(outline, DEFAULT_CONTOUR_LEVEL, BOX_SIZE, BOX_SIZE);
  if (!contour || contour.length < 4) throw new Error("contour too short");
  return contour as { x: number; y: number }[];
}

// --- rendering -------------------------------------------------------------
const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

async function renderRoute(coords: [number, number][], file: string, w = 620, h = 620) {
  // normalize to [lat,lng]
  const pts = coords.map(
    (c) => (Math.abs(c[0]) > 90 ? [c[1], c[0]] : c) as [number, number],
  );
  let zoom = 12;
  for (let z = 16; z >= 10; z--) {
    const xs = pts.map((p) => lonToX(p[1], z));
    const ys = pts.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.85 && Math.max(...ys) - Math.min(...ys) <= h * 0.85) {
      zoom = z;
      break;
    }
  }
  const xs = pts.map((p) => lonToX(p[1], zoom));
  const ys = pts.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2;
  const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: sharp.OverlayOptions[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      try {
        const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
          headers: { "User-Agent": "pace-casso harness (dev)" },
        });
        if (!res.ok) continue;
        tiles.push({
          input: Buffer.from(await res.arrayBuffer()),
          left: Math.round(tx * TILE - vx),
          top: Math.round(ty * TILE - vy),
        });
      } catch {
        /* tile miss is fine */
      }
    }
  }
  const d = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`)
    .join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${d}" fill="none" stroke="#7f1024" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>` +
      `<path d="${d}" fill="none" stroke="#e8253f" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  );
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eee" } })
    .composite([...tiles, { input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(file);
}

// --- main -------------------------------------------------------------------
function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function main() {
  await loadEnv();
  const imagePath = arg("image", "gas.png");
  const visionArg = arg("vision", "dead");
  const outDir = arg("out", "tmp-autofind-harness/run");
  await fs.mkdir(outDir, { recursive: true });

  const mode: VisionMode =
    visionArg === "dead"
      ? { kind: "dead" }
      : { kind: "drafts", payload: JSON.parse(await fs.readFile(visionArg, "utf8")) };
  const stats = installFetchStub(mode);

  console.log(`[harness] tracing ${imagePath} via production trace path...`);
  const contour = await traceImageProductionPath(imagePath);
  console.log(`[harness] contour: ${contour.length} points`);

  const imageBase64 = (await fs.readFile(imagePath)).toString("base64");

  const { autoFindTop5 } = await import("../lib/autoFindTop5");
  const { MANHATTAN_PRESET } = await import("../lib/cityPresets");

  console.log(`[harness] running autoFindTop5 (vision=${visionArg})...`);
  const t0 = Date.now();
  const result = await autoFindTop5(contour, MANHATTAN_PRESET, {
    anchorSource: "image",
    imageBase64,
    imageSourceName: path.basename(imagePath),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(
    `[harness] done in ${secs}s: ${result.picks.length} picks, visionUsed=${result.visionUsed}, snapFailures=${result.snapFailures ?? 0}, relaxedQuality=${result.relaxedQuality ?? false}, mapboxCalls=${stats.mapboxCalls}`,
  );

  const summary: unknown[] = [];
  const cell = 620;
  const composites: sharp.OverlayOptions[] = [];
  for (let i = 0; i < result.picks.length; i++) {
    const p = result.picks[i];
    const coords = (p.snappedRoute?.coordinates ?? p.routeCoords ?? []) as [number, number][];
    console.log(
      `  pick ${i + 1}: ${p.distanceKm?.toFixed(1)} km, quality=${p.qualityScore}, shape=${p.shapeMatchScore}, ${String(p.reason ?? "").slice(0, 70)}`,
    );
    summary.push({
      i,
      distanceKm: p.distanceKm,
      qualityScore: p.qualityScore,
      shapeMatchScore: p.shapeMatchScore,
      sourceMatchScore: p.sourceMatchScore,
      reason: p.reason,
      coordsCount: coords.length,
    });
    const file = path.join(outDir, `pick-${i + 1}.png`);
    if (coords.length > 1) await renderRoute(coords, file);
    composites.push({
      input: await sharp(file).resize(cell, cell, { fit: "contain", background: "#fff" }).png().toBuffer(),
      left: 10 + (i % 3) * (cell + 10),
      top: 60 + Math.floor(i / 3) * (cell + 70),
    });
    composites.push({
      input: Buffer.from(
        `<svg width="${cell}" height="40"><text x="8" y="26" font-family="Arial" font-size="19" font-weight="700" fill="#111">#${i + 1}: ${p.distanceKm?.toFixed(1)}km q=${p.qualityScore} shape=${p.shapeMatchScore}</text></svg>`,
      ),
      left: 10 + (i % 3) * (cell + 10),
      top: 20 + Math.floor(i / 3) * (cell + 70),
    });
  }
  if (result.picks.length > 0) {
    const rows = Math.ceil(result.picks.length / 3);
    await sharp({
      create: { width: cell * 3 + 40, height: 60 + rows * (cell + 70), channels: 4, background: "#fff" },
    })
      .composite(composites)
      .png()
      .toFile(path.join(outDir, "TOP5.png"));
  }
  await fs.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify({ visionMode: visionArg, contourPoints: contour.length, secs: Number(secs), stats, picks: summary }, null, 2),
    "utf8",
  );
  console.log(`[harness] wrote ${outDir}/TOP5.png`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
