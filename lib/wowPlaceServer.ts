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
 *  4. BLIND-VERIFY the screened favorites (Aug 10, Ralph-approved): a
 *     judge shown the route with ZERO context must name the subject, three
 *     times out of three, before a pick is shown. The primed screen is only
 *     the orderer — the Aug 10 audit measured it over-accepting (primed 9
 *     routes blind-read as "dog"/"airplane"), while the July offline recipe
 *     that hit 77.8% required exactly this blind name-match. Composite
 *     (likeness-judged) runs keep the Ralph-calibrated comparative gate.
 *
 * Server-only: imports sharp (native) — never import from client components.
 */
import sharp from "sharp";
import { subjectLabelsMatchLoose } from "./subjectMatch";
import { getServerMapboxToken } from "./mapboxServerToken";
import { encodePolyline } from "./polylineEncode";
import { simplifyLatLng } from "./douglasPeucker";
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
  strokesAxisAlignment,
} from "./wowFunnel";

const JUDGE_MODEL = "claude-opus-4-8"; // measurement parity with the July series
const PRIMED_KEEP_THRESHOLD = 6;
const SCREEN_COUNT = 16;
const MAX_PICKS = 5;
/** Blind gate: every shown pick needs this many zero-context name-matches. */
const BLIND_RUNS = 3;
/** Blind gate: stop after this many verified picks... */
const BLIND_PICKS_TARGET = 3;
/**
 * ...or after burning this many candidates without enough passes. Deeper
 * than the primed keeper list (Aug 10, Ralph: "a system where a user
 * uploads an image and it gets denied is not a system"): when the primed
 * favorites fail blind, keep walking down the screened list before
 * refusing — recall costs judge calls, never standards.
 */
const BLIND_VERIFY_MAX_CANDIDATES = 10;
/** Stage-1 naming samples — majority wins; total disagreement refuses. */
const NAMING_SAMPLES = 3;

// Rectilinear art placed on organic streets staircases into mush — Ralph's
// July 29 verdict on a SoHo-placed logo: "just messy and less obvious...
// I wouldn't know yours is the logo", vs the same composition hand-placed
// on the Midtown grid: "no doubt it is". Art above this rectilinearity
// (measured: logo drafts 0.79-0.89, robot 0.97, round map-pin 0.35) is
// swept ONLY over numbered-grid centers at the grid-aligned rotation
// (artwork verticals riding avenues, bearing ~29 deg east of north).
const GRID_ART_RECTILINEARITY = 0.65;
// -29: artwork verticals ride the avenues (v5's grid frame). 61: verticals
// ride the cross-streets instead — also grid-legal, doubles the pool.
const GRID_ROTATIONS_DEG = [-29, 61];
// MANHATTAN_CENTERS minus the organic downtown/Village areas (lat < 40.744
// west side, plus the 40.715/40.722 rows) — Chelsea through UWS/UES grid,
// densified after a 21-candidate pool starved a live run into refusal.
const GRID_CENTERS: LatLng[] = [
  [40.7375, -73.99],
  [40.7445, -73.997],
  [40.7445, -73.984],
  [40.751, -73.997],
  [40.751, -73.984],
  [40.755, -73.99],
  [40.758, -73.997],
  [40.758, -73.984],
  [40.744, -73.977],
  [40.7635, -73.984],
  [40.77, -73.955],
  [40.778, -73.958],
  [40.787, -73.972],
  [40.794, -73.968],
];

export type WowPlaceProgress = (detail: string) => void;

export type WowPlacePick = {
  center: [number, number];
  rotDeg: number;
  extentM: number;
  km: number;
  dev: number;
  primed: number;
  /**
   * What a zero-context judge called this route, 3 runs out of 3, before it
   * was shown. Absent on composite (likeness-judged) picks, which keep the
   * Ralph-calibrated comparative gate instead.
   */
  blindGuess?: string;
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
  // Screening bursts ~16 judge calls at once — transient 429/5xx/network
  // failures are routine and a silently-null judge reads as "0/10".
  // Retry twice with backoff before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    try {
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
      if (!res.ok) {
        if (res.status !== 429 && res.status < 500) return null;
        continue;
      }
      const json = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = (json.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ")
        .trim();
      return text || null;
    } catch {
      /* network failure — retry */
    }
  }
  return null;
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

