/**
 * Server-only orchestration for /api/interpret-sketch — the AI
 * "street-ready redraw" (interpretation) step.
 *
 * The problem it solves (measured, July 2026): literal traces of real
 * uploads don't survive streets — fine detail melts, multi-part subjects
 * fragment, and blind judges see mush (PIPELINE-GAP, WOW.md). What DOES
 * survive is a bold icon-grade one-line interpretation — every verified
 * route in tmp-wow/best came from one. This module automates that
 * authoring, with the blind judge as the gate:
 *
 *  1. Identify the subject and its distinctive features from the ORIGINAL
 *     upload (judges read originals fine; it's traces that lose them).
 *  2. Have the model draft a bold one-line drawing as a primitive program
 *     (lib/sketchInterpret.ts) under the measured drawing grammar.
 *  3. Render and blind-judge each draft (3 independent calls, zero
 *     context). Iterate privately, feeding failures back, up to 4 rounds.
 *  4. Return the best draft ONLY if >= 2/3 judges recognized the subject —
 *     otherwise an honest refusal. The user then approves or rejects the
 *     redraw; their original trace is never overwritten silently.
 *
 * Server-only: never import from client components.
 */
import type { NormalizedPoint } from "./streetGraphTrace";
import {
  parsePrimitiveProgram,
  compilePrimitiveProgram,
  strokesToContour,
  guessMatchesSubject,
} from "./sketchInterpret";
import { renderStrokesPng } from "./wowPlaceServer";

const MODEL = "claude-opus-4-8"; // measurement parity with the judge series
const MAX_ROUNDS = 4;

export type InterpretProgress = (detail: string) => void;

export type InterpretResult = {
  contour: NormalizedPoint[] | null;
  subject: string | null;
  features: string | null;
  guesses: string[];
  hits: number;
  meanConfidence: number;
  rounds: number;
  previewPngBase64: string | null;
  message?: string;
};

type Media = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

async function vision(
  apiKey: string,
  content: (
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: Media; data: string } }
  )[],
  maxTokens = 1024,
): Promise<string | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
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

const img = (data: string, media: Media) =>
  ({ type: "image", source: { type: "base64", media_type: media, data } }) as const;

/** Blind judge — same protocol as scripts/blind-squint-test.mjs. */
async function blindJudge(
  apiKey: string,
  png: Buffer,
): Promise<{ guess: string; confidence: number } | null> {
  const text = await vision(apiKey, [
    img(png.toString("base64"), "image/png"),
    {
      type: "text",
      text:
        'This is line art a runner wants to "draw" with a GPS route. What does it depict? Reply in this exact format:\nGUESS: <1-3 words, or "nothing recognizable">\nCONFIDENCE: <0-10>',
    },
  ]);
  const m = text?.match(/GUESS:\s*(.+?)\s*CONFIDENCE:\s*(\d+)/is);
  if (!m) return null;
  return { guess: m[1]!.trim().replace(/\s+/g, " "), confidence: Number(m[2]) };
}

const GRAMMAR = `Draw a BOLD one-line interpretation of the subject, the way champion GPS-artists do. Hard rules, each learned from measured failures:
- ONE bold closed silhouette carries the drawing. At most 4 strokes total; extra strokes only for one critical detail (an eye, an olive) that must float free.
- EXAGGERATE the 1-2 most distinctive features (a trunk, long ears, a long neck) — bigger than life. Distinctiveness survives; realism does not.
- NO fine detail: no feature smaller than ~8% of the drawing's span, no texture, no interior lines, no fingers/toes/whiskers. City streets quantize every line to ~250 m blocks — anything thin melts into mush.
- Limbs/appendages: EITHER a single out-and-back retrace along one path (go down the leg, come back up the same line) at least 15% of the span long, OR a chunky closed limb at least 10% of the span wide. Never a thin 2-line limb narrower than that — it collapses into scribble.
- The silhouette must still read when rotated up to 30 degrees and when every line is quantized to a city grid.
- Think icon, not photograph. If a stranger squinting at 20 meters wouldn't name it, simplify further.

Output ONLY a JSON object, no prose, in this exact schema (coordinates are 0..1000, y is UP):
{"strokes":[{"elements":[
  {"type":"line","points":[[x,y],[x,y],...]},
  {"type":"arc","cx":n,"cy":n,"r":n,"startDeg":n,"endDeg":n},
  {"type":"bez","p0":[x,y],"c":[x,y],"p1":[x,y]}
]}]}
Elements within a stroke are drawn in order as one continuous pen line (consecutive elements should connect end-to-start). Separate strokes are separate runs (pen lifts) — use sparingly.`;

