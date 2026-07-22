/**
 * Server-side artist loop — the automated interpret → place → compile →
 * blind-judge → redraw pipeline from scripts/artist-loop-poc.ts (bc96b3e),
 * packaged for app/api/artist-loop.
 *
 * Differences from the offline POC, all latency-driven (the POC runs 5
 * rounds in ~10-25 min; a request must finish inside Vercel's 300 s cap):
 *  - judges' 3 blind samples run in parallel instead of sequentially
 *  - 2 rounds by default, with a wall-clock budget that returns the best
 *    compiled round so far rather than overrunning
 *  - the live-Mapbox re-route verify gate is skipped — the compiled chain is
 *    on real street junctions already, and Step 4's editor re-routes any leg
 *    the runner drags anyway
 *  - few-shot exemplars ship as a bundled JSON module (the POC read them
 *    from gitignored tmp-* directories)
 *
 * Server-only: imports sharp (native) — never import from client components.
 */
import sharp from "sharp";
import {
  compileContourToLattice,
  type LatticeCompileResult,
  type LatticeGraph,
  type LatLng,
} from "./latticeCompiler";
import { getManhattanLatticeGraph } from "./manhattanLattice";
import { LATTICE_GLYPHS, packWordRows } from "./latticeText";
import { buildLockupStrokePoints } from "./mapNativeDesigner";
import { buildInterpretationPrompt } from "./interpretationPrompt";
import {
  reviewStreetDesignSketch,
  type StreetDesignPoint,
} from "./streetDesignSketch";
import {
  CANDIDATE_CENTERS,
  guessMatches,
  localSvg,
  parseJsonLoose,
  simulateStreets,
  toLatLngFrom,
  toLocalFrom,
  toMeters,
  type ArtistLoopProgress,
  type ArtistLoopRouteResult,
  type Pt,
} from "./artistLoopCore";

// ---------------------------------------------------------------------------
// Anthropic API (direct HTTPS, same client as the POC / blind-squint-test)
// ---------------------------------------------------------------------------
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

async function callClaude(
  model: string,
  content: ContentBlock[],
  maxTokens: number,
  thinking = false,
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured on server");
  let useThinking = thinking;
  for (let attempt = 0; attempt < 4; attempt++) {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    };
    // Bounded thinking: adaptive let the designer burn the entire token
    // budget on deliberation (stop=max_tokens with zero text) and single
    // calls ran 130-240 s. A fixed budget keeps quality without the sprawl.
    if (useThinking) body.thinking = { type: "enabled", budget_tokens: 6000 };
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    if (res.status === 400 && useThinking) {
      // model doesn't support adaptive thinking — retry plain
      useThinking = false;
      continue;
    }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(" ")
      .trim();
    if (text) return text;
    throw new Error(`empty response (stop=${json.stop_reason})`);
  }
  throw new Error("Anthropic API kept failing after retries");
}

// ---------------------------------------------------------------------------
// Designer
// ---------------------------------------------------------------------------
const DESIGNER_MODEL = "claude-opus-4-8";
const JUDGE_MODEL = "claude-opus-4-8";
const DRAFTS_PER_ROUND = 4;

const POC_ADDENDUM = `

THE DOG ATTRACTOR — the #1 failure mode: any lumpy closed mass with 2-4 short
strokes protruding from its bottom edge (exhaust flames, laces, table legs,
pump feet) reads as "a dog" to every stranger. Before submitting, look at your
silhouette and ask: could this read as a four-legged animal? If yes, redesign
the bottom edge: make protrusions either ONE bold shape or part of a flat base.

INTERIOR TEXTURE ON A STREET GRID: interior strokes (laces, stripes, windows,
spokes) must run PURELY horizontal or vertical in your frame — a diagonal
interior stroke becomes a 2-block staircase and several of them merge into a
solid unrecognizable lump. Maximum 4 interior strokes, spaced at least 0.12
apart. Big diagonals are allowed ONLY as silhouette edges at least 1/4 of the
drawing long (they read as clean staircases at that size).

DENSITY IS NOT OPTIONAL: any subject with parts (an animal, a person, a logo
with objects) needs 80-200 points. Sketches of complex subjects with fewer
than 60 points WILL BE REJECTED without being looked at. Spend the points on
dense sampling of every curve (10-30 points per curve) and on the identity
features. Only a single plain closed shape (heart, egg, circle) may use fewer.

WORDS AND LETTERS — HARD RULE: you may only use words that are VISIBLY
PRINTED in the uploaded image. Never caption, label, or name the subject
with invented text ("GAS" on a wordless pump logo, "PUMP" under a pump) —
a labeled illustration is not the user's logo, and invented words are an
automatic failure no matter how much they help recognition. When the
upload DOES contain short printed text (6-12 letters), never draw letter
shapes point-by-point yourself — hand-drawn letter coordinates always
come out as scribble. Give the draft a "word" field with the EXACT text
from the image and make your "points" ONLY the symbol as one clean
closed outline; the system composes the lockup with proven machinery.

ONE SUBJECT ONLY (multi-object logos): a logo showing two things side by
side (a pump AND a person, a mascot AND a product) must be interpreted as
ONE subject — pick the single most distinctive figure and draw only it,
big. Measured across this project's whole history: no two-object street
route has ever been recognized by blind judges (the objects merge into
animal silhouettes); single bold subjects are the only street winners.
Prefer asymmetric, characterful views (a profile with a nose beats a
symmetric frontal blob — symmetry reads as hearts and dogs).

Additionally return one extra JSON key at the top level:
  "acceptableGuesses": 4-10 short words/phrases a stranger might reasonably say when
  naming the subject of the finished route (synonyms and near-misses that should
  count as recognition, e.g. for a gas-pump logo: ["gas pump","fuel pump","person at pump"]).
  For brand marks, include what a stranger who does NOT know the brand would call the
  shape itself (a swoosh: "checkmark", "check mark"; an apple mark: "apple") and any
  words the design spells out (spelled-out text IS recognition).`;

