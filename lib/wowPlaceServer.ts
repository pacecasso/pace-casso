/**
 * Server-only orchestration for /api/wow-place — the verified placement
 * funnel (WOW.md, 2026-07-26) generalized to arbitrary uploads.
 *
 * Recipe (each stage measured in the July 2026 series):
 *  1. NAME the subject from the user's approved line art with one vision
 *     call (the "stage-A gate" — art that doesn't read on paper never reads
 *     on streets; SURVIVABILITY.md).
 *  2. SWEEP placements across Manhattan on the walk graph's giant component,
 *     trace through real streets, clean snap spurs, gate for runnability
 *     (lib/wowFunnel.ts — pure CPU).
 *  3. SCREEN the tightest candidates with the primed judge ("intended to
 *     depict X — how well does it read, 1-10?"), which correlates 0.647
 *     with blind recognition vs 0.142 for the numeric scorer (FINAL-TWO.md).
 *     Nothing that scored primed < 6 has ever gone blind 3/3, so picks
 *     below 6 are not shown — an honest "no strong route" beats a tangle.
 *
 * Server-only: imports sharp (native) — never import from client components.
 */
import sharp from "sharp";
import { getStreetGraph, type LatLng, type NormalizedPoint } from "./streetGraphTrace";
import {
  type Pt,
  type WowCandidate,
  type WowGraph,
  MANHATTAN_CENTERS,
  CENTRAL_PARK_BOX,
  getGiantComponentMask,
  placeSegments,
  shortestGraphPath,
  nearestGiantNode,
  sweepPlacements,
  candidateScore,
  chainsKm,
  contourToStrokes,
  strokesInkRatio,
} from "./wowFunnel";

const JUDGE_MODEL = "claude-opus-4-8"; // measurement parity with the July series
const PRIMED_KEEP_THRESHOLD = 6;
const SCREEN_COUNT = 16;
const MAX_PICKS = 5;

export type WowPlaceProgress = (detail: string) => void;

export type WowPlacePick = {
  center: [number, number];
  rotDeg: number;
  extentM: number;
  km: number;
  dev: number;
  primed: number;
  /** full route, strokes joined by real street connectors */
  coordinates: [number, number][];
  /** placed (pre-trace) contour, original point order — Step 2's anchor line */
  anchorLatLngs: [number, number][];
  previewPngBase64: string;
};

export type WowPlaceResult = {
  picks: WowPlacePick[];
  subject: string | null;
  subjectConfidence: number | null;
  /** honest explanation when picks is empty */
  message?: string;
  /** when refused: the best screened candidate as the judge saw it */
  refusedPreviewPngBase64?: string;
  refusedPreviewScore?: number;
};

// ---------------------------------------------------------------------------
// Rendering (plain style — identical to the offline rig the judges scored)
// ---------------------------------------------------------------------------
function pathsSvg(polys: [number, number][][], w: number, h: number): string {
  const ds = polys.map((pts) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" "),
  );
  return (
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="100%" height="100%" fill="#ededed"/>` +
    ds
      .map(
        (d) =>
          `<path d="${d}" fill="none" stroke="#7f1024" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>` +
          `<path d="${d}" fill="none" stroke="#e8253f" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
      .join("") +
    `</svg>`
  );
}

export async function renderChainsPng(chains: LatLng[][], w = 620, h = 620): Promise<Buffer> {
  const all = chains.flat();
  const lat0 = all[0]![0];
  const mPerLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const proj = (c: LatLng): [number, number] => [c[1] * mPerLng, c[0] * 111320];
  const pts = all.map(proj);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const s = (Math.min(w, h) * 0.86) / span;
  const ox = (w - (maxX - minX) * s) / 2;
  const oy = (h - (maxY - minY) * s) / 2;
  const polys = chains.map((ch) =>
    ch.map(proj).map((p): [number, number] => [ox + (p[0] - minX) * s, h - oy - (p[1] - minY) * s]),
  );
  return sharp(Buffer.from(pathsSvg(polys, w, h))).png().toBuffer();
}

