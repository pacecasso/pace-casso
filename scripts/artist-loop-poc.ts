/**
 * Artist-loop POC — the fully automated version of the pipeline that made
 * every hand-authored winner in this repo (gas-interp-v4/v5, interp-designs,
 * curated runs), with ZERO hand-drawn geometry and ZERO filename hints.
 *
 *   image ──► designer (Claude vision, production interpretation prompt)
 *         ──► normalized one-line sketch (0..1 points)
 *         ──► grid-aligned placement at legible scale (p25 stroke ≥ ~2 blocks)
 *         ──► compileContourToLattice (PRODUCTION compiler, real junctions)
 *         ──► OSM map render
 *         ──► BLIND judge ×3 (never told the subject — "what did they draw?")
 *         ──► recognized? done : critique + render fed back to designer, redraw
 *         ──► best round wins → SHEET.png, GPX, meta.json
 *         ──► verify gates (real junctions, detour ratio, live Mapbox re-route)
 *
 * Run: npx tsx scripts/artist-loop-poc.ts <image> [--rounds=5]
 *        [--designer=claude-opus-4-8] [--judge=claude-opus-4-8] [--skip-verify]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  buildLatticeGraph,
  compileContourToLattice,
  haversineMeters,
  type LatticeCompileResult,
  type LatLng,
  type LatticeData,
} from "../lib/latticeCompiler";
import { buildInterpretationPrompt } from "../lib/interpretationPrompt";
import {
  reviewStreetDesignSketch,
  type StreetDesignPoint,
} from "../lib/streetDesignSketch";

// ---------------------------------------------------------------------------
// CLI + env
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const imageFile = args.find((a) => !a.startsWith("--"));
if (!imageFile) {
  console.error("usage: npx tsx scripts/artist-loop-poc.ts <image> [--rounds=5]");
  process.exit(1);
}
const flag = (name: string, dflt: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;
const MAX_ROUNDS = Number(flag("rounds", "5"));
const DESIGNER_MODEL = flag("designer", "claude-opus-4-8");
const JUDGE_MODEL = flag("judge", "claude-opus-4-8");
const SKIP_VERIFY = args.includes("--skip-verify");
const baseName = path.basename(imageFile).replace(/\.[a-z0-9]+$/i, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-");
const OUT = path.join(process.cwd(), "tmp-artist-loop", baseName);

async function readEnv(name: string): Promise<string> {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) throw new Error(`${name} not found in .env.local`);
  return m[1]!.trim();
}

// ---------------------------------------------------------------------------
// Anthropic API (direct HTTPS, same as blind-squint-test.mjs)
// ---------------------------------------------------------------------------
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

let anthropicKey = "";
async function callClaude(
  model: string,
  content: ContentBlock[],
  maxTokens: number,
  thinking = false,
): Promise<string> {
  let useThinking = thinking;
  for (let attempt = 0; attempt < 4; attempt++) {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    };
    if (useThinking) body.thinking = { type: "adaptive" };
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // undici headers-timeout / transient network failure — retry
      const wait = 5000 * (attempt + 1);
      console.log(`  api network error (${(err as Error).message}), retrying in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 400 && useThinking) {
      // model doesn't support adaptive thinking — retry plain
      useThinking = false;
      continue;
    }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const wait = 4000 * (attempt + 1);
      console.log(`  api ${res.status}, retrying in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
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

function parseJsonLoose(text: string): unknown {
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  if (start < 0) throw new Error("no JSON object in response");
  const end = stripped.lastIndexOf("}");
  if (end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      /* fall through to truncation repair */
    }
  }
  // Truncated response repair: cut back to the last complete `}` (end of a
  // point or draft), then close whatever brackets remain open.
  let body = stripped.slice(start);
  const lastObj = body.lastIndexOf("}");
  if (lastObj < 0) throw new Error("unrepairable JSON in response");
  body = body.slice(0, lastObj + 1);
  let depthCurly = 0;
  let depthSquare = 0;
  for (const ch of body) {
    if (ch === "{") depthCurly++;
    else if (ch === "}") depthCurly--;
    else if (ch === "[") depthSquare++;
    else if (ch === "]") depthSquare--;
  }
  body += "]".repeat(Math.max(0, depthSquare)) + "}".repeat(Math.max(0, depthCurly));
  return JSON.parse(body);
}

// ---------------------------------------------------------------------------
// Designer
// ---------------------------------------------------------------------------
type DesignRound = {
  points: StreetDesignPoint[];
  label: string;
  visualFeatures: string[];
};

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