export async function interpretSketch(args: {
  apiKey: string;
  imageBase64: string; // raw base64, no data: prefix
  mediaType: Media;
  onProgress?: InterpretProgress;
}): Promise<InterpretResult> {
  const progress = args.onProgress ?? (() => {});
  const empty: InterpretResult = {
    contour: null, subject: null, features: null, guesses: [], hits: 0,
    meanConfidence: 0, rounds: 0, previewPngBase64: null,
  };

  progress("Studying your image…");
  const idText = await vision(args.apiKey, [
    img(args.imageBase64, args.mediaType),
    {
      type: "text",
      text:
        "What does this image depict, and what are its 2-3 most visually distinctive features (the things a silhouette must keep for a stranger to recognize it)? Reply in this exact format:\nSUBJECT: <the simplest common name a stranger would shout on seeing it — 1-3 words, e.g. \"a gas pump\", \"an elephant\">\nFEATURES: <comma-separated, short>",
    },
  ]);
  const idm = idText?.match(/SUBJECT:\s*(.+?)\s*FEATURES:\s*(.+)/is);
  if (!idm) {
    return { ...empty, message: "Couldn't read the image — try a clearer upload." };
  }
  const subject = idm[1]!.trim().replace(/\s+/g, " ").slice(0, 80);
  const features = idm[2]!.trim().replace(/\s+/g, " ").slice(0, 200);

  let best: {
    contour: NormalizedPoint[];
    png: Buffer;
    hits: number;
    meanConfidence: number;
    guesses: string[];
  } | null = null;
  let feedback = "";
  let lastPng: Buffer | null = null;
  let round = 0;

  // Each retry changes STRATEGY, not just wording — identical prompts
  // converge on the same failed drawing.
  const STRATEGY = [
    "",
    "Exaggerate the single most distinctive feature to twice its natural size — make it impossible to miss.",
    "Ignore this photo's pose entirely: draw the most ICONIC, canonical view of the subject (the version a road-sign or emoji would use).",
    "Radical simplification: silhouette only — at most 12 straight segments and 2 arcs. Nothing else.",
  ];

  for (round = 1; round <= MAX_ROUNDS; round++) {
    progress(`Drawing ${subject} — attempt ${round} of ${MAX_ROUNDS}…`);
    const content: Parameters<typeof vision>[1] = [img(args.imageBase64, args.mediaType)];
    if (lastPng) content.push(img(lastPng.toString("base64"), "image/png"));
    content.push({
      type: "text",
      text:
        `Subject: ${subject}\nDistinctive features to preserve: ${features}\n\n${GRAMMAR}` +
        (STRATEGY[round - 1] ? `\n\nThis attempt's strategy: ${STRATEGY[round - 1]}` : "") +
        (feedback
          ? `\n\nThe second image is your previous attempt as the judges saw it. It failed: ${feedback} Redraw from scratch.`
          : ""),
    });
    const draftText = await vision(args.apiKey, content, 4096);
    if (!draftText) continue;
    const jsonText = draftText.slice(draftText.indexOf("{"), draftText.lastIndexOf("}") + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      feedback = "the drawing program was not valid JSON.";
      continue;
    }
    const program = parsePrimitiveProgram(parsed);
    if (!program) {
      feedback = "the drawing program had no valid strokes.";
      continue;
    }
    const strokes = compilePrimitiveProgram(program);
    if (!strokes.length) {
      feedback = "the compiled drawing was empty.";
      continue;
    }

    const png = await renderStrokesPng(strokes);
    lastPng = png;
    progress(`Blind-testing attempt ${round} on three judges…`);
    const verdicts = (
      await Promise.all([1, 2, 3].map(() => blindJudge(args.apiKey, png)))
    ).filter((v): v is { guess: string; confidence: number } => v !== null);
    const hits = verdicts.filter((v) => guessMatchesSubject(subject, v.guess)).length;
    const meanConfidence = verdicts.length
      ? verdicts.reduce((a, v) => a + v.confidence, 0) / verdicts.length
      : 0;
    const guesses = verdicts.map((v) => `${v.guess} (${v.confidence})`);

    if (!best || hits > best.hits || (hits === best.hits && meanConfidence > best.meanConfidence)) {
      best = {
        contour: strokesToContour(strokes),
        png,
        hits,
        meanConfidence: Number(meanConfidence.toFixed(1)),
        guesses,
      };
    }
    // Don't settle for a weak pass: 3/3 at low confidence still tends to
    // fall under the street judge's bar downstream ("I think I see it" vs
    // "OH WOW"). Keep drawing unless it is STRONGLY recognized.
    if (hits === 3 && verdicts.length === 3 && meanConfidence >= 7) break;
    feedback =
      hits === 3
        ? `all judges said ${subject}, but only at confidence ${meanConfidence.toFixed(0)}/10 — make it bolder and more unmistakable.`
        : `blind judges saw "${verdicts.map((v) => v.guess).join('", "')}" instead of ${subject}.`;
  }

  if (!best || best.hits < 2) {
    return {
      ...empty,
      subject,
      features,
      rounds: Math.min(round, MAX_ROUNDS),
      guesses: best?.guesses ?? [],
      hits: best?.hits ?? 0,
      meanConfidence: best?.meanConfidence ?? 0,
      message: `We tried ${Math.min(round, MAX_ROUNDS)} redraws of "${subject}", but blind judges never reliably recognized any of them${best?.guesses.length ? ` (best attempt was seen as: ${best.guesses.join(", ")})` : ""}. This subject may need a simpler reference image.`,
    };
  }

  return {
    contour: best.contour,
    subject,
    features,
    guesses: best.guesses,
    hits: best.hits,
    meanConfidence: best.meanConfidence,
    rounds: Math.min(round, MAX_ROUNDS),
    previewPngBase64: best.png.toString("base64"),
  };
}