/** Test-only hook for offline probes of the typesetter geometry. */
export const __testTypesetWordSketch = typesetWordSketch;

type ExemplarRecord = { tag: string; note: string; jpegBase64: string };

/**
 * Few-shot exemplars: sketches that actually became recognizable street
 * routes, shown as STYLE references. `sourceName` (the uploaded filename)
 * filters out any exemplar of the same subject so the designer never sees
 * the answer.
 */
async function loadExemplarBlocks(sourceName: string | null): Promise<ContentBlock[]> {
  let records: ExemplarRecord[];
  try {
    records = (await import("./data/artist-loop-exemplars.json"))
      .default as ExemplarRecord[];
  } catch {
    return [];
  }
  const nameLower = (sourceName ?? "").toLowerCase();
  const usable = records.filter(
    (e) => !e.tag.split(" ").some((t) => t && nameLower.includes(t)),
  );
  if (!usable.length) return [];
  const blocks: ContentBlock[] = [
    {
      type: "text",
      text:
        "Before the task: here are sketches that became SUCCESSFUL, recognizable GPS-art street routes. " +
        "Study the drawing approach — bold silhouette, exaggerated identity features, axis-aligned boxy parts, dense curves — then apply it to a NEW subject. Do not copy these subjects.\n" +
        usable.map((e, i) => `Exemplar ${i + 1}: ${e.note}.`).join("\n"),
    },
  ];
  for (const e of usable) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: e.jpegBase64 },
    });
  }
  return blocks;
}

type DesignRound = {
  points: StreetDesignPoint[];
  label: string;
  visualFeatures: string[];
  /** True when the composer built a symbol-over-words lockup — those get
   * nikegood-scale size caps or the letters die at block quantization. */
  isLockup?: boolean;
};

/**
 * The artist's typesetter tool: set a word (or short stacked phrase) in
 * single-stroke skeleton capitals inside a normalized band, using the
 * proven glyph library. The AI declaring "word" + "wordBand" instead of
 * hand-drawing letter coordinates is the difference between "JUST DO IT"
 * and judges guessing "fishing rod" — measured July 22, 15 drafts in a
 * row with hand-drawn letters, zero recognized.
 */