Additionally return one extra JSON key at the top level:
  "acceptableGuesses": 4-8 short words/phrases a stranger might reasonably say when
  naming the subject of the finished route (synonyms and near-misses that should
  count as recognition, e.g. for a gas-pump logo: ["gas pump","fuel pump","person at pump"]).`;

/**
 * Few-shot exemplars: sketches from this repo that actually became
 * recognizable street routes (the hand-authored winners). Shown to the
 * designer as STYLE references — never for the same subject being drawn.
 */
const EXEMPLARS: { tag: string; file: string; note: string }[] = [
  {
    tag: "gas pump fuel person",
    file: "tmp-gas-interp-v4/1-sketch.png",
    note: "a multi-part logo (pump + person): boxy pump drawn axis-aligned with its window as a retraced spur; the hose is ONE exaggerated 360° coil; head and headphone band merged into a single dome",
  },
  {
    tag: "lion",
    file: "tmp-interp-designs/lion/1-sketch.png",
    note: "an organic animal: one bold continuous silhouette; the spiky mane — the identity feature — is exaggerated and carries the whole drawing; legs are simple rectangles",
  },
  {
    tag: "turtle",
    file: "tmp-curated/turtle/upright.png",
    note: "a grid-native animal: boxy shell, head, tail and legs all axis-aligned so every edge lands on a street; instantly readable",
  },
];

async function loadExemplarBlocks(): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  const usable = EXEMPLARS.filter(
    (e) => !e.tag.split(" ").some((t) => baseName.includes(t)),
  );
  if (!usable.length) return blocks;
  blocks.push({
    type: "text",
    text:
      "Before the task: here are sketches that became SUCCESSFUL, recognizable GPS-art street routes. " +
      "Study the drawing approach — bold silhouette, exaggerated identity features, axis-aligned boxy parts, dense curves — then apply it to a NEW subject. Do not copy these subjects.\n" +
      usable.map((e, i) => `Exemplar ${i + 1}: ${e.note}.`).join("\n"),
  });
  for (const e of usable) {
    const buf = await sharp(path.join(process.cwd(), e.file))
      .resize({ width: 700, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80 })
      .toBuffer();
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") },
    });
  }
  return blocks;
}

function cleanPoints(raw: unknown): StreetDesignPoint[] {
  if (!Array.isArray(raw)) return [];
  const pts: StreetDesignPoint[] = [];
  for (const p of raw) {
    if (
      p && typeof p === "object" &&
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

const DRAFTS_PER_ROUND = 3;

async function designerCall(
  imageBlock: ContentBlock,
  critique: ContentBlock[] | null,
  exemplarBlocks: ContentBlock[],
): Promise<{ designs: DesignRound[]; acceptableGuesses: string[] }> {
  const basePrompt = buildInterpretationPrompt("Manhattan", DRAFTS_PER_ROUND) + POC_ADDENDUM;
  const content: ContentBlock[] = [
    ...exemplarBlocks,
    { type: "text", text: "Now the user's uploaded image — this is the subject to draw:" },
    imageBlock,
    ...(critique ?? []),
    { type: "text", text: basePrompt },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await callClaude(DESIGNER_MODEL, content, 32000, true);
    let json: {
      label?: string;
      visualFeatures?: string[];
      points?: unknown;
      acceptableGuesses?: string[];
      drafts?: { label?: string; visualFeatures?: string[]; points?: unknown }[];
    };
    try {
      json = parseJsonLoose(text) as typeof json;
    } catch (err) {
      console.log(`  designer attempt ${attempt + 1}: bad JSON (${(err as Error).message}), retrying`);
      continue;
    }
    const designs: DesignRound[] = [];
    const rawDrafts = Array.isArray(json.drafts) && json.drafts.length
      ? json.drafts
      : [{ label: json.label, visualFeatures: json.visualFeatures, points: json.points }];
    for (const d of rawDrafts.slice(0, DRAFTS_PER_ROUND)) {
      const pts = cleanPoints(d.points);
      if (pts.length < 8) continue;
      const featureCount = Array.isArray(d.visualFeatures) ? d.visualFeatures.length : 0;
      if (featureCount >= 5 && pts.length < 55) {
        console.log(`  draft "${d.label ?? "?"}": ${pts.length} pts for ${featureCount} features — too sparse, rejected`);
        continue;
      }
      const review = reviewStreetDesignSketch(pts);
      console.log(
        `  draft "${d.label ?? "?"}": ${pts.length} pts, review ${review.score} pass=${review.pass}` +
          (review.reasons.length ? ` (${review.reasons.join("; ")})` : ""),
      );
      designs.push({
        points: pts,
        label: typeof d.label === "string" ? d.label : (json.label ?? baseName),
        visualFeatures: Array.isArray(d.visualFeatures)
          ? d.visualFeatures.filter((f): f is string => typeof f === "string")
          : [],
      });
    }
    if (designs.length) {
      const acceptable = Array.isArray(json.acceptableGuesses)
        ? json.acceptableGuesses.filter((g): g is string => typeof g === "string")
        : [];
      return { designs, acceptableGuesses: acceptable };
    }
    console.log(`  designer attempt ${attempt + 1}: no usable drafts, retrying`);
  }
  throw new Error("designer produced no usable sketch");
}

// ---------------------------------------------------------------------------
// Placement: normalized 0..1 (y down) → grid-aligned meters → lat/lng
// Frame identical to gas-interp-v4: x along streets (119°), y along avenues (29°)
// ---------------------------------------------------------------------------
const STREET_BEARING = 119;
const AVENUE_BEARING = 29;
const M_PER_LAT = 111320;
function unit(deg: number): { e: number; n: number } {
  const r = (deg * Math.PI) / 180;
  return { e: Math.sin(r), n: Math.cos(r) };
}
const X_AXIS = unit(STREET_BEARING);
const Y_AXIS = unit(AVENUE_BEARING);
type Pt = [number, number];

function toLatLngFrom(origin: LatLng, [x, y]: Pt): LatLng {
  const e = x * X_AXIS.e + y * Y_AXIS.e;
  const n = x * X_AXIS.n + y * Y_AXIS.n;
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng];
}
function toLocalFrom(origin: LatLng, [lat, lng]: LatLng): Pt {
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng;
  const det = X_AXIS.e * Y_AXIS.n - Y_AXIS.e * X_AXIS.n;
  return [(e * Y_AXIS.n - Y_AXIS.e * n) / det, (X_AXIS.e * n - e * X_AXIS.n) / det];
}

/** p25 "stroke" length (spans between >35° turns) in normalized units. */
function strokeStats(pts: StreetDesignPoint[]): { p25: number; perimeter: number; strokes: number } {
  let perimeter = 0;
  const strokes: number[] = [];
  let strokeLen = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]!.x - pts[i - 1]!.x;
    const dy = pts[i]!.y - pts[i - 1]!.y;
    const d = Math.hypot(dx, dy);
    perimeter += d;
    strokeLen += d;
    if (i < pts.length - 1) {
      const dx2 = pts[i + 1]!.x - pts[i]!.x;
      const dy2 = pts[i + 1]!.y - pts[i]!.y;
      const l2 = Math.hypot(dx2, dy2);
      if (d > 1e-9 && l2 > 1e-9) {
        const cos = Math.max(-1, Math.min(1, (dx * dx2 + dy * dy2) / (d * l2)));
        if ((Math.acos(cos) * 180) / Math.PI > 35) {
          if (strokeLen > 0.004) strokes.push(strokeLen);
          strokeLen = 0;
        }
      }
    }
  }
  if (strokeLen > 0.004) strokes.push(strokeLen);
  strokes.sort((a, b) => a - b);
  return {
    p25: strokes.length ? strokes[Math.floor(strokes.length * 0.25)]! : 0,
    perimeter,
    strokes: strokes.length,
  };
}

function toMeters(pts: StreetDesignPoint[]): { local: Pt[]; widthM: number; heightM: number; routeKm: number } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(1e-6, maxX - minX);
  const h = Math.max(1e-6, maxY - minY);
  const { p25, perimeter, strokes } = strokeStats(pts);

  // Scale rule from the hand-built winners: complex subjects are drawn as
  // HUGE as the island allows — reference GPS art spans whole neighborhoods,
  // and that size is what lets small identity features (a stem, a bite, a
  // hose coil) survive block-level quantization. Caps: ≤2.45 km wide (10th
  // Ave → 1st Ave, like GAS v4), ≤3.3 km tall so the whole drawing stays
  // inside the UNIFORM grid window (V4 used 17th→51st ≈ 2.7 km; below 14th
  // St the grid goes irregular and compiled edges dissolve — the witch/
  // rocket run proved it), route ≤ 32 km.
  // (An earlier p25-stroke "legibility" formula MINIMIZED scale instead and
  // shrank apples to 0.8 km boxes whose bites read as letter G. Never again.)
  const caps = Math.min(2450 / w, 3300 / h, 32000 / Math.max(perimeter, 1e-6));
  let mpu = caps;
  if (strokes < 6) {
    // simple closed shapes may stay modest: big enough to read, no need to
    // eat the whole island
    if (p25 > 0) mpu = Math.min(Math.max(170 / p25, 1200 / Math.max(w, h)), caps);
  }
  // Floor: at least a 4 km route (and never a sub-kilometre-wide drawing).
  const floor = Math.max(4000 / Math.max(perimeter, 1e-6), 900 / Math.max(w, h));
  mpu = Math.max(Math.min(mpu, caps), Math.min(floor, caps));

  const local: Pt[] = pts.map((p) => [
    (p.x - minX) * mpu,
    (maxY - p.y) * mpu, // flip: image y-down → grid y-up (north along avenues)
  ]);
  return {
    local: axisAlign(local),
    widthM: w * mpu,
    heightM: h * mpu,
    routeKm: (perimeter * mpu) / 1000,
  };
}

/**
 * The hand-authored winners (gas-interp-v4) locked every boxy edge exactly
 * onto avenue columns / street rows; that is why their meanDev was ~13 m
 * while free-floating sketches compile at ~35-45 m with chopped legs.
 * Automated version: any maximal run of consecutive points that stays
 * within a ±45 m band in one axis while extending ≥250 m in the other is a
 * "straight edge the artist meant" — collapse the band to its mean so the
 * edge is perfectly axis-aligned. Curves (both axes moving) are untouched.
 */
function axisAlign(local: Pt[]): Pt[] {
  const out: Pt[] = local.map((p) => [p[0], p[1]]);
  const BAND = 90; // max wobble across the edge, meters
  const SPAN = 250; // min edge length along the edge, meters
  for (const axis of [0, 1] as const) {
    const other = axis === 0 ? 1 : 0;
    let start = 0;
    while (start < out.length - 1) {
      // grow the run while the cross-axis band stays tight
      let lo = out[start]![axis];
      let hi = lo;
      let end = start;
      while (end + 1 < out.length) {
        const v = out[end + 1]![axis];
        if (Math.max(hi, v) - Math.min(lo, v) > BAND) break;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        end++;
      }
      if (end > start) {
        const span = Math.abs(out[end]![other] - out[start]![other]);
        if (span >= SPAN) {
          let mean = 0;
          for (let k = start; k <= end; k++) mean += out[k]![axis];
          mean /= end - start + 1;
          for (let k = start; k <= end; k++) out[k]![axis] = mean;
        }
      }
      start = Math.max(end, start + 1);
    }
  }
  return out;
}

/**
 * Placement window: the uniform Manhattan grid only — 15th St to ~57th St,
 * 10th Ave to 2nd Ave. Below 14th the colonial/Village grids rotate away
 * from the 119°/29° frame and compiled edges dissolve into wobble (the
 * witch/rocket run: sketch judged 9/10, street version "dog"). The
 * hand-built GAS v4 winner lived at 17th–51st for the same reason.
 */
/**
 * Street simulator: what block quantization does to a drawing, without
 * paying for a real compile. Snap every vertex to the Manhattan lattice
 * spacing (274 m avenue columns × 80 m street rows in the grid frame) and
 * render at the same relative line weight the judged map crop uses. A
 * composition that dies here will die on real streets; one that survives
 * usually compiles recognizably.
 */
function simulateStreets(local: Pt[]): Pt[] {
  const AVE = 274;
  const ST = 80;
  // resample at ~40 m so long diagonals staircase like real compiled legs
  const dense: Pt[] = [];
  for (let i = 0; i < local.length; i++) {
    const a = local[i]!;
    if (i === 0) {
      dense.push(a);
      continue;
    }
    const p = local[i - 1]!;
    const d = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const steps = Math.max(1, Math.round(d / 40));
    for (let s = 1; s <= steps; s++) {
      dense.push([p[0] + ((a[0] - p[0]) * s) / steps, p[1] + ((a[1] - p[1]) * s) / steps]);
    }
  }
  const out: Pt[] = [];
  for (const [x, y] of dense) {
    const q: Pt = [Math.round(x / AVE) * AVE, Math.round(y / ST) * ST];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== q[0] || prev[1] !== q[1]) out.push(q);
  }
  return out;
}

const CANDIDATE_CENTERS: { name: string; center: LatLng }[] = [
  { name: "grid-sw", center: [40.744, -73.997] },
  { name: "grid-s", center: [40.746, -73.99] },
  { name: "grid-se", center: [40.744, -73.983] },
  { name: "grid-c", center: [40.751, -73.99] },
  { name: "grid-cw", center: [40.752, -73.996] },
  { name: "grid-ce", center: [40.75, -73.982] },
  { name: "grid-n", center: [40.757, -73.986] },
  { name: "grid-nw", center: [40.759, -73.992] },
];

type Placement = {
  name: string;
  origin: LatLng;
  compiled: LatticeCompileResult;
};

function placeAndCompile(
  local: Pt[],
  graph: ReturnType<typeof buildLatticeGraph>,
): Placement | null {
  const xs = local.map((p) => p[0]);
  const ys = local.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

  let best: Placement | null = null;
  let bestScore = Infinity;
  for (const { name, center } of CANDIDATE_CENTERS) {
    // origin such that the sketch bbox center lands on `center`
    const e = cx * X_AXIS.e + cy * Y_AXIS.e;
    const n = cx * X_AXIS.n + cy * Y_AXIS.n;
    const mPerLng = M_PER_LAT * Math.cos((center[0] * Math.PI) / 180);
    const origin: LatLng = [center[0] - n / M_PER_LAT, center[1] - e / mPerLng];
    const placed = local.map((p) => toLatLngFrom(origin, p));
    const compiled = compileContourToLattice(placed, graph, {
      sampleMeters: 38,
      pinRadiusMeters: 150,
    });
    if (!compiled) {
      console.log(`  placement ${name}: compile null`);
      continue;
    }
    // Skipped pins leave visible GAPS in the drawing (a chopped pump bottom,
    // a missing rocket shoulder) — a placement with ANY gap loses to any
    // gap-free one, no matter how its deviation compares.
    const score =
      compiled.meanDeviationMeters +
      compiled.maxDeviationMeters / 10 +
      (compiled.skippedPins > 0 ? 10000 + compiled.skippedPins * 150 : 0);
    console.log(
      `  placement ${name}: km=${compiled.km.toFixed(1)} meanDev=${compiled.meanDeviationMeters.toFixed(1)} ` +
        `maxDev=${compiled.maxDeviationMeters.toFixed(0)} skipped=${compiled.skippedPins} score=${score.toFixed(0)}`,
    );
    if (score < bestScore) {
      bestScore = score;
      best = { name, origin, compiled };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Renders (same approach as gas-interp-v4)
// ---------------------------------------------------------------------------
function localSvg(paths: { pts: Pt[]; color: string; width: number }[], w = 900): string {
  const all = paths.flatMap((p) => p.pts);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs) - 150;
  const maxX = Math.max(...xs) + 150;
  const minY = Math.min(...ys) - 150;
  const maxY = Math.max(...ys) + 150;
  const scale = w / (maxX - minX);
  const h = Math.round((maxY - minY) * scale);
  const px = ([x, y]: Pt) =>
    `${((x - minX) * scale).toFixed(1)} ${((maxY - y) * scale).toFixed(1)}`;
  const body = paths
    .map(
      (p) =>
        `<path d="${p.pts.map((q, i) => `${i === 0 ? "M" : "L"} ${px(q)}`).join(" ")}" ` +
        `fill="none" stroke="${p.color}" stroke-width="${p.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("\n");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="white"/>${body}</svg>`;
}