/** Text-only call (no image) — used for label-equivalence checks. */
async function textCall(apiKey: string, prompt: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: JUDGE_MODEL,
          max_tokens: 64,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        }),
      });
      if (!res.ok) {
        if (res.status !== 429 && res.status < 500) return null;
        continue;
      }
      const json = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = (json.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ")
        .trim();
      return text || null;
    } catch {
      /* network failure — retry */
    }
  }
  return null;
}

/**
 * Do two free-text labels name the same visual subject? Deterministic word
 * match first (free); a text-model yes/no only for the synonym gap ("cross"
 * vs "plus sign"). This never shows the judge an image, so it cannot prime
 * the blind naming calls — it only reconciles their vocabulary. Memoized:
 * the same pair recurs across candidates within one placement run.
 */
const sameSubjectMemo = new Map<string, boolean>();
async function sameSubject(apiKey: string, a: string, b: string): Promise<boolean> {
  if (subjectLabelsMatchLoose(a, b)) return true;
  const key = [a.toLowerCase().trim(), b.toLowerCase().trim()].sort().join("|");
  const cached = sameSubjectMemo.get(key);
  if (cached !== undefined) return cached;
  const text = await textCall(
    apiKey,
    `Do "${a}" and "${b}" name the same visual subject (the same thing a person would say a simple line drawing depicts)? Reply with exactly YES or NO.`,
  );
  const verdict = /^\s*yes\b/i.test(text ?? "");
  sameSubjectMemo.set(key, verdict);
  return verdict;
}

/**
 * Stage-1 naming, majority-of-N: single-sample naming measurably misreads
 * multi-stroke marks (Aug 10 audit: a peace sign named "circle" was then
 * VERIFIED as a circle and shipped wrong). Three samples; a guess must
 * agree with at least one other to win. Total disagreement is an honest
 * refusal — art that reads three different ways will not survive streets.
 */
async function nameSubjectMajority(
  apiKey: string,
  contourPng: Buffer,
): Promise<
  | { ok: true; guess: string; confidence: number }
  | { ok: false; guesses: string[] }
> {
  const named = (
    await Promise.all(
      Array.from({ length: NAMING_SAMPLES }, () => nameSubject(apiKey, contourPng)),
    )
  ).filter((n): n is { guess: string; confidence: number } => n !== null);
  const usable = named.filter(
    (n) => !/nothing recognizable/i.test(n.guess) && n.confidence >= 3,
  );
  if (!usable.length) return { ok: false, guesses: named.map((n) => n.guess) };
  for (let i = 0; i < usable.length; i++) {
    let agree = 0;
    let confidence = usable[i]!.confidence;
    for (let j = 0; j < usable.length; j++) {
      if (i === j) continue;
      if (await sameSubject(apiKey, usable[i]!.guess, usable[j]!.guess)) {
        agree++;
        confidence = Math.max(confidence, usable[j]!.confidence);
      }
    }
    if (agree >= 1) return { ok: true, guess: usable[i]!.guess, confidence };
  }
  // One usable sample and nothing to agree with: trust it only when the
  // other samples failed outright (API), not when they disagreed.
  if (usable.length === 1 && named.length === 1) {
    return { ok: true, guess: usable[0]!.guess, confidence: usable[0]!.confidence };
  }
  return { ok: false, guesses: named.map((n) => n.guess) };
}

/**
 * Render the JOINED route on a real map (Mapbox Static, light style) — the
 * same kind of image the calibrated blind-squint instrument judges. The
 * plain gray render measurably over-reads: a martini that passed 3/3 on
 * plain gray blind-read as "dog" on the map crop (Aug 10). Falls back to
 * the plain render when the static image can't be fetched, so an API
 * hiccup degrades the instrument rather than crashing the funnel.
 */
async function renderJoinedRouteMapPng(joined: LatLng[]): Promise<Buffer | null> {
  const token = getServerMapboxToken();
  if (!token || joined.length < 2) return null;
  // Static API URLs cap around 8 KB — simplify until the encoding fits.
  // The encoding appears TWICE (casing + line), so each must stay small.
  let encoded: string | null = null;
  for (const tolM of [4, 8, 14, 22, 35, 60, 90]) {
    const simplified = simplifyLatLng(joined as [number, number][], tolM);
    const enc = encodePolyline(simplified as [number, number][]);
    if (enc.length <= 2700) {
      encoded = enc;
      break;
    }
  }
  if (!encoded) return null;
  // Instrument parity (Aug 10): judge the picture the calibrated external
  // instrument judges — a BUSY street map (streets-v12, not the pale
  // light-v11) with the blind-squint rig's thick dark-casing + red line.
  // The pale/thin render measurably over-read: a bolt passed internally
  // 3/3 as "lightning bolt" and externally blind-read "handgun" 3/3.
  const enc = encodeURIComponent(encoded);
  const path = `path-8+7f1024-0.95(${enc}),path-4+e8253f(${enc})`;
  const url = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${path}/auto/620x620?padding=30&access_token=${token}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status < 500 && res.status !== 429) return null;
    } catch {
      /* retry once */
    }
  }
  return null;
}