export async function renderStrokesPng(strokes: Pt[][], w = 620, h = 620): Promise<Buffer> {
  const all = strokes.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const s = (Math.min(w, h) * 0.86) / span;
  const ox = (w - (maxX - minX) * s) / 2;
  const oy = (h - (maxY - minY) * s) / 2;
  const polys = strokes.map((seg) =>
    seg.map((p): [number, number] => [ox + (p[0] - minX) * s, h - oy - (p[1] - minY) * s]),
  );
  return sharp(Buffer.from(pathsSvg(polys, w, h))).png().toBuffer();
}

// ---------------------------------------------------------------------------
// Vision calls
// ---------------------------------------------------------------------------
export type JudgeMedia = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

async function visionCall(
  apiKey: string,
  png: Buffer,
  prompt: string,
  leadImage?: { data: string; media: JudgeMedia },
): Promise<string | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            ...(leadImage
              ? [
                  {
                    type: "image",
                    source: { type: "base64", media_type: leadImage.media, data: leadImage.data },
                  },
                ]
              : []),
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join(" ")
    .trim();
  return text || null;
}

/** Stage-A gate: what does the user's line art depict? */
export async function nameSubject(
  apiKey: string,
  contourPng: Buffer,
): Promise<{ guess: string; confidence: number } | null> {
  const text = await visionCall(
    apiKey,
    contourPng,
    'This is line art a runner wants to "draw" with a GPS route. What does it depict? Reply in this exact format:\nGUESS: <1-3 words, or "nothing recognizable">\nCONFIDENCE: <0-10>',
  );
  if (!text) return null;
  const m = text.match(/GUESS:\s*(.+?)\s*CONFIDENCE:\s*(\d+)/is);
  if (!m) return null;
  return { guess: m[1]!.trim().replace(/\s+/g, " "), confidence: Number(m[2]) };
}