const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

async function renderMap(chain: LatLng[], file: string, w = 1400, h = 1100) {
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
  const d = chain
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`)
    .join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${d}" fill="none" stroke="#7f1024" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>` +
      `<path d="${d}" fill="none" stroke="#e8253f" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`,
  );
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eee" } })
    .composite([...tiles, { input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(file);
}

// ---------------------------------------------------------------------------
// Blind judge (mechanics of blind-squint-test.mjs)
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
  if (found < 30) {
    return sharp(file).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  }
  const padX = Math.round((maxX - minX) * 0.08) + 20;
  const padY = Math.round((maxY - minY) * 0.08) + 20;
  const left = Math.max(0, minX - padX), top = Math.max(0, minY - padY);
  return sharp(file)
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

/** Generic words that appear in guesses about anything — matching on them
 *  lets "dog head" count as recognition of "head with headphones". */
const GENERIC_TOKENS = new Set([
  "head", "face", "animal", "figure", "shape", "object", "thing",
  "drawing", "picture", "outline", "body", "man", "woman",
]);

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter((w) => !GENERIC_TOKENS.has(w));

function guessMatches(guess: string, acceptable: string[]): boolean {
  const g = norm(guess);
  if (!g.length || guess.toLowerCase().includes("nothing recognizable")) return false;
  for (const a of acceptable) {
    const at = norm(a);
    if (!at.length) continue;
    if (at.some((t) => g.includes(t)) || g.some((t) => at.includes(t))) return true;
  }
  return false;
}

async function blindJudge(
  mapFile: string,
  acceptable: string[],
  prompt: string = JUDGE_PROMPT,
): Promise<JudgeResult> {
  const buf = await cropToRoute(mapFile);
  const samples: JudgeSample[] = [];
  for (let i = 0; i < 3; i++) {
    const text = await callClaude(
      JUDGE_MODEL,
      [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
        { type: "text", text: prompt },
      ],
      1024,
    );
    const guess = text.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE|$)/i)?.[1]?.trim() ?? text.slice(0, 60);
    const confidence = Number(text.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)/i)?.[1] ?? 0);
    samples.push({ guess, confidence });
  }
  const recognizedCount = samples.filter((s) => guessMatches(s.guess, acceptable)).length;
  const confs = samples.map((s) => s.confidence).sort((a, b) => a - b);
  return { samples, recognizedCount, medianConfidence: confs[1] ?? 0 };
}