/**
 * The acceptance gate (Aug 10): a judge shown ONLY the route render — no
 * subject, no context — must name the subject on every one of BLIND_RUNS
 * tries. This is the same instrument as scripts/blind-squint-test.mjs, the
 * only judge that has ever predicted human recognition.
 */
async function blindVerify(
  apiKey: string,
  png: Buffer,
  subject: string,
): Promise<{ passed: boolean; guess: string | null }> {
  const runs = await Promise.all(
    Array.from({ length: BLIND_RUNS }, () => nameSubject(apiKey, png)),
  );
  let guess: string | null = null;
  for (const run of runs) {
    if (!run || /nothing recognizable/i.test(run.guess)) return { passed: false, guess: run?.guess ?? null };
    if (!(await sameSubject(apiKey, run.guess, subject))) {
      return { passed: false, guess: run.guess };
    }
    guess = run.guess;
  }
  return { passed: guess !== null, guess };
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
  /**
   * "auto" (default): rectilinear art sweeps only the numbered grid at
   * grid-aligned rotations. "island": always sweep the full island —
   * for MIXED-geometry art (a boxy pump + a round head) the grid branch
   * kills the curved features; measured Aug 11: the grid branch produced
   * zero externally-verified winners across five audit runs while the
   * full-island sweep produced all of them.
   */
  sweepMode?: "auto" | "island";
  /**
   * Orientation-bound subjects (standing/walking figures, houses,
   * envelopes): sweep only near-upright rotations. PIPELINE-GAP measured
   * free rotation as fatal for this class ("a plus sign rotated 45 deg
   * stops being a plus sign"); the island sweep's geometric scoring
   * otherwise prefers tilted grid-aligned placements.
   */
  uprightOnly?: boolean;
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
    const named = await nameSubjectMajority(args.apiKey, contourPng);
    if (!named.ok) {
      const disagreement = named.guesses.filter(Boolean).join('", "');
      return {
        picks: [],
        subject: named.guesses[0] ?? null,
        subjectConfidence: null,
        message: disagreement
          ? `Honest check: independent judges read your line art as "${disagreement}" — it doesn't read as ONE clear subject yet, so streets will only blur it further. Bold, simple, closed shapes work best — try the touch-up step.`
          : "Honest check: your line art doesn't yet read as a clear subject on its own, so streets will only blur it further. Bold, simple, closed shapes work best — try the touch-up step.",
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
  const axis = strokesAxisAlignment(strokes);
  const gridArt = axis.rectilinearity >= GRID_ART_RECTILINEARITY;
  // Align the art's OWN dominant axis with the grid, not shape-space
  // vertical — rectilinear art drawn along tilted axes would otherwise be
  // swept at rotations that leave every line off the grid.
  const gridRotations = GRID_ROTATIONS_DEG.map((r) => Math.round(r - axis.dominantDeg));
  const STREET_FACTOR = 1.25; // measured snap overhead vs straight-line ink
  const extentForKm = (km: number) => (km * 1000) / (inkRatio * STREET_FACTOR);
  // Grid art searches a restricted center/rotation set, so it gets more
  // canvas sizes to keep the candidate pool healthy (measured July 30:
  // 9 centers x 1 rotation x 4 extents left only 21 candidates and the
  // whole run refused on one weak draft).
  const extents = (gridArt ? [0.05, 0.25, 0.45, 0.65, 0.85, 1] : [0.15, 0.4, 0.65, 0.9])
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

  const runSweep = async (centers: LatLng[], rotationsDeg?: number[]): Promise<WowCandidate[]> => {
    const found: WowCandidate[] = [];
    for (let i = 0; i < centers.length; i++) {
      found.push(
        ...sweepPlacements(g, strokes, {
          centers: [centers[i]!],
          extentsM: extents,
          rotationsDeg,
          mirrors: [false], // mirrored art can't round-trip through the manual editor
          minKm,
          maxKm,
          avoidBox: CENTRAL_PARK_BOX,
        }),
      );
      progress(`Testing placements across Manhattan… (${i + 1}/${centers.length} areas)`);
      // The sweep is synchronous CPU work; without yielding, every enqueued
      // progress line buffers until the whole sweep finishes and the user
      // stares at a dead button for a minute (observed with gas.png).
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return found;
  };

  // Straight-edged art must sit ON the numbered grid, aligned to it —
  // organic-street placements staircase every clean line (Ralph: "messy and
  // less obvious"). Fall back to the full sweep only if the grid has no fit.
  let candidates: WowCandidate[];
  const useGridBranch = gridArt && args.sweepMode !== "island";
  let widenedAlready = !useGridBranch;
  if (useGridBranch) {
    progress("Straight-edged art — placing on the street grid, aligned to the avenues…");
    candidates = await runSweep(GRID_CENTERS, gridRotations);
    if (!candidates.length) {
      progress("No grid-aligned fit — widening the search…");
      candidates = await runSweep(MANHATTAN_CENTERS, args.uprightOnly ? [-8, 0, 8] : undefined);
      widenedAlready = true;
    }
  } else {
    candidates = await runSweep(MANHATTAN_CENTERS, args.uprightOnly ? [-8, 0, 8] : undefined);
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
  const judgeOnce = (png: Buffer) =>
    args.originalImage
      ? comparativeScore(args.apiKey, png, args.originalImage)
      : primedScore(args.apiKey, png, subject);
  const screenAndJudge = async (pool: WowCandidate[]) => {
    const byRot = new Map<number, WowCandidate[]>();
    for (const c of pool) {
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
    return Promise.all(
      screenSet.map(async (c) => {
        const png = await renderChainsPng(c.segments);
        let score = await judgeOnce(png);
        if (score == null) {
          // one retry — a transient judge failure must not read as "0/10"
          score = await judgeOnce(png);
        }
        return { c, png, score: score ?? 0, judgeFailed: score == null };
      }),
    );
  };
  const pickKeepers = (scored: { c: WowCandidate; png: Buffer; score: number }[]) =>
    scored
      .filter((s) => s.score >= PRIMED_KEEP_THRESHOLD)
      // Cleanness breaks judge-score ties: the judge can't rank within its
      // passing band (measured — it scores clean and wobbly the same 6-7),
      // but low jitter is exactly what the owner reads as "obvious" vs
      // "messy". dev breaks remaining ties toward shape fidelity.
      .sort((a, b) => b.score - a.score || a.c.jitter - b.c.jitter || a.c.dev - b.c.dev)
      .slice(0, MAX_PICKS);

  let scored = await screenAndJudge(candidates);
  let keepers = pickKeepers(scored);
  // Pool-starvation guard (live failure, July 30): a thin grid pool plus a
  // weak draft refused at 4/10 without ever trying the rest of the island.
  // The refusal only wins over organic-street placements when the island
  // ALSO has nothing above the bar.
  if (!keepers.length && !widenedAlready) {
    progress("Grid placements didn't clear the bar — trying the whole island…");
    // The grid pass already judged GRID_CENTERS at -29; the island sweep
    // re-produces those (shared centers x rot -29) — drop the duplicates so
    // the same route isn't judged twice or shown as two identical picks.
    const seenPlacement = new Set(candidates.map((c) => `${c.center[0]},${c.center[1]}|${c.extentM}|${c.rotDeg}`));
    const widened = (await runSweep(MANHATTAN_CENTERS, args.uprightOnly ? [-8, 0, 8] : undefined)).filter(
      (c) => !seenPlacement.has(`${c.center[0]},${c.center[1]}|${c.extentM}|${c.rotDeg}`),
    );
    if (widened.length) {
      candidates = candidates.concat(widened);
      scored = scored.concat(await screenAndJudge(widened));
      keepers = pickKeepers(scored);
    }
  }

  if (!keepers.length) {
    // Every judge call failing is OUR outage (API 529 wave), not a verdict
    // on the art — refusing with "scored 0/10" blames the user wrongly.
    if (scored.length && scored.every((s) => s.judgeFailed)) {
      return {
        picks: [],
        subject,
        subjectConfidence: namedConfidence,
        message:
          "Our route-judging service is overloaded right now — this isn't about your art. Please try again in a few minutes.",
      };
    }
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

  // THE ACCEPTANCE GATE (Aug 10, Ralph: "that's how it should be"): the
  // primed screen above only ORDERS candidates — it measurably over-accepts
  // (primed-9 routes blind-read as "dog"). Nothing ships unless a judge
  // with zero context names the subject BLIND_RUNS times out of BLIND_RUNS.
  //
  // The gate judges what SHIPS: the strokes JOINED into one continuous
  // line (street connectors are drawn ink — a runner cannot lift the pen),
  // rendered on a real map like the calibrated blind-squint instrument.
  // Judging the per-stroke plain render passed routes whose shipped,
  // connector-joined form read as "swastika"/"dog" (Aug 10 audit).
  //
  // Composite runs keep the comparative-likeness gate: no short subject
  // phrase describes a multi-element logo, so blind naming can't apply.
  type Keeper = (typeof keepers)[number] & {
    blindGuess?: string;
    joined: LatLng[];
    shippedPng: Buffer;
  };
  const verified: Keeper[] = [];
  if (!args.originalImage) {
    progress("Final check: judges see your top routes with NO hints…");
    const tried: { guess: string | null }[] = [];
    // Walk BEYOND the shown-pick budget: every primed-passing candidate is
    // a chance to succeed, and refusing while untried candidates remain is
    // giving up early.
    const verifyQueue = scored
      .filter((s) => s.score >= PRIMED_KEEP_THRESHOLD)
      .sort((a, b) => b.score - a.score || a.c.jitter - b.c.jitter || a.c.dev - b.c.dev)
      .slice(0, BLIND_VERIFY_MAX_CANDIDATES);
    for (const k of verifyQueue) {
      const joined = joinChains(g, k.c.segments);
      const mapPng = await renderJoinedRouteMapPng(joined);
      const plainPng = await renderChainsPng([joined]);
      const shippedPng = mapPng ?? plainPng;
      // DUAL-RENDER gate (Aug 10 evening): a route must blind-name
      // correctly on BOTH the map render and the plain render. The Aug 10
      // run-5 audit split cleanly — every single-render pass that failed
      // outside came from one render style reading generously (tree route
      // passed the map render 3/3, external judges said "cat" 3/3). Two
      // independent pictures agreeing is the cheapest robust instrument.
      const res = await blindVerify(args.apiKey, shippedPng, subject);
      const res2 =
        res.passed && mapPng ? await blindVerify(args.apiKey, plainPng, subject) : null;
      if (res.passed && (res2?.passed ?? true)) {
        verified.push({ ...k, blindGuess: res.guess ?? subject, joined, shippedPng });
        if (verified.length >= BLIND_PICKS_TARGET) break;
      } else {
        tried.push({ guess: res2 && !res2.passed ? res2.guess : res.guess });
      }
    }
    if (!verified.length) {
      const misreads = [...new Set(tried.map((t) => t.guess).filter(Boolean))].join('", "');
      const bestScored = scored.slice().sort((a, b) => b.score - a.score)[0];
      return {
        picks: [],
        subject,
        subjectConfidence: namedConfidence,
        message:
          `We read your art as ${subject} and found ${verifyQueue.length} promising street placements — but when judges saw the final street routes with no hints, ` +
          (misreads
            ? `they called the best ones "${misreads}" instead. `
            : `none could name the subject. `) +
          `Nothing ships unless a stranger can name it. Simpler/bolder shapes pass more often — or try the verified gallery.`,
        refusedPreviewPngBase64: bestScored?.png.toString("base64"),
        refusedPreviewScore: bestScored?.score,
      };
    }
  } else {
    for (const k of keepers) {
      const joined = joinChains(g, k.c.segments);
      verified.push({ ...k, joined, shippedPng: k.png });
    }
  }

  progress("Building your verified picks…");
  const picks: WowPlacePick[] = [];
  for (const k of verified) {
    const placedStrokes = placeSegments(strokes, k.c.center, k.c.extentM, k.c.rotDeg, false);
    picks.push({
      center: k.c.center,
      rotDeg: k.c.rotDeg,
      extentM: k.c.extentM,
      km: Number(chainsKm([k.joined]).toFixed(2)),
      dev: k.c.dev,
      primed: k.score,
      blindGuess: k.blindGuess,
      coordinates: k.joined.map(([lat, lng]) => [lat, lng]),
      anchorLatLngs: placedStrokes.flat().map(([lat, lng]) => [lat, lng]),
      previewPngBase64: k.shippedPng.toString("base64"),
    });
  }
  return { picks, subject, subjectConfidence: namedConfidence };
}