/** Primed judge: told the subject, scores how well a candidate reads (1-10). */
async function primedScore(apiKey: string, png: Buffer, subject: string): Promise<number | null> {
  const text = await visionCall(
    apiKey,
    png,
    `This running route is intended to depict: ${subject}. How well does it read, 1-10? Reply in this exact format:\nSCORE: <1-10>\nWHY: <short phrase>`,
  );
  const m = text?.match(/SCORE:\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Comparative judge for composite artwork: sees the user's ORIGINAL upload
 * beside the candidate street render and scores likeness. Same prompt and
 * calibrated scale as the interpret step (a Ralph-accepted full-logo street
 * render scores 6-7; a wrong image scores 2). Used instead of primedScore
 * when the contour is a whole-composition redraw — no short subject phrase
 * describes a multi-element logo well enough for the primed question to be
 * fair ("a person wearing headphones" scored a pump+figure+hose route 3/10).
 */
async function comparativeScore(
  apiKey: string,
  png: Buffer,
  original: { data: string; media: JudgeMedia },
): Promise<number | null> {
  const text = await visionCall(
    apiKey,
    png,
    "The second image is a bold one-line redraw of the first, quantized to a city street grid so a runner can draw it with a GPS route. Score how recognizable it is as a simplified version of the first image — same elements, same arrangement, same identity. Reply in this exact format:\nSCORE: <0-10>\nWHY: <short phrase>",
    original,
  );
  const m = text?.match(/SCORE:\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Route assembly
// ---------------------------------------------------------------------------
/** Join per-stroke chains into one runnable line via real street connectors. */
export function joinChains(g: WowGraph, chains: LatLng[][]): LatLng[] {
  const mask = getGiantComponentMask(g);
  const out: LatLng[] = [];
  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i]!;
    if (i > 0 && out.length && chain.length) {
      const a = nearestGiantNode(g, mask, out[out.length - 1]!);
      const b = nearestGiantNode(g, mask, chain[0]!);
      if (a.id >= 0 && b.id >= 0) {
        const p = shortestGraphPath(g, a.id, b.id);
        if (p) for (const n of p) out.push(g.coord[n]!);
      }
    }
    out.push(...chain);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export async function runWowPlacement(args: {
  apiKey: string;
  contour: NormalizedPoint[];
  /**
   * When the sketch was produced by the AI redraw step, its subject was
   * already blind-verified upstream — pass it through so the placement
   * judge screens against the RIGHT reading instead of re-guessing (a
   * re-guess measurably drifts: a verified "headphones" redraw got
   * re-read as "snail" and verified against that).
   */
  knownSubject?: string;
  /**
   * When the contour is a whole-composition (composite/logo) redraw, the
   * original upload — candidates are then judged on LIKENESS to it
   * (comparativeScore) instead of the primed single-subject question.
   */
  originalImage?: { data: string; media: JudgeMedia };
  targetDistanceKm?: number;
  onProgress?: WowPlaceProgress;
}): Promise<WowPlaceResult> {
  const progress = args.onProgress ?? (() => {});
  const strokes = contourToStrokes(args.contour);
  if (!strokes.length || strokes.flat().length < 8) {
    return { picks: [], subject: null, subjectConfidence: null, message: "Not enough sketch detail to place." };
  }

  let subject: string;
  let namedConfidence: number | null = null;
  if (args.knownSubject) {
    subject = args.knownSubject;
  } else {
    progress("Reading your art…");
    const contourPng = await renderStrokesPng(strokes);
    const named = await nameSubject(args.apiKey, contourPng);
    if (!named || /nothing recognizable/i.test(named.guess) || named.confidence < 3) {
      return {
        picks: [],
        subject: named?.guess ?? null,
        subjectConfidence: named?.confidence ?? null,
        message:
          "Honest check: your line art doesn't yet read as a clear subject on its own, so streets will only blur it further. Bold, simple, closed shapes work best — try the touch-up step.",
      };
    }
    subject = named.guess;
    namedConfidence = named.confidence;
  }

  progress(`Looks like ${subject} — testing placements across Manhattan…`);
  const g = (await getStreetGraph()) as WowGraph;
  const minKm = args.targetDistanceKm ? Math.max(4, args.targetDistanceKm * 0.7) : 7;
  const maxKm = args.targetDistanceKm ? Math.min(42, args.targetDistanceKm * 1.5) : 26;

  // Size the canvas from the artwork: route km scales with the contour's
  // ink-length-to-span ratio, so detailed art gets a smaller canvas instead
  // of dying wholesale on the distance gate (gas.png: 2-piece dense contour
  // exceeded 26 km at EVERY fixed extent and returned zero candidates).
  const inkRatio = strokesInkRatio(strokes);
  const STREET_FACTOR = 1.25; // measured snap overhead vs straight-line ink
  const extentForKm = (km: number) => (km * 1000) / (inkRatio * STREET_FACTOR);
  const extents = [0.15, 0.4, 0.65, 0.9]
    .map((t) => extentForKm(minKm + t * (maxKm - minKm)))
    .map((e) => Math.round(Math.min(4200, Math.max(1100, e))))
    .filter((e, i, arr) => arr.indexOf(e) === i);
  if (extentForKm(minKm) > 4200) {
    return {
      picks: [],
      subject,
      subjectConfidence: namedConfidence,
      message: `We read your art as ${subject}, but it has so much line detail that even at Manhattan-filling size the route would run about ${Math.round(inkRatio * 4.2 * STREET_FACTOR)} km. Simplify the sketch in the touch-up step (fewer wiggles, bolder outline) and try again.`,
    };
  }

  const candidates: WowCandidate[] = [];
  for (let i = 0; i < MANHATTAN_CENTERS.length; i++) {
    candidates.push(
      ...sweepPlacements(g, strokes, {
        centers: [MANHATTAN_CENTERS[i]!],
        extentsM: extents,
        mirrors: [false], // mirrored art can't round-trip through the manual editor
        minKm,
        maxKm,
        avoidBox: CENTRAL_PARK_BOX,
      }),
    );
    progress(`Testing placements across Manhattan… (${i + 1}/${MANHATTAN_CENTERS.length} areas)`);
    // The sweep is synchronous CPU work; without yielding, every enqueued
    // progress line buffers until the whole sweep finishes and the user
    // stares at a dead button for a minute (observed with gas.png).
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!candidates.length) {
    return {
      picks: [],
      subject,
      subjectConfidence: namedConfidence,
      message: `We read your art as ${subject}, but couldn't fit it as a runnable ${minKm.toFixed(0)}-${maxKm.toFixed(0)} km route on real streets (tried canvas sizes ${Math.min(...extents)}-${Math.max(...extents)} m). Try a different target distance, or simplify the shape.`,
    };
  }

  // Rank by the combined quality score (clean lines + shape fidelity), but
  // screen a ROTATION-DIVERSE set: geometry scoring alone favored tilted
  // placements, and orientation-bound subjects (mugs, houses) stop reading
  // when tilted — a paper-9 mug screened only ±29° placements and scored
  // 3/10. Upright candidates always get seats; the judge arbitrates.
  const byRot = new Map<number, WowCandidate[]>();
  for (const c of candidates) {
    if (!byRot.has(c.rotDeg)) byRot.set(c.rotDeg, []);
    byRot.get(c.rotDeg)!.push(c);
  }
  const rotGroups = [...byRot.entries()]
    .sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))
    .map(([, list]) => list.sort((a, b) => candidateScore(a) - candidateScore(b)));
  const screenSet: WowCandidate[] = [];
  for (let i = 0; screenSet.length < SCREEN_COUNT; i++) {
    let added = false;
    for (const group of rotGroups) {
      if (i < group.length && screenSet.length < SCREEN_COUNT) {
        screenSet.push(group[i]!);
        added = true;
      }
    }
    if (!added) break;
  }
  progress(`Asking the judge about the ${screenSet.length} tightest fits…`);
  const judgeOnce = (png: Buffer) =>
    args.originalImage
      ? comparativeScore(args.apiKey, png, args.originalImage)
      : primedScore(args.apiKey, png, subject);
  const scored = await Promise.all(
    screenSet.map(async (c) => {
      const png = await renderChainsPng(c.segments);
      let score = await judgeOnce(png);
      if (score == null) {
        // one retry — a transient judge failure must not read as "0/10"
        score = await judgeOnce(png);
      }
      return { c, png, score: score ?? 0 };
    }),
  );
  const keepers = scored
    .filter((s) => s.score >= PRIMED_KEEP_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.c.dev - b.c.dev)
    .slice(0, MAX_PICKS);

  if (!keepers.length) {
    const bestScored = scored.slice().sort((a, b) => b.score - a.score)[0];
    return {
      picks: [],
      subject,
      subjectConfidence: namedConfidence,
      message: `We read your art as ${subject} and traced ${candidates.length} street placements, but the judge scored the best only ${bestScored?.score ?? 0}/10 — below the bar where routes reliably read. We'd rather say so than show you a tangle. Simpler/bolder shapes score higher.`,
      refusedPreviewPngBase64: bestScored?.png.toString("base64"),
      refusedPreviewScore: bestScored?.score,
    };
  }

  progress("Building your verified picks…");
  const picks: WowPlacePick[] = [];
  for (const k of keepers) {
    const placedStrokes = placeSegments(strokes, k.c.center, k.c.extentM, k.c.rotDeg, false);
    const joined = joinChains(g, k.c.segments);
    picks.push({
      center: k.c.center,
      rotDeg: k.c.rotDeg,
      extentM: k.c.extentM,
      km: Number(chainsKm([joined]).toFixed(2)),
      dev: k.c.dev,
      primed: k.score,
      coordinates: joined.map(([lat, lng]) => [lat, lng]),
      anchorLatLngs: placedStrokes.flat().map(([lat, lng]) => [lat, lng]),
      previewPngBase64: k.png.toString("base64"),
    });
  }
  return { picks, subject, subjectConfidence: namedConfidence };
}