function typesetWordSketch(
  word: string,
  band: { x: number; y: number; w: number; h: number },
  /** Pen position of the preceding symbol stroke, if any — the connector
   * routes around the band's left edge instead of slashing across the
   * text (the diagonal slash + letter row read as "grand piano"). */
  from?: { x: number; y: number },
): StreetDesignPoint[] {
  const clean = word
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return [];
  const rows = packWordRows(clean, 6, 3) ?? [clean.slice(0, 12)];
  const rowGap = 0.25;
  const rowH = band.h / (rows.length + (rows.length - 1) * rowGap);
  const out: StreetDesignPoint[] = [];
  // Route the incoming pen around the band's left margin, never across
  // the text area.
  if (from) {
    const edgeX = Math.max(0.01, band.x - 0.05);
    out.push({ x: edgeX, y: from.y });
    out.push({ x: edgeX, y: band.y + rowH });
  }
  rows.forEach((rowWord, r) => {
    const letters = rowWord.split("");
    const glyphCount = letters.filter((ch) => ch !== " ").length;
    const spaceCount = letters.filter((ch) => ch === " ").length;
    // Advance widths: normal letters 0.62 of row height, narrow (I) 0.28.
    // WIDE tracking (0.5 rowH gaps, 0.9 word gaps): the lattice route that
    // passed 3/3 blind judges had gaps as wide as its letters; tight
    // tracking joins single-stroke capitals into a piano-key comb.
    const GAP = 0.5;
    const widthOf = (ch: string) =>
      ch === " " ? 0.9 * rowH : (LATTICE_GLYPHS[ch]?.w === 0 ? 0.28 : 0.62) * rowH;
    let totalW = 0;
    for (const ch of letters) totalW += widthOf(ch);
    totalW += (glyphCount + spaceCount - 1) * GAP * rowH;
    const scale = totalW > band.w ? band.w / totalW : 1;
    const rowTop = band.y + r * rowH * (1 + rowGap);
    const baseY = rowTop + rowH * scale;
    let cursor = band.x + (band.w - totalW * scale) / 2;
    let rowStartIndex = out.length;
    for (const ch of letters) {
      const w = widthOf(ch) * scale;
      if (ch !== " ") {
        const glyph = LATTICE_GLYPHS[ch];
        if (glyph) {
          // Choose the glyph's traversal orientation so the connector from
          // the previous pen position is as HORIZONTAL as possible — a
          // level connector reads as a serif bar; a diagonal one reads as
          // a phantom letter (T-to-D drew an "N").
          const raw = glyph.path.map((p) => ({
            x: cursor + p[0] * w,
            y: baseY - p[1] * rowH * scale,
          }));
          const closed =
            Math.hypot(
              raw[0]!.x - raw[raw.length - 1]!.x,
              raw[0]!.y - raw[raw.length - 1]!.y,
            ) < 1e-6;
          const orientations: { x: number; y: number }[][] = [];
          if (closed && raw.length > 2) {
            const loop = raw.slice(0, -1);
            for (let s = 0; s < loop.length; s++) {
              orientations.push([...loop.slice(s), ...loop.slice(0, s + 1)]);
            }
          } else {
            orientations.push(raw, [...raw].reverse());
          }
          const prev = out[out.length - 1] ?? null;
          let best = orientations[0]!;
          if (prev) {
            let bestScore = Infinity;
            for (const o of orientations) {
              // Short connectors, and connectors that ride LOW: entries and
              // exits near the baseline keep inter-letter travel at shoe
              // level. Cap-level rails join the letters into a piano
              // keyboard; base-level ones read as ground.
              const entry = o[0]!;
              const exit = o[o.length - 1]!;
              const score =
                Math.hypot(entry.x - prev.x, entry.y - prev.y) +
                0.8 * Math.abs(entry.y - baseY) +
                0.8 * Math.abs(exit.y - baseY);
              if (score < bestScore) {
                bestScore = score;
                best = o;
              }
            }
          }
          out.push(...best);
        }
      }
      cursor += w + GAP * rowH * scale;
    }
    // Row change: travel around the right edge of the text block, never
    // across the rows (the diagonal slashed straight through "IT").
    if (r < rows.length - 1 && out.length > rowStartIndex) {
      const exit = out[out.length - 1]!;
      const edgeX = band.x + band.w + 0.03;
      out.push({ x: edgeX, y: exit.y });
      out.push({ x: edgeX, y: baseY + rowH * rowGap * 0.5 });
    }
    rowStartIndex = out.length;
  });
  return out;
}

function cleanPoints(raw: unknown): StreetDesignPoint[] {
  if (!Array.isArray(raw)) return [];
  const pts: StreetDesignPoint[] = [];
  for (const p of raw) {
    if (
      p &&
      typeof p === "object" &&
      Number.isFinite((p as { x?: number }).x) &&
      Number.isFinite((p as { y?: number }).y)
    ) {
      const x = Math.min(1, Math.max(0, (p as { x: number }).x));
      const y = Math.min(1, Math.max(0, (p as { y: number }).y));
      pts.push({ x, y });
    }
  }
  return pts;
}