// ---------------------------------------------------------------------------
// Verify gates (ported from gas-interp-v4-verify.ts)
// ---------------------------------------------------------------------------
async function verifyChain(chain: LatLng[], latticeData: LatticeData) {
  const nodeSet = new Set(latticeData.nodes.map(([a, b]) => `${a}:${b}`));
  const junctionIdx: number[] = [];
  for (let i = 0; i < chain.length; i++) {
    if (nodeSet.has(`${chain[i]![0]}:${chain[i]![1]}`)) junctionIdx.push(i);
  }
  type Leg = { a: LatLng; b: LatLng; chainM: number };
  const legs: Leg[] = [];
  for (let k = 1; k < junctionIdx.length; k++) {
    const i0 = junctionIdx[k - 1]!, i1 = junctionIdx[k]!;
    let m = 0;
    for (let i = i0 + 1; i <= i1; i++) m += haversineMeters(chain[i - 1]!, chain[i]!);
    if (m >= 1) legs.push({ a: chain[i0]!, b: chain[i1]!, chainM: m });
  }
  const totalKm = legs.reduce((s, l) => s + l.chainM, 0) / 1000;
  let worstDetour = 0;
  for (const l of legs) {
    const chord = haversineMeters(l.a, l.b);
    if (chord > 30) worstDetour = Math.max(worstDetour, l.chainM / chord);
  }

  const token = await readEnv("NEXT_PUBLIC_MAPBOX_TOKEN");
  const failures: { i: number; reason: string }[] = [];
  let mapboxTotalM = 0;
  const CHUNK = 24;
  for (let start = 0; start < legs.length; start += CHUNK) {
    const slice = legs.slice(start, start + CHUNK);
    const coords = [slice[0]!.a, ...slice.map((l) => l.b)]
      .map(([la, ln]) => `${ln.toFixed(6)},${la.toFixed(6)}`)
      .join(";");
    const res = await fetch(
      `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}?geometries=geojson&overview=false&access_token=${token}`,
    );
    if (!res.ok) {
      failures.push({ i: start, reason: `HTTP ${res.status}` });
      continue;
    }
    const json = (await res.json()) as {
      code: string;
      routes?: { legs: { distance: number }[]; distance: number }[];
    };
    if (json.code !== "Ok" || !json.routes?.[0]) {
      failures.push({ i: start, reason: `code ${json.code}` });
      continue;
    }
    mapboxTotalM += json.routes[0].distance;
    const mLegs = json.routes[0].legs;
    for (let j = 0; j < slice.length; j++) {
      const got = mLegs[j]?.distance ?? Infinity;
      const want = slice[j]!.chainM;
      if (got > want * 1.25 && got - want > 80) {
        if (want < 75 && got < 160) continue; // plaza crossing exemption
        failures.push({ i: start + j, reason: `mapbox ${got.toFixed(0)}m vs chain ${want.toFixed(0)}m` });
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    junctionCount: junctionIdx.length,
    legCount: legs.length,
    chainKm: Number(totalKm.toFixed(2)),
    mapboxKm: Number((mapboxTotalM / 1000).toFixed(2)),
    worstLegDetourRatio: Number(worstDetour.toFixed(2)),
    legFailures: failures,
  };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
type RoundRecord = {
  round: number;
  design: DesignRound;
  placement: Placement;
  judge: JudgeResult;
  local: Pt[];
  mapFile: string;
  sketchFile: string;
  sketchJudge: JudgeResult;
};

async function main() {
  const t0 = Date.now();
  anthropicKey = await readEnv("ANTHROPIC_API_KEY");
  await fs.mkdir(OUT, { recursive: true });

  const imgBuf = await sharp(imageFile!).resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 90 }).toBuffer();
  const imageBlock: ContentBlock = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: imgBuf.toString("base64") },
  };

  const latticeData = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "lib", "data", "manhattan-lattice.json"), "utf8"),
  ) as LatticeData;
  const graph = buildLatticeGraph(latticeData);

  let acceptable: string[] = [];
  let critique: ContentBlock[] | null = null;
  const rounds: RoundRecord[] = [];
  const historyLines: string[] = [];
  const exemplarBlocks = await loadExemplarBlocks();
  console.log(`few-shot exemplars: ${Math.max(0, exemplarBlocks.length - 1)} (subject-clash filtered)`);

  let solved = false;
  for (let round = 1; round <= MAX_ROUNDS && !solved; round++) {
    console.log(`\n━━━ ROUND ${round}/${MAX_ROUNDS} ━━━`);
    const tRound = Date.now();

    const { designs, acceptableGuesses } = await designerCall(imageBlock, critique, exemplarBlocks);
    // Freeze the answer key after round 1 — later rounds may not move the
    // goalposts by relabeling the subject.
    if (!acceptable.length) {
      acceptable = acceptableGuesses.length ? acceptableGuesses : [designs[0]!.label];
      console.log(`  acceptable answers (frozen): [${acceptable.join(", ")}]`);
    }

    let bestOfRound: RoundRecord | null = null;
    let sketchFailNote: { design: DesignRound; sketchFile: string; judge: JudgeResult } | null = null;
    for (let di = 0; di < designs.length; di++) {
      const design = designs[di]!;
      const tag = `round-${round}${designs.length > 1 ? String.fromCharCode(97 + di) : ""}`;
      console.log(`  ── draft ${tag}: "${design.label}" [${design.visualFeatures.join(", ")}]`);

      const { local, widthM, heightM, routeKm } = toMeters(design.points);
      console.log(`  scale: ${(widthM / 1000).toFixed(1)}×${(heightM / 1000).toFixed(1)} km box, ~${routeKm.toFixed(1)} km drawn line`);

      const sketchFile = path.join(OUT, `${tag}-sketch.png`);
      await sharp(Buffer.from(localSvg([{ pts: local, color: "#111", width: 7 }]))).png().toFile(sketchFile);

      // Stage 1: judge the CLEAN sketch. If strangers can't name the line
      // drawing itself, streets will only make it worse — redraw, don't
      // waste a compile.
      const sketchJudge = await blindJudge(sketchFile, acceptable, SKETCH_JUDGE_PROMPT);
      console.log(
        `  SKETCH JUDGE: ${sketchJudge.samples.map((s) => `"${s.guess}"(${s.confidence})`).join("  ")} → ` +
          `${sketchJudge.recognizedCount}/3`,
      );
      if (sketchJudge.recognizedCount === 0) {
        console.log("  sketch itself unrecognizable — skipping compile, needs redraw");
        historyLines.push(
          `Round ${round} draft "${design.label}" (${design.points.length} pts): CLEAN SKETCH already failed — strangers saw ${[...new Set(sketchJudge.samples.map((s) => s.guess))].join(" / ")}.`,
        );
        if (!sketchFailNote) sketchFailNote = { design, sketchFile, judge: sketchJudge };
        continue;
      }

      // Stage 2: street SIMULATOR — quantize to block spacing and judge
      // again. Survives here → usually survives real streets.
      const simFile = path.join(OUT, `${tag}-sim.png`);
      await sharp(Buffer.from(localSvg([{ pts: simulateStreets(local), color: "#111", width: 10 }])))
        .png().toFile(simFile);
      const simJudge = await blindJudge(simFile, acceptable, SKETCH_JUDGE_PROMPT);
      console.log(
        `  SIM JUDGE (block-quantized): ${simJudge.samples.map((s) => `"${s.guess}"(${s.confidence})`).join("  ")} → ` +
          `${simJudge.recognizedCount}/3`,
      );
      if (simJudge.recognizedCount === 0) {
        console.log("  composition dies under block quantization — skipping compile");
        historyLines.push(
          `Round ${round} draft "${design.label}": clean sketch was recognized, but after BLOCK QUANTIZATION strangers saw ${[...new Set(simJudge.samples.map((s) => s.guess))].join(" / ")} — features merged or degenerated at street scale.`,
        );
        if (!sketchFailNote) sketchFailNote = { design, sketchFile: simFile, judge: simJudge };
        continue;
      }

      const placement = placeAndCompile(local, graph);
      if (!placement) {
        console.log("  no placement compiled — skipping draft");
        continue;
      }
      const c = placement.compiled;

      const compiledFile = path.join(OUT, `${tag}-compiled.png`);
      const mapFile = path.join(OUT, `${tag}-map.png`);
      const compiledLocal = c.chain.map((p) => toLocalFrom(placement.origin, p));
      await sharp(Buffer.from(localSvg([
        { pts: local, color: "#f2b8c0", width: 4 },
        { pts: compiledLocal, color: "#111", width: 6 },
      ]))).png().toFile(compiledFile);
      await renderMap(c.chain, mapFile);

      const judge = await blindJudge(mapFile, acceptable);
      console.log(
        `  BLIND JUDGE: ${judge.samples.map((s) => `"${s.guess}"(${s.confidence})`).join("  ")} → ` +
          `${judge.recognizedCount}/3 recognized, median conf ${judge.medianConfidence}`,
      );
      await fs.writeFile(
        path.join(OUT, `${tag}-judge.json`),
        JSON.stringify({ design: { label: design.label, visualFeatures: design.visualFeatures, points: design.points.length }, placement: placement.name, compile: { km: c.km, meanDev: c.meanDeviationMeters, maxDev: c.maxDeviationMeters, skippedPins: c.skippedPins }, judge }, null, 2),
      );

      const rec: RoundRecord = { round, design, placement, judge, local, mapFile, sketchFile, sketchJudge };
      rounds.push(rec);
      if (
        !bestOfRound ||
        rec.judge.recognizedCount > bestOfRound.judge.recognizedCount ||
        (rec.judge.recognizedCount === bestOfRound.judge.recognizedCount &&
          rec.judge.medianConfidence > bestOfRound.judge.medianConfidence)
      ) {
        bestOfRound = rec;
      }
      if (judge.recognizedCount >= 2 && judge.medianConfidence >= 6) {
        console.log("  ✔ blind judge recognized it with confidence — stopping early");
        solved = true;
        break;
      }
    }
    console.log(`  round time: ${((Date.now() - tRound) / 1000).toFixed(0)}s`);
    if (solved) continue;
    if (!bestOfRound) {
      if (sketchFailNote) {
        // every draft died at the sketch stage — critique the drawing itself
        const sj = sketchFailNote.judge;
        const failSketchJpeg = await sharp(sketchFailNote.sketchFile)
          .resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
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
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: failSketchJpeg.toString("base64") } },
        ];
      } else {
        critique = [
          { type: "text", text: "None of your designs could be fitted onto the street grid at a legible scale. Draw simpler, bolder versions: fewer, longer strokes; long edges axis-aligned." },
        ];
      }
      continue;
    }
    const design = bestOfRound.design;
    const placement = bestOfRound.placement;
    const judge = bestOfRound.judge;
    const c = placement.compiled;
    const sketchFile = bestOfRound.sketchFile;
    const mapFile = bestOfRound.mapFile;

    // build critique for the next round: intended sketch vs what streets did
    // to it, what blind strangers saw, and the tangle diagnostics.
    const review = reviewStreetDesignSketch(design.points);
    const mapCrop = await cropToRoute(mapFile);
    const sketchJpeg = await sharp(sketchFile)
      .resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
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
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: sketchJpeg.toString("base64") } },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: (
            await sharp(bestOfRound.sketchFile.replace("-sketch.png", "-compiled.png"))
              .resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
          ).toString("base64"),
        },
      },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: mapCrop.toString("base64") } },
    ];
  }

  if (!rounds.length) throw new Error("no round produced a compiled route");

  // pick the winner: recognition first, then confidence, then fidelity
  rounds.sort(
    (a, b) =>
      b.judge.recognizedCount - a.judge.recognizedCount ||
      b.judge.medianConfidence - a.judge.medianConfidence ||
      a.placement.compiled.meanDeviationMeters - b.placement.compiled.meanDeviationMeters,
  );
  const win = rounds[0]!;
  const c = win.placement.compiled;
  console.log(`\n━━━ WINNER: round ${win.round} (${win.judge.recognizedCount}/3 @ conf ${win.judge.medianConfidence}, ${c.km.toFixed(1)} km, ${win.placement.name}) ━━━`);

  // sheet: source | sketch | compiled | map
  const fit = (file: string, wpx: number, hpx: number) =>
    sharp(file).resize(wpx, hpx, { fit: "contain", background: "#fff" }).png().toBuffer();
  const cell = 620;
  const label = (t: string) =>
    Buffer.from(`<svg width="${cell}" height="40"><text x="10" y="28" font-family="Arial" font-size="24" font-weight="700" fill="#111">${t}</text></svg>`);
  await sharp({ create: { width: cell * 4 + 50, height: cell + 70, channels: 4, background: "#fff" } })
    .composite([
      { input: await fit(imageFile!, cell, cell), left: 10, top: 60 },
      { input: await fit(win.sketchFile, cell, cell), left: cell + 20, top: 60 },
      { input: await fit(win.sketchFile.replace("-sketch.png", "-compiled.png"), cell, cell), left: cell * 2 + 30, top: 60 },
      { input: await fit(win.mapFile, cell, cell), left: cell * 3 + 40, top: 60 },
      { input: label("1. upload"), left: 10, top: 10 },
      { input: label("2. AI sketch (no hands)"), left: cell + 20, top: 10 },
      { input: label("3. compiled to streets"), left: cell * 2 + 30, top: 10 },
      { input: label("4. on the map"), left: cell * 3 + 40, top: 10 },
    ])
    .png()
    .toFile(path.join(OUT, "SHEET.png"));

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso artist-loop POC" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${win.design.label}</name><trkseg>
${c.chain.map(([la, ln]) => `    <trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  await fs.writeFile(path.join(OUT, `${baseName}.gpx`), gpx, "utf8");

  let verify: Awaited<ReturnType<typeof verifyChain>> | null = null;
  if (!SKIP_VERIFY) {
    console.log("\nverifying winner against live Mapbox walking directions…");
    verify = await verifyChain(c.chain, latticeData);
    console.log(
      `  gate1 junctions=${verify.junctionCount}  gate2 worstDetour=${verify.worstLegDetourRatio}  ` +
        `gate3 mapbox ${verify.mapboxKm} km vs chain ${verify.chainKm} km, ${verify.legFailures.length} failures`,
    );
    console.log(verify.legFailures.length === 0 ? "  ALL GATES GREEN — route is runnable" : "  GATES FAILED");
  }

  await fs.writeFile(
    path.join(OUT, "meta.json"),
    JSON.stringify(
      {
        image: path.basename(imageFile!),
        designerModel: DESIGNER_MODEL,
        judgeModel: JUDGE_MODEL,
        roundsRun: rounds.length,
        winnerRound: win.round,
        label: win.design.label,
        acceptableGuesses: acceptable,
        judge: win.judge,
        placement: win.placement.name,
        routeKm: Number(c.km.toFixed(2)),
        meanDeviationMeters: Number(c.meanDeviationMeters.toFixed(1)),
        maxDeviationMeters: Number(c.maxDeviationMeters.toFixed(1)),
        skippedPins: c.skippedPins,
        verify,
        totalSeconds: Math.round((Date.now() - t0) / 1000),
      },
      null,
      2,
    ),
  );
  console.log(`\ndone in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min — ${path.join(OUT, "SHEET.png")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