async function designerCall(
  imageBlock: ContentBlock,
  critique: ContentBlock[] | null,
  exemplarBlocks: ContentBlock[],
  cityLabel: string,
): Promise<{ designs: DesignRound[]; acceptableGuesses: string[] }> {
  const basePrompt = buildInterpretationPrompt(cityLabel, DRAFTS_PER_ROUND) + POC_ADDENDUM;
  const content: ContentBlock[] = [
    ...exemplarBlocks,
    { type: "text", text: "Now the user's uploaded image — this is the subject to draw:" },
    imageBlock,
    ...(critique ?? []),
    { type: "text", text: basePrompt },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    // 6k thinking + room for 4 point-list drafts. 32k adaptive invited
    // multi-minute thinking sprawl that blew the request budget on one call.
    const text = await callClaude(DESIGNER_MODEL, content, 20000, true);
    let json: {
      label?: string;
      visualFeatures?: string[];
      points?: unknown;
      acceptableGuesses?: string[];
      drafts?: { label?: string; visualFeatures?: string[]; points?: unknown }[];
    };
    try {
      json = parseJsonLoose(text) as typeof json;
    } catch {
      continue;
    }
    const designs: DesignRound[] = [];
    type RawDraft = {
      label?: string;
      visualFeatures?: string[];
      points?: unknown;
      word?: unknown;
      wordBand?: unknown;
    };
    const rawDrafts: RawDraft[] =
      Array.isArray(json.drafts) && json.drafts.length
        ? (json.drafts as RawDraft[])
        : [{ label: json.label, visualFeatures: json.visualFeatures, points: json.points }];
    for (const d of rawDrafts.slice(0, DRAFTS_PER_ROUND)) {
      let pts = cleanPoints(d.points);
      let isLockup = false;
      const wantsWord = typeof d.word === "string" && d.word.trim().length > 0;
      if (wantsWord && pts.length >= 8) {
        // The battle-tested lockup composer (mapNativeDesigner) lays the
        // symbol out over block words with the connector/baseline lessons
        // already learned — months of composition fixes the loop must not
        // re-derive with ad-hoc heuristics.
        const symbolCount = pts.length;
        const composed = buildLockupStrokePoints(pts, (d.word as string).trim());
        if (composed.length >= 8) {
          // The composer emits map-frame coordinates (y up); the loop's
          // sketch frame is image space (y down) — flip or the lockup
          // renders upside-down with its rows swapped.
          const ys = composed.map((p) => p.y);
          const lo = Math.min(...ys);
          const hi = Math.max(...ys);
          pts = composed.map((p) => ({ x: p.x, y: lo + hi - p.y }));
          isLockup = true;
          console.log(
            `[artist-loop] draft "${d.label}": composed lockup with "${(d.word as string).trim()}" — ${symbolCount} symbol pts -> ${pts.length} lockup pts`,
          );
        }
      }
      if (pts.length < 8) continue;
      const featureCount = Array.isArray(d.visualFeatures) ? d.visualFeatures.length : 0;
      // Density pre-gate: many named features on a sparse line always fails.
      if (!isLockup && featureCount >= 5 && pts.length < 55) continue;
      designs.push({
        points: pts,
        label: typeof d.label === "string" ? d.label : (json.label ?? "your design"),
        visualFeatures: Array.isArray(d.visualFeatures)
          ? d.visualFeatures.filter((f): f is string => typeof f === "string")
          : [],
        isLockup,
      });
    }
    if (designs.length) {
      const acceptable = Array.isArray(json.acceptableGuesses)
        ? json.acceptableGuesses.filter((g): g is string => typeof g === "string")
        : [];
      return { designs, acceptableGuesses: acceptable };
    }
  }
  throw new Error("designer produced no usable sketch");
}

// ---------------------------------------------------------------------------
// Placement + compile
// ---------------------------------------------------------------------------
type Placement = {
  name: string;
  origin: LatLng;
  compiled: LatticeCompileResult;
};

function placeAndCompile(local: Pt[], graph: LatticeGraph): Placement | null {
  const xs = local.map((p) => p[0]);
  const ys = local.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

  let best: Placement | null = null;
  let bestScore = Infinity;
  for (const { name, center } of CANDIDATE_CENTERS) {
    // origin such that the sketch bbox center lands on `center`
    const originGuess: LatLng = [center[0], center[1]];
    const offset = toLatLngFrom(originGuess, [cx, cy]);
    const origin: LatLng = [
      center[0] - (offset[0] - originGuess[0]),
      center[1] - (offset[1] - originGuess[1]),
    ];
    const placed = local.map((p) => toLatLngFrom(origin, p));
    const compiled = compileContourToLattice(placed, graph, {
      sampleMeters: 38,
      pinRadiusMeters: 150,
    });
    if (!compiled) continue;
    // Skipped pins leave visible GAPS in the drawing — a placement with ANY
    // gap loses to any gap-free one, no matter how its deviation compares.
    const score =
      compiled.meanDeviationMeters +
      compiled.maxDeviationMeters / 10 +
      (compiled.skippedPins > 0 ? 10000 + compiled.skippedPins * 150 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { name, origin, compiled };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------
async function svgToPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

async function renderMap(chain: LatLng[], w = 1100, h = 880): Promise<Buffer> {
  let zoom = 13;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z));
    const ys = chain.map((p) => latToY(p[0], z));
    if (
      Math.max(...xs) - Math.min(...xs) <= w * 0.8 &&
      Math.max(...ys) - Math.min(...ys) <= h * 0.8
    ) {
      zoom = z;
      break;
    }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom));
  const ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2;
  const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tilePromises: Promise<sharp.OverlayOptions | null>[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      tilePromises.push(
        fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
          headers: { "User-Agent": "pace-casso artist-loop route preview" },
        })
          .then(async (res) =>
            res.ok
              ? {
                  input: Buffer.from(await res.arrayBuffer()),
                  left: Math.round(tx * TILE - vx),
                  top: Math.round(ty * TILE - vy),
                }
              : null,
          )
          .catch(() => null),
      );
    }
  }
  const tiles = (await Promise.all(tilePromises)).filter(
    (t): t is sharp.OverlayOptions => t !== null,
  );
  const d = chain
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`,
    )
    .join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${d}" fill="none" stroke="#7f1024" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>` +
      `<path d="${d}" fill="none" stroke="#e8253f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`,
  );
  return sharp({ create: { width: w, height: h, channels: 4, background: "#eee" } })
    .composite([...tiles, { input: overlay, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Blind judge (mechanics of blind-squint-test.mjs — the only valid squint test)
// ---------------------------------------------------------------------------
const JUDGE_PROMPT =
  'The red line is a GPS route someone recorded while running — they were trying to "draw" a recognizable picture, shape, letter, or object with their path (like Strava art). ' +
  "What were they trying to draw? Reply in this exact format:\n" +
  'GUESS: <1-3 words, or "nothing recognizable">\n' +
  "CONFIDENCE: <0-10, how obvious it is at a glance>";

const SKETCH_JUDGE_PROMPT =
  "This is a one-line drawing. What does it depict? Reply in this exact format:\n" +
  'GUESS: <1-3 words, or "nothing recognizable">\n' +
  "CONFIDENCE: <0-10, how obvious it is at a glance>";

/** Crop a rendered map to the red route's bounding box so judges see the
 *  drawing at the same relative size a Strava viewer would. */
async function cropToRoute(png: Buffer): Promise<Buffer> {
  const img = sharp(png);
  const meta = await img.metadata();
  const width = meta.width!;
  const height = meta.height!;
  const { data, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * ch;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r > 150 && r - g > 55 && r - b > 45) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found++;
      }
    }
  }
  if (found < 30) {
    return sharp(png).resize({ width: 1000, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  }
  const padX = Math.round((maxX - minX) * 0.08) + 20;
  const padY = Math.round((maxY - minY) * 0.08) + 20;
  const left = Math.max(0, minX - padX);
  const top = Math.max(0, minY - padY);
  return sharp(png)
    .extract({
      left,
      top,
      width: Math.min(width - left, maxX - minX + 2 * padX),
      height: Math.min(height - top, maxY - minY + 2 * padY),
    })
    .resize({ width: 1000, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

type JudgeSample = { guess: string; confidence: number };
type JudgeResult = {
  samples: JudgeSample[];
  recognizedCount: number;
  medianConfidence: number;
};

async function blindJudge(
  jpegOrPng: Buffer,
  acceptable: string[],
  prompt: string,
  mediaType: "image/jpeg" | "image/png" = "image/jpeg",
): Promise<JudgeResult> {
  const samples = await Promise.all(
    Array.from({ length: 3 }, async (): Promise<JudgeSample> => {
      const text = await callClaude(
        JUDGE_MODEL,
        [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: jpegOrPng.toString("base64") },
          },
          { type: "text", text: prompt },
        ],
        1024,
      );
      const guess =
        text.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE|$)/i)?.[1]?.trim() ?? text.slice(0, 60);
      const confidence = Number(text.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)/i)?.[1] ?? 0);
      return { guess, confidence };
    }),
  );
  const recognizedCount = samples.filter((s) => guessMatches(s.guess, acceptable)).length;
  const confs = samples.map((s) => s.confidence).sort((a, b) => a - b);
  return { samples, recognizedCount, medianConfidence: confs[1] ?? 0 };
}

async function sketchJpeg(local: Pt[], width = 7): Promise<Buffer> {
  const png = await svgToPng(localSvg([{ pts: local, color: "#111", width }], 800));
  return sharp(png).jpeg({ quality: 85 }).toBuffer();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
export type ArtistLoopOptions = {
  /** Raw base64 (no data: prefix). */
  imageBase64: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  cityLabel: string;
  /** Uploaded filename — only used to filter same-subject exemplars. */
  sourceName?: string | null;
  maxRounds?: number;
  /** Stop starting new work after this much wall-clock time. */
  timeBudgetMs?: number;
  onProgress?: (p: ArtistLoopProgress) => void;
};

type RoundRecord = {
  round: number;
  design: DesignRound;
  placement: Placement;
  judge: JudgeResult;
  sketchJudge: JudgeResult;
  local: Pt[];
  mapPng: Buffer;
  sketchBuf: Buffer;
  compiledBuf: Buffer;
};

export async function runArtistLoop(
  opts: ArtistLoopOptions,
): Promise<ArtistLoopRouteResult> {
  const t0 = Date.now();
  // Drafts within a round evaluate in PARALLEL (the judges are the long
  // poles), so a round costs ~40-60 s wall-clock and four rounds fit the
  // platform's 300 s cap. This is the difference between the economy loop
  // and the method that produced the unicorn: more shots, harder bar.
  const maxRounds = Math.max(1, Math.min(12, opts.maxRounds ?? 4));
  const timeBudgetMs = opts.timeBudgetMs ?? 270_000;
  const progress = opts.onProgress ?? (() => {});

  const imageBlock: ContentBlock = {
    type: "image",
    source: { type: "base64", media_type: opts.mediaType, data: opts.imageBase64 },
  };
  const graph = await getManhattanLatticeGraph();
  const exemplarBlocks = await loadExemplarBlocks(opts.sourceName ?? null);

  let acceptable: string[] = [];
  let critique: ContentBlock[] | null = null;
  const rounds: RoundRecord[] = [];
  const historyLines: string[] = [];
  let solved = false;

  for (let round = 1; round <= maxRounds && !solved; round++) {
    // Never start a round we can't plausibly finish (~60 s worst case with
    // parallel draft evaluation).
    if (round > 1 && Date.now() - t0 > timeBudgetMs * 0.72) break;

    progress({
      stage: "designing",
      round,
      detail:
        round === 1
          ? "The artist is studying your image and sketching drafts…"
          : "Strangers weren't convinced — the artist is redrawing…",
    });
    const { designs, acceptableGuesses } = await designerCall(
      imageBlock,
      critique,
      exemplarBlocks,
      opts.cityLabel,
    );
    // Freeze the answer key after round 1 — later rounds may not move the
    // goalposts by relabeling the subject.
    if (!acceptable.length) {
      acceptable = acceptableGuesses.length ? acceptableGuesses : [designs[0]!.label];
    }

    let bestOfRound: RoundRecord | null = null;
    let sketchFailNote: { design: DesignRound; failBuf: Buffer; judge: JudgeResult } | null =
      null;

    progress({
      stage: "sketch-judge",
      round,
      detail: `Showing ${designs.length} drafts to blind judges in parallel…`,
    });

    // All drafts evaluate CONCURRENTLY — the blind-judge API calls are the
    // wall-clock cost, and they parallelize cleanly. Each draft runs the
    // full gauntlet: clean-sketch judge → block-quantization judge →
    // lattice compile → street-map judge, with early-outs.
    type DraftOutcome =
      | { kind: "rec"; rec: RoundRecord }
      | { kind: "sketch-fail"; design: DesignRound; failBuf: Buffer; judge: JudgeResult; line: string }
      | { kind: "dead" };
    const outcomes = await Promise.all(
      designs.map(async (design, di): Promise<DraftOutcome> => {
        try {
          const { local } = toMeters(
            design.points,
            design.isLockup
              ? { maxWidthM: 3900, maxHeightM: 3300, maxRouteM: 52000 }
              : undefined,
          );
          // Stage 1: the CLEAN sketch. If strangers can't name the line
          // drawing itself, streets only make it worse.
          const sketchBuf = await sketchJpeg(local);
          if (typeof process !== "undefined" && process.env?.ARTIST_LOOP_DUMP) {
            const fsMod = await import("node:fs");
            fsMod.writeFileSync(
              `${process.env.ARTIST_LOOP_DUMP}/r${round}-d${di + 1}-${design.label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.jpg`,
              sketchBuf,
            );
          }
          const sketchJudge = await blindJudge(sketchBuf, acceptable, SKETCH_JUDGE_PROMPT);
          if (sketchJudge.recognizedCount === 0) {
            return {
              kind: "sketch-fail",
              design,
              failBuf: sketchBuf,
              judge: sketchJudge,
              line: `Round ${round} draft "${design.label}" (${design.points.length} pts): CLEAN SKETCH already failed — strangers saw ${[...new Set(sketchJudge.samples.map((s) => s.guess))].join(" / ")}.`,
            };
          }
          // Stage 2: street SIMULATOR — quantize to block spacing.
          const simBuf = await sketchJpeg(
            simulateStreets(local, design.isLockup ? 140 : undefined),
            10,
          );
          const simJudge = await blindJudge(simBuf, acceptable, SKETCH_JUDGE_PROMPT);
          if (simJudge.recognizedCount === 0) {
            return {
              kind: "sketch-fail",
              design,
              failBuf: simBuf,
              judge: simJudge,
              line: `Round ${round} draft "${design.label}": clean sketch was recognized, but after BLOCK QUANTIZATION strangers saw ${[...new Set(simJudge.samples.map((s) => s.guess))].join(" / ")} — features merged or degenerated at street scale.`,
            };
          }
          progress({
            stage: "compiling",
            round,
            detail: `Draft ${di + 1} ("${design.label}") survived the sketch gates — compiling onto real junctions…`,
          });
          const placement = placeAndCompile(local, graph);
          if (!placement) return { kind: "dead" };
          const c = placement.compiled;
          const compiledLocal = c.chain.map((p) => toLocalFrom(placement.origin, p));
          const compiledBuf = await sharp(
            await svgToPng(
              localSvg([
                { pts: local, color: "#f2b8c0", width: 4 },
                { pts: compiledLocal, color: "#111", width: 6 },
              ]),
            ),
          )
            .jpeg({ quality: 85 })
            .toBuffer();
          const mapPng = await renderMap(c.chain);
          const judge = await blindJudge(await cropToRoute(mapPng), acceptable, JUDGE_PROMPT);
          return {
            kind: "rec",
            rec: {
              round,
              design,
              placement,
              judge,
              sketchJudge,
              local,
              mapPng,
              sketchBuf,
              compiledBuf,
            },
          };
        } catch {
          // One draft's failure (API hiccup, render error) must not sink
          // the round — the other drafts carry it.
          return { kind: "dead" };
        }
      }),
    );

    for (const outcome of outcomes) {
      if (outcome.kind === "sketch-fail") {
        historyLines.push(outcome.line);
        // Surface WHY in the progress stream — "no draft survived" with no
        // detail is undebuggable in production logs.
        progress({ stage: "sketch-judge", round, detail: outcome.line });
        if (!sketchFailNote) {
          sketchFailNote = {
            design: outcome.design,
            failBuf: outcome.failBuf,
            judge: outcome.judge,
          };
        }
        continue;
      }
      if (outcome.kind !== "rec") continue;
      const rec = outcome.rec;
      rounds.push(rec);
      if (
        !bestOfRound ||
        rec.judge.recognizedCount > bestOfRound.judge.recognizedCount ||
        (rec.judge.recognizedCount === bestOfRound.judge.recognizedCount &&
          rec.judge.medianConfidence > bestOfRound.judge.medianConfidence)
      ) {
        bestOfRound = rec;
      }
      // The bar the unicorn set: unanimous at 6+ or strong majority at 7+.
      // 2/3 at exactly 6 keeps iterating for something better (the old bar
      // stopped there, which is why production output plateaued at "meh").
      if (
        rec.judge.recognizedCount >= 3 && rec.judge.medianConfidence >= 6 ||
        (rec.judge.recognizedCount >= 2 && rec.judge.medianConfidence >= 7)
      ) {
        solved = true;
      }
    }

    progress({
      stage: "round-done",
      round,
      detail: solved
        ? "Strangers recognized the street route — locking it in."
        : bestOfRound
          ? `Round ${round}: ${bestOfRound.judge.recognizedCount}/3 strangers recognized it.`
          : `Round ${round}: no draft survived the sketch gates.`,
    });
    if (solved) break;

    // Build the critique for the next round.
    if (!bestOfRound) {
      if (sketchFailNote) {
        const sj = sketchFailNote.judge;
        critique = [
          {
            type: "text",
            text:
              (historyLines.length
                ? `HISTORY OF ALL PREVIOUS ATTEMPTS — do not repeat a failure mode already tried:\n${historyLines.join("\n")}\n\n`
                : "") +
              `Your drawings failed BEFORE any street snapping: shown as clean line drawings, strangers guessed ` +
              `${sj.samples.map((s) => `"${s.guess}"`).join(", ")} for the attached sketch ("${sketchFailNote.design.label}"). ` +
              "The problem is the drawing itself, not the street grid. Study the original image again and draw a composition whose SILHOUETTE alone tells the story — pose, proportions, and the 2-3 most distinctive features, exaggerated. Same JSON contract.",
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: sketchFailNote.failBuf.toString("base64"),
            },
          },
        ];
      } else {
        critique = [
          {
            type: "text",
            text: "None of your designs could be fitted onto the street grid at a legible scale. Draw simpler, bolder versions: fewer, longer strokes; long edges axis-aligned.",
          },
        ];
      }
      continue;
    }

    const design = bestOfRound.design;
    const judge = bestOfRound.judge;
    const c = bestOfRound.placement.compiled;
    const review = reviewStreetDesignSketch(design.points);
    const mapCrop = await cropToRoute(bestOfRound.mapPng);
    historyLines.push(
      `Round ${round} ("${design.label}", ${design.points.length} pts): strangers saw ${[...new Set(judge.samples.map((s) => s.guess))].join(" / ")}.`,
    );
    critique = [
      {
        type: "text",
        text:
          (historyLines.length > 1
            ? `HISTORY OF ALL PREVIOUS ATTEMPTS — do not repeat a failure mode already tried:\n${historyLines.join("\n")}\n\n`
            : "") +
          `Round ${round} feedback. Images below: (1) your intended sketch, (2) the compiled street silhouette — study which strokes merged into mush, (3) the final map view strangers judged. ` +
          `That street version was shown to ${judge.samples.length} strangers with zero context. They guessed: ` +
          `${judge.samples.map((s) => `"${s.guess}" (confidence ${s.confidence}/10)`).join(", ")}. The subject is "${design.label}". ` +
          (judge.recognizedCount === 0
            ? "Nobody recognized it. "
            : `Only ${judge.recognizedCount} of ${judge.samples.length} recognized it. `) +
          `Diagnostics: ${c.km.toFixed(1)} km route, mean deviation ${c.meanDeviationMeters.toFixed(0)} m, ${c.skippedPins} legs dropped (dropped legs leave visible gaps)` +
          (review.reasons.length ? `; sketch review flagged: ${review.reasons.join("; ")}` : "") +
          `; ${review.metrics.selfIntersections} self-intersections, ${review.metrics.connectorCount} connector jumps. ` +
          `IMPORTANT ATTRIBUTION: the clean sketch alone was ALSO judged blind — strangers said ${bestOfRound.sketchJudge.samples.map((s) => `"${s.guess}"`).join(", ")} (${bestOfRound.sketchJudge.recognizedCount}/3 correct). ` +
          (bestOfRound.sketchJudge.recognizedCount >= 2
            ? "So the COMPOSITION WORKS — the street grid destroyed it. KEEP this composition and fix only its street survival: enlarge the smallest identity features to 3+ blocks, move fine detail to straight axis-aligned strokes, simplify curves that quantize badly. Do NOT change concept. "
            : "The sketch itself was already weak, so change the composition: silhouette first, exaggerate the 2-3 most distinctive features, drop the rest. ") +
          "No line may cross over shapes you already drew. Same JSON contract.",
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: bestOfRound.sketchBuf.toString("base64"),
        },
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: bestOfRound.compiledBuf.toString("base64"),
        },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: mapCrop.toString("base64") },
      },
    ];
  }

  if (!rounds.length) {
    throw new Error(
      "The artist couldn't produce a street route strangers would recognize this time — try again, or use a simpler image.",
    );
  }

  // Winner: recognition first, then confidence, then compile fidelity.
  rounds.sort(
    (a, b) =>
      b.judge.recognizedCount - a.judge.recognizedCount ||
      b.judge.medianConfidence - a.judge.medianConfidence ||
      a.placement.compiled.meanDeviationMeters - b.placement.compiled.meanDeviationMeters,
  );
  const win = rounds[0]!;
  // HONESTY GATE: the project's standing bar is "show only squint-test
  // winners". A route the blind judges couldn't recognize must never be
  // handed to the user with a straight face — that's how a mangled swoosh
  // shipped on July 20. Fail loudly instead; the client shows this message.
  // Two gates, both required: majority recognition AND real confidence.
  // A run where two judges half-heartedly said "running person" at
  // confidence 3 slipped through on count alone (July 22, gas logo) —
  // low-confidence matches are judges guessing, not recognizing.
  if (win.judge.recognizedCount < 2 || win.judge.medianConfidence < 5) {
    throw new Error(
      "The artist tried, but blind judges couldn't confidently recognize the street version " +
        `(best guesses: ${[...new Set(win.judge.samples.map((s) => s.guess))].join(", ")} ` +
        `at median confidence ${win.judge.medianConfidence}/10). ` +
        "No route was delivered. Bold single shapes work best; thin marks and text don't survive street blocks yet.",
    );
  }
  const c = win.placement.compiled;
  const sketchLatLngs = win.local.map((p) => toLatLngFrom(win.placement.origin, p));
  const lats = c.chain.map((p) => p[0]);
  const lngs = c.chain.map((p) => p[1]);
  const center: LatLng = [
    (Math.min(...lats) + Math.max(...lats)) / 2,
    (Math.min(...lngs) + Math.max(...lngs)) / 2,
  ];

  return {
    label: win.design.label,
    description:
      win.design.visualFeatures.length > 0
        ? `Identity features kept: ${win.design.visualFeatures.join(", ")}.`
        : "Interpretive one-line design compiled onto real street junctions.",
    acceptableGuesses: acceptable,
    sketchPoints: win.design.points,
    sketchLatLngs,
    chain: c.chain,
    distanceMeters: Math.round(c.km * 1000),
    center,
    meanDeviationMeters: Number(c.meanDeviationMeters.toFixed(1)),
    recognizedCount: win.judge.recognizedCount,
    medianConfidence: win.judge.medianConfidence,
    guesses: win.judge.samples.map((s) => s.guess),
    roundsRun: rounds[rounds.length - 1]!.round,
  };
}
