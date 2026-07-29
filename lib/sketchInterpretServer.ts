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
 * Composite uploads (multi-element logos/scenes) get a different gate: the
 * whole composition is drafted first and judged on LIKENESS to the upload
 * (comparative judges who see both images), because blind strangers can't
 * name a brand mark that its owner recognizes instantly.
 *
 * Server-only: never import from client components.
 */
import type { NormalizedPoint } from "./streetGraphTrace";
import {
  parsePrimitiveProgram,
  compilePrimitiveProgram,
  strokesToContour,
  guessMatchesSubject,
  snapStrokesToLattice,
} from "./sketchInterpret";
import { renderStrokesPng } from "./wowPlaceServer";
import { strokesInkRatio } from "./wowFunnel";

type Pt2 = [number, number];

const MODEL = "claude-opus-4-8"; // measurement parity with the judge series
const MAX_ROUNDS = 4;
// Placement physics for the scale-honest street simulation (mirrors
// wowPlaceServer: extent = km*1000 / (inkRatio * STREET_FACTOR), clamped).
// A drawing's own ink density decides how LARGE it can be placed while
// staying runnable — dense drawings shrink until features melt. Simulating
// at a fixed canvas hid that (July 29: a draft passed the sim at 7/10, then
// every street placement of it scored 2-6 because 25 km of ink forced a
// 2.2 km canvas). SIM_TARGET_KM sits in the upper-middle of wow-place's
// default 7-26 km window, matching the extents it actually tries.
const SIM_STREET_FACTOR = 1.25;
const SIM_TARGET_KM = 20;
const simExtentM = (strokes: Pt2[][]): number => {
  const inkUnits = strokesInkRatio(strokes); // ink length / span, unitless
  return Math.round(Math.min(4200, Math.max(1100, (SIM_TARGET_KM * 1000) / (inkUnits * SIM_STREET_FACTOR))));
};
// Comparative-judge pass bar, calibrated July 29 against renders with known
// Ralph verdicts vs gas.png: v5's compiled lattice render (his "OK, starting
// point" bar) scored 6,6,7; a wrong-image control (elephant) scored 2,2,2.
// A judge score >= 6 is a hit; acceptance needs 2 of 3 hits — the accepted
// bar passes 3/3, the control 0/3.
const COMPARE_PASS_SCORE = 6;

export type InterpretProgress = (detail: string) => void;

export type InterpretResult = {
  contour: NormalizedPoint[] | null;
  subject: string | null;
  features: string | null;
  guesses: string[];
  hits: number;
  meanConfidence: number;
  /** 1-10: how recognizable the redraw is as a simplified version of the ORIGINAL upload */
  resemblance: number;
  /**
   * True when the accepted redraw is the WHOLE multi-element composition,
   * gated on likeness-to-upload. Downstream placement must then judge
   * candidates the same way (comparative, vs the upload) — a primed judge
   * asked about the single-element subject scores the full logo unfairly.
   */
  composite: boolean;
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
  // A full run bursts ~30 vision calls; transient 429/5xx/network failures
  // are routine under that load and a silently-null judge or identify call
  // corrupts the whole verdict (measured July 30: a live run's fallback
  // ladder never ran because its one identify call failed — 4 rounds
  // instead of 9, honest rescue skipped). Retry twice with backoff.
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
          model: MODEL,
          max_tokens: maxTokens,
          messages: [{ role: "user", content }],
        }),
      });
      if (!res.ok) {
        // 4xx other than 429 won't heal on retry
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

/**
 * Comparative judge — sees the ORIGINAL upload beside the street-simulated
 * redraw and scores likeness. The gate for composite/logo uploads (Ralph,
 * July 29): a blind stranger can never NAME a multi-element brand mark, but
 * its owner recognizes a faithful redraw instantly — "looks similar, good
 * starting point" is the accepted bar, so acceptance is likeness to the
 * upload, not blind naming.
 */
async function compareJudge(
  apiKey: string,
  originalBase64: string,
  originalMedia: Media,
  png: Buffer,
): Promise<{ score: number; why: string } | null> {
  const text = await vision(apiKey, [
    img(originalBase64, originalMedia),
    img(png.toString("base64"), "image/png"),
    {
      type: "text",
      text:
        "The second image is a bold one-line redraw of the first, quantized to a city street grid so a runner can draw it with a GPS route. Score how recognizable it is as a simplified version of the first image — same elements, same arrangement, same identity. Reply in this exact format:\nSCORE: <0-10>\nWHY: <short phrase>",
    },
  ]);
  const m = text?.match(/SCORE:\s*(\d+)\s*WHY:\s*(.+)/is);
  if (!m) return null;
  return { score: Number(m[1]), why: m[2]!.trim().replace(/\s+/g, " ").slice(0, 120) };
}

const GRAMMAR = `Draw a BOLD one-line interpretation of the subject, the way champion GPS-artists do. Hard rules, each learned from measured failures:
- Draw the subject as ONE CLOSED SILHOUETTE OUTLINE — as if tracing around a solid, filled shape. NEVER a thin stick figure: measured on real streets, skeletal line-drawings melt into scribble while chunky closed outlines survive. Limbs, ears, tails and handles are outline protrusions WITH WIDTH (at least 8% of the span across), like a bold logo silhouette. The pen ends where it started.
- EXCEPTION — HUMAN FIGURES: closed-outline humans read as ROBOTS (measured: three blind judges called one "robot" at confidence 9). Draw a person as a bold ACTION FIGURE instead: one large round head (a circle ~13% of the span) on a body of thick out-and-back retraced limbs in a DYNAMIC ASYMMETRIC pose — mid-stride, arms at different angles, everything diagonal, nothing vertical-symmetric. Wearables (headphones, a hat) must be drawn HUGE, at least 20% of the span, or dropped.
- The drawing is ONE CONTINUOUS LINE — a runner draws it in a single run without stopping the GPS. No floating parts. To reach an unavoidable interior detail, travel back along a line you already drew (a retrace adds no visible ink) or attach the detail to the silhouette.
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
Use exactly ONE stroke. Elements within it are drawn in order as one continuous pen line (consecutive elements must connect end-to-start). If you output several strokes they will be joined with straight lines in drawing order — visible ink — so design the drawing to be continuous yourself.

Example of the expected level — an elephant, one continuous CLOSED silhouette outline, blind-verified at confidence 9 on real streets (note: chunky legs with width, the ear as an attached lobe, the trunk as a wide curved protrusion, pen returns to start):
{"strokes":[{"elements":[
  {"type":"bez","p0":[95,160],"c":[70,380],"p1":[140,600]},
  {"type":"line","points":[[140,600],[170,690],[280,780],[350,720],[430,640],[410,500],[320,560],[350,720]]},
  {"type":"bez","p0":[350,720],"c":[560,840],"p1":[760,640]},
  {"type":"line","points":[[760,640],[790,520],[845,340],[790,470],[770,470],[770,0],[670,0],[670,420],[480,400],[450,410],[450,0],[350,0],[350,440],[300,480],[250,520]]},
  {"type":"bez","p0":[250,520],"c":[160,380],"p1":[160,240]},
  {"type":"line","points":[[160,240],[200,175],[215,225]]}
]}]}

Example for a HUMAN FIGURE — a sprinting runner, blind-verified on real streets ABOVE a human reference sample (note: big round head, thick retraced limbs, dynamic diagonal mid-stride pose):
{"strokes":[{"elements":[
  {"type":"arc","cx":470,"cy":890,"r":65,"startDeg":-90,"endDeg":270},
  {"type":"line","points":[[485,780],[600,690],[700,750],[600,690],[485,780],[380,700],[300,760],[380,700],[485,780],[430,520],[560,400],[590,210],[660,195],[590,210],[560,400],[430,520],[310,390],[210,460]]}
]}]}`;

/**
 * Extra rules for composite artwork (multi-element logos/scenes), appended
 * to GRAMMAR in compare mode. Generalized from the hand-designed routes
 * that worked (a verified 23 km multi-element logo route, a letter lockup,
 * an animal face) — none of it is specific to any one image.
 */
const COMPOSITE_GRAMMAR = `

COMPOSITE-ARTWORK OVERRIDE — this image is a composition of several elements, and the redraw must keep ALL of its major elements (rules from a street-verified multi-element logo route):
- Draw EVERY major element, each as its own bold closed silhouette, arranged exactly as in the original.
- Elements that stand on the ground in the original share ONE ground line.
- Travel between elements along the composition's natural connector (a hose, cord, strap, leash) exactly where it attaches in the original — if there is none, travel along the shared ground line.
- Keep each element's size within ~2x of its proportion in the original: a tiny element beside a huge one reads as clutter, so grow the small one.
- Keep at most ONE interior identity detail per element (a window, a label patch) as a single closed loop attached to the outline via a retrace; drop all other interior detail.
- The whole composition is still ONE continuous line — reach separated parts via the connector or a retrace along already-drawn ink, never a floating part.
- LINE BUDGET: keep the total drawn line under ~7x the drawing's span (the street-verified full-logo route runs 23 km of line across a 3.6 km canvas). Every extra wiggle and retrace forces the WHOLE drawing to be placed smaller on streets until its elements melt — sparse and huge beats dense and small.
- SPEND THE LINE ON IDENTITY: the identity features listed above are MANDATORY, each drawn HUGE (at least 15% of the span, exaggerated beyond realism). Save ink by simplifying GENERIC outlines, never by dropping or shrinking an identity feature — a lean drawing that loses its identity reads as generic blobs (measured: the owner called it "way more simplistic").
- CONNECTOR IDENTITY: a cord, hose, or leash connector must include ONE full 360-degree loop that visibly crosses itself — a plain curve between elements reads as nothing; the self-crossing loop is what says "cord" (street-verified trick).
- WEARABLE IDENTITY: draw a wearable as an exaggerated part of the body outline itself — a headphone band is the head's own top arc drawn oversized, a hat is the head's silhouette — never as small separate marks; marks below feature scale melt on streets.

Example of the expected level — a two-element composition (machine + figure joined by its connector), ink ratio ~6.5x span, one continuous line. Note the structure, not the subject: the machine is ONE closed rectangle whose interior detail is a single closed loop sharing the machine's edge (retraces along drawn ink are free); the connector leaves the machine's edge and doubles as the figure's raised arm; the figure is a closed outline with a round head and asymmetric legs; nothing is drawn twice except deliberate retraces on straight segments:
{"strokes":[{"elements":[
  {"type":"line","points":[[400,540],[400,780],[160,780],[160,640],[400,640],[400,860],[60,860],[60,60],[400,60],[400,540]]},
  {"type":"bez","p0":[400,540],"c":[540,620],"p1":[610,480]},
  {"type":"bez","p0":[610,480],"c":[650,380],"p1":[720,450]},
  {"type":"line","points":[[720,450],[757,691]]},
  {"type":"arc","cx":805,"cy":748,"r":75,"startDeg":230,"endDeg":-50},
  {"type":"line","points":[[853,691],[880,500],[905,300],[930,60],[820,60],[800,250],[760,60],[650,60],[690,320],[720,450]]}
]}]}`;

export async function interpretSketch(args: {
  apiKey: string;
  imageBase64: string; // raw base64, no data: prefix
  mediaType: Media;
  onProgress?: InterpretProgress;
}): Promise<InterpretResult> {
  const progress = args.onProgress ?? (() => {});
  const empty: InterpretResult = {
    contour: null, subject: null, features: null, guesses: [], hits: 0,
    meanConfidence: 0, resemblance: 0, composite: false, rounds: 0,
    previewPngBase64: null,
  };

  progress("Studying your image…");
  const idText = await vision(args.apiKey, [
    img(args.imageBase64, args.mediaType),
    {
      type: "text",
      text:
        'What does this image depict, and what are its 2-3 most visually distinctive features (the things a silhouette must keep for a stranger to recognize it)? If the image is a scene or logo with SEVERAL elements, pick the ONE element that would be most recognizable as a simple line drawing — living figures and distinctive silhouettes beat boxes, machines, and text. Reply in this exact format:\nSUBJECT: <the simplest common name a stranger would shout on seeing your line drawing — 1-4 words, e.g. "an elephant", "a person wearing headphones">\nFEATURES: <comma-separated, short>\nLAYOUT: <one sentence: the overall composition/pose/arrangement of the original, so a redraw can echo it>\nCOMPOSITE: <yes if the artwork is a composition of TWO OR MORE distinct elements (e.g. a figure AND a machine joined by a hose), otherwise no>',
    },
  ]);
  const idm = idText?.match(/SUBJECT:\s*(.+?)\s*FEATURES:\s*(.+?)(?:\s*LAYOUT:\s*(.+))?$/is);
  if (!idm) {
    return { ...empty, message: "Couldn't read the image — try a clearer upload." };
  }
  const subject = idm[1]!.trim().replace(/\s+/g, " ").slice(0, 80);
  // When the model omits LAYOUT, the lazy FEATURES capture swallows the
  // trailing COMPOSITE line — strip it from BOTH captures.
  const features = idm[2]!
    .replace(/COMPOSITE:[\s\S]*$/i, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);
  const layout = (idm[3] ?? "")
    .replace(/COMPOSITE:[\s\S]*$/i, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 240);
  const composite = /^y/i.test(idText?.match(/COMPOSITE:\s*(\w+)/i)?.[1] ?? "");

  type LadderBest = {
    contour: NormalizedPoint[];
    png: Buffer;
    hits: number;
    meanConfidence: number;
    guesses: string[];
    resemblance: number;
    /** false when the resemblance call failed and 3 is just the default */
    resemblanceMeasured: boolean;
  } | null;

  // Each retry changes STRATEGY, not just wording — identical prompts
  // converge on the same failed drawing.
  const STRATEGY = [
    "",
    "Exaggerate the single most distinctive feature to twice its natural size — make it impossible to miss.",
    "CROP to a close-up: draw only the part of the subject that carries its identity, filling the whole frame (a head with headphones beats a full figure whose headphones are too small to see). Keep every part connected — one line.",
    "Ignore this photo's pose entirely: draw the most ICONIC, canonical view of the subject (the version a road-sign or emoji would use), close-up on its identity.",
  ];
  // Compare-mode strategies keep the composition — cropping or going
  // canonical would defeat "looks like MY artwork".
  const COMPARE_STRATEGY = [
    "",
    "Make every element chunkier and simpler while keeping the arrangement identical to the original — the composition is what must survive.",
    "Exaggerate the connector and the single most distinctive element so the composition reads at a glance.",
    "Cut the total line length by a third: keep at most one interior detail in the whole drawing, straighten every curve that isn't identity-critical, and draw each element as one clean closed outline with no doubled edges.",
  ];

  let roundsUsed = 0;
  // Counts drafts that actually reached judges with at least one verdict.
  // Zero across a whole run means the VISION SERVICE failed (measured July
  // 30: an API 529 "Overloaded" wave nulled every draft call and the run
  // refused with "none passed" — blaming the user's art for our outage).
  let judgedDraftCount = 0;

  const runLadder = async (
    subj: string,
    feats: string,
    lay: string,
    maxRounds: number,
    mode: "blind" | "compare" = "blind",
  ): Promise<LadderBest> => {
    let best: LadderBest = null;
    let feedback = "";
    let lastPng: Buffer | null = null;
    const strategies = mode === "compare" ? COMPARE_STRATEGY : STRATEGY;

    const draftOnce = async (roundNum: number): Promise<Pt2[][] | null> => {
      const content: Parameters<typeof vision>[1] = [img(args.imageBase64, args.mediaType)];
      if (lastPng) content.push(img(lastPng.toString("base64"), "image/png"));
      content.push({
        type: "text",
        text:
          (mode === "compare"
            ? `Redraw the FIRST image as a whole — every major element it contains, arranged as in the original.\nIts most recognizable element: ${subj}\nDistinctive features to preserve: ${feats}` +
              (lay ? `\nComposition: ${lay}` : "") +
              `\n\n${GRAMMAR}${COMPOSITE_GRAMMAR}`
            : `Subject: ${subj}\nDistinctive features to preserve: ${feats}` +
              (lay
                ? `\nOriginal composition to ECHO wherever it doesn't cost recognition (the owner must see THEIR art in the redraw): ${lay}`
                : "") +
              `\n\n${GRAMMAR}`) +
          (strategies[roundNum - 1] ? `\n\nThis attempt's strategy: ${strategies[roundNum - 1]}` : "") +
          (feedback
            ? `\n\nThe second image is your previous attempt as the judges saw it. It failed: ${feedback} Redraw from scratch.`
            : ""),
      });
      const draftText = await vision(args.apiKey, content, 4096);
      const dumpFail = async (reason: string) => {
        if (!process.env.INTERPRET_DEBUG_DIR) return;
        const { writeFile } = await import("node:fs/promises");
        void writeFile(
          `${process.env.INTERPRET_DEBUG_DIR}/draftfail-${Date.now()}-${reason}.txt`,
          `${reason}\n---\n${draftText ?? "(null draftText)"}`,
        ).catch(() => {});
      };
      if (!draftText) {
        await dumpFail("no-text");
        return null;
      }
      const jsonText = draftText.slice(draftText.indexOf("{"), draftText.lastIndexOf("}") + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        await dumpFail("json-parse");
        return null;
      }
      const program = parsePrimitiveProgram(parsed);
      if (!program) return null;
      let strokes = compilePrimitiveProgram(program);
      if (!strokes.length) return null;
      // Product rule (Ralph, July 27): NO pen lifts — one run, one line. Any
      // extra strokes are joined head-to-tail so the connector ink is real,
      // visible, and judged exactly as it will be run.
      if (strokes.length > 1) strokes = [strokes.flat()];
      return strokes;
    };

    for (let round = 1; round <= maxRounds; round++) {
      roundsUsed++;
      progress(
        mode === "compare"
          ? `Drawing your whole artwork — attempt ${round} of ${maxRounds}…`
          : `Drawing ${subj} — attempt ${round} of ${maxRounds}…`,
      );
      // Best-of-two, both judged: draw two candidates in parallel and blind-
      // judge BOTH street-simulated renders. A cheap selector used to pick
      // one candidate for judging, but it measurably picked wrong (July 28,
      // gas logo: the losing sibling of a failed round was the drawing that
      // passed on a later run) — judged shots are what buy reliability.
      const drafts = (await Promise.all([draftOnce(round), draftOnce(round)])).filter(
        (d): d is Pt2[][] => d !== null,
      );
      if (!drafts.length) {
        feedback = "the drawing program was invalid.";
        continue;
      }
      progress(
        mode === "compare"
          ? `Comparing attempt ${round} to your original (street-simulated)…`
          : `Blind-testing attempt ${round} on three judges (street-simulated)…`,
      );
      const judged = await Promise.all(
        drafts.map(async (strokes, di) => {
          const png = await renderStrokesPng(strokes);
          // Judge the STREET-SIMULATED version: snapped to a Manhattan-pitch
          // lattice, the same quantization real placement applies. Clean
          // renders measurably pass drafts whose thin features then melt on
          // streets (paper-9 coffee mug -> streets 3/10); lattice renders
          // predict streets. The lattice is rendered at the canvas size the
          // draft's own ink density forces at placement (simExtentM) — a
          // fixed canvas measurably passed ink-dense drafts that then shrank
          // below feature scale on real streets.
          const snappedPng = await renderStrokesPng(snapStrokesToLattice(strokes, simExtentM(strokes)));
          if (process.env.INTERPRET_DEBUG_DIR) {
            const { writeFile } = await import("node:fs/promises");
            const tag = `${subj.replace(/\W+/g, "-").slice(0, 40)}-r${round}${di ? "b" : "a"}`;
            void writeFile(`${process.env.INTERPRET_DEBUG_DIR}/draft-${tag}.png`, snappedPng).catch(() => {});
          }
          let verdicts: { guess: string; confidence: number }[];
          let hits: number;
          if (mode === "compare") {
            const scores = (
              await Promise.all(
                [1, 2, 3].map(() => compareJudge(args.apiKey, args.imageBase64, args.mediaType, snappedPng)),
              )
            ).filter((v): v is { score: number; why: string } => v !== null);
            verdicts = scores.map((s) => ({ guess: `likeness ${s.score}/10 — ${s.why}`, confidence: s.score }));
            hits = scores.filter((s) => s.score >= COMPARE_PASS_SCORE).length;
          } else {
            verdicts = (
              await Promise.all([1, 2, 3].map(() => blindJudge(args.apiKey, snappedPng)))
            ).filter((v): v is { guess: string; confidence: number } => v !== null);
            hits = verdicts.filter((v) => guessMatchesSubject(subj, v.guess)).length;
          }
          const meanConfidence = verdicts.length
            ? verdicts.reduce((a, v) => a + v.confidence, 0) / verdicts.length
            : 0;
          if (verdicts.length) judgedDraftCount++;
          return {
            strokes,
            png,
            snappedPng,
            verdicts,
            hits,
            meanConfidence,
            extentM: simExtentM(strokes),
            inkRatio: strokesInkRatio(strokes),
          };
        }),
      );
      // Tiebreak = budget-constrained RICHNESS (Ralph, July 29 live verdict:
      // pure leaner-wins selected the most simplistic sibling every time and
      // the output "looks way more simplistic" than the accepted demo). A
      // draft must be lean enough to place at >= 2400 m; among those, the
      // RICHER drawing (more ink = more identity detail) wins ties.
      const budgetOk = (d: { extentM: number }) => (d.extentM >= 2400 ? 1 : 0);
      judged.sort(
        (x, y) =>
          y.hits - x.hits ||
          y.meanConfidence - x.meanConfidence ||
          budgetOk(y) - budgetOk(x) ||
          // within budget: richer wins; both over budget: leaner (closer to
          // feasible) wins
          (budgetOk(x) ? y.inkRatio - x.inkRatio : x.inkRatio - y.inkRatio),
      );
      const top = judged[0]!;
      const { strokes, png, verdicts, hits, meanConfidence } = top;
      lastPng = top.snappedPng;
      const guesses = verdicts.map((v) => `${v.guess} (${v.confidence})`);

      // Recognition alone is not the product — a passing draft that abandons
      // the user's composition is "recognizable but not YOUR logo". Score
      // resemblance to the original and prefer it among passing drafts.
      // In compare mode the judges ALREADY scored likeness to the original.
      let resemblance = 0;
      let resemblanceMeasured = mode === "compare"; // compare scores ARE the measure
      if (mode === "compare") {
        resemblance = Number(meanConfidence.toFixed(1));
      } else if (hits >= 2) {
        const askResemblance = () =>
          vision(args.apiKey, [
            img(args.imageBase64, args.mediaType),
            img(png.toString("base64"), "image/png"),
            {
              type: "text",
              text:
                "The second image is a bold one-line redraw of the first. How recognizable is it as a simplified version of the first image — same composition, same identity? Reply in this exact format:\nSCORE: <1-10>\nWHY: <short phrase>",
            },
          ]);
        let rm = (await askResemblance())?.match(/SCORE:\s*(\d+)/i);
        if (!rm) rm = (await askResemblance())?.match(/SCORE:\s*(\d+)/i);
        if (rm) {
          resemblance = Number(rm[1]);
          resemblanceMeasured = true;
        } else {
          // Unmeasurable (service failure after retries): 3 keeps feedback
          // from chasing a phantom "doesn't look like the original", but it
          // is NOT acceptance-grade — a degraded-API run measurably shipped
          // a "musical note" rescue for the gas logo through this default
          // (July 30). Only a MEASURED resemblance can pass the floor.
          resemblance = 3;
        }
      }

      // A draft that would be ACCEPTED downstream (hits >= 2 and above the
      // fallback resemblance floor) must never be evicted from `best` by a
      // higher-hits draft that would be REFUSED (e.g. a "musical note"
      // rescue at hits 3, resemblance 2 displacing a hits-2/res-4 keeper).
      const acceptable = (b: { hits: number; resemblance: number; resemblanceMeasured: boolean }) =>
        b.hits >= 2 && b.resemblance >= 3 && b.resemblanceMeasured;
      const cand = { hits, resemblance, resemblanceMeasured };
      if (
        !best ||
        (acceptable(cand) && !acceptable(best)) ||
        (acceptable(cand) === acceptable(best) &&
          (hits > best.hits ||
            (hits === best.hits && resemblance > best.resemblance) ||
            (hits === best.hits &&
              resemblance === best.resemblance &&
              meanConfidence > best.meanConfidence)))
      ) {
        best = {
          contour: strokesToContour(strokes),
          png,
          hits,
          meanConfidence: Number(meanConfidence.toFixed(1)),
          guesses,
          resemblance,
          resemblanceMeasured,
        };
      }
      // A dense drawing shrinks at placement until features melt — give the
      // drafter its measured number, or it just re-draws the same design.
      // Strict < so the 2400 boundary agrees with budgetOk (>= 2400 is OK).
      const inkNote =
        top.extentM < 2400
          ? ` The drawing also uses too much total line: ${top.inkRatio.toFixed(1)}x its span, vs a budget of ~6.5x (the street-verified reference is ~5x). At a runnable distance it must shrink to about ${top.extentM} m across, melting every detail. Redraw with LESS total line — one clean closed outline per element, no doubled edges, at most one interior detail — so it can be placed larger.`
          : "";
      // An all-judges-failed round is a service outage, not a verdict —
      // garbage like `scored likeness /10 ()` must not steer the next draft.
      if (!verdicts.length) {
        feedback = "the judging service was unavailable for that attempt — draw a fresh, bolder variant.";
        continue;
      }
      // Don't settle: strong recognition AND real resemblance, or keep drawing.
      if (mode === "compare") {
        if (hits === 3 && verdicts.length === 3 && meanConfidence >= 7) break;
        feedback =
          `judges comparing it to the ORIGINAL scored likeness ${verdicts
            .map((v) => v.confidence)
            .join(", ")}/10 (${verdicts.map((v) => v.guess).join("; ")}) — keep EVERY element and the original arrangement, and make each element bolder.` +
          inkNote;
        continue;
      }
      if (hits === 3 && verdicts.length === 3 && meanConfidence >= 7 && resemblance >= 6) break;
      feedback =
        (hits >= 2 && resemblance < 6
          ? `judges recognized ${subj}, but it doesn't look like the ORIGINAL (resemblance ${resemblance}/10) — keep the same subject and echo the original's composition${lay ? `: ${lay}` : ""}.`
          : hits === 3
            ? `all judges said ${subj}, but only at confidence ${meanConfidence.toFixed(0)}/10 — make it bolder and more unmistakable.`
            : `blind judges saw "${verdicts.map((v) => v.guess).join('", "')}" instead of ${subj}.`) + inkNote;
    }
    return best;
  };

  let best: LadderBest = null;
  let usedSubject = subject;
  let usedFeatures = features;

  // Composite/logo path (Ralph, July 29): a blind stranger can never NAME a
  // multi-element brand mark ("person + pump + hose"), but its owner
  // recognizes a faithful redraw instantly — and a hand-designed full-logo
  // route already proved multi-element compositions draw as one runnable
  // line. So for compositions, attempt the WHOLE artwork first, gated on
  // likeness-to-upload (comparative judges) instead of blind naming. If it
  // fails, fall through to the single-subject blind-naming ladders.
  let acceptedComposite = false;
  if (composite) {
    const compBest = await runLadder(subject, features, layout, MAX_ROUNDS, "compare");
    if (compBest && compBest.hits >= 2) {
      best = compBest;
      acceptedComposite = true;
    } else if (compBest) {
      // Keep the failing attempt so a refusal can report the likeness
      // verdicts honestly; hits < 2 can never be accepted below.
      best = compBest;
    }
  } else {
    best = await runLadder(subject, features, layout, MAX_ROUNDS);
  }
  // NO blind-naming ladder on a composite phrase: measured July 29, a judge
  // guessing "headphones" token-matched the subject "a person wearing
  // headphones", the mislabeled pass carried composite:false, and placement
  // primed-judged the full logo back to 3/10 (Ralph hit this live). For
  // composite art the only ladders are compare (above) and the
  // fallback-object rescue (below).

  // Fallback ladder (July 28, learned from Ralph's gas logo): composite
  // subjects like "a person wearing headphones" draw as unrecognizable
  // figures (judges saw a giraffe), while the iconic OBJECT inside them
  // (headphones alone) has a road-sign silhouette. When every draft of the
  // primary subject fails, re-ask for the most drawable object and try it.
  if (!best || best.hits < 2) {
    const fbText = await vision(args.apiKey, [
      img(args.imageBase64, args.mediaType),
      {
        type: "text",
        text:
          `A bold one-line drawing of "${subject}" was NOT recognizable to blind judges. Name the TWO most iconic, simply-drawable OBJECTS visible in this image instead — objects whose silhouette alone a stranger names instantly, the way road-sign and emoji icons work (e.g. headphones, an umbrella, a musical note). NOT a person or full figure, NOT text or letters, and NEVER a box-shaped object (rectangles quantize to nothing on city streets — prefer curved, distinctive silhouettes). Most iconic first. Reply in this exact format:\nSUBJECT: <1-3 words, e.g. "headphones">\nFEATURES: <2-3 comma-separated silhouette features it must keep>\nALT: <1-3 words, a different object>\nALTFEATURES: <2-3 comma-separated silhouette features>`,
      },
    ]);
    const FB_RE = /SUBJECT:\s*(.+?)\s*FEATURES:\s*(.+?)(?:\s*ALT:\s*(.+?)\s*ALTFEATURES:\s*(.+))?$/is;
    let fbm = fbText?.match(FB_RE);
    if (!fbm) {
      // The rescue path must not die on one malformed reply — a live run
      // (July 30) skipped the whole fallback ladder because this single
      // call failed, refusing without ever trying the iconic objects.
      const retryText = await vision(args.apiKey, [
        img(args.imageBase64, args.mediaType),
        {
          type: "text",
          text:
            'Name the TWO most iconic, simply-drawable OBJECTS visible in this image — objects whose silhouette alone a stranger names instantly. NOT a person, NOT text, NEVER box-shaped. Reply in this exact format:\nSUBJECT: <1-3 words>\nFEATURES: <2-3 comma-separated silhouette features>\nALT: <1-3 words>\nALTFEATURES: <2-3 comma-separated features>',
        },
      ]);
      fbm = retryText?.match(FB_RE);
    }
    const clean = (v: string | undefined, max: number) =>
      v?.trim().replace(/\s+/g, " ").slice(0, max) ?? "";
    const candidates = [
      { subj: clean(fbm?.[1], 80), feats: clean(fbm?.[2], 200) },
      { subj: clean(fbm?.[3], 80), feats: clean(fbm?.[4], 200) },
    ].filter((c) => c.subj && c.subj.toLowerCase() !== subject.toLowerCase());
    for (const [ci, c] of candidates.entries()) {
      progress(`"${subject}" didn't survive as a one-line drawing — trying the ${c.subj} from your image instead…`);
      const fbBest = await runLadder(c.subj, c.feats, "", ci === 0 ? 3 : 2);
      // Resemblance floor (measured July 29): a "musical note" rescue from a
      // gas-station logo passed blind judges at 9,9,9 with resemblance 2 —
      // recognizable, but not the user's art. Element rescues that are
      // genuinely part of the artwork measure resemblance 3-4; below 3 the
      // rescue is a different drawing and an honest refusal serves better.
      if (fbBest && fbBest.hits >= 2 && fbBest.resemblanceMeasured && fbBest.resemblance >= 3) {
        best = fbBest;
        usedSubject = c.subj;
        usedFeatures = c.feats;
        break;
      }
      // Keep failed attempts only for the refusal message — never let a
      // floor-rejected rescue (hits >= 2, resemblance < 3) into `best`, or
      // the final hits-only acceptance check would ship it mislabeled.
      if (fbBest && fbBest.hits < 2 && (!best || fbBest.hits > best.hits)) best = fbBest;
    }
  }

  if (!best || best.hits < 2) {
    // Total judging blackout = OUR outage, not the user's art. Refusing
    // with "none passed" during an API 529 wave blames the artwork for a
    // service failure (happened live, July 30).
    if (judgedDraftCount === 0) {
      return {
        ...empty,
        subject,
        features,
        rounds: roundsUsed,
        message:
          "Our drawing service is overloaded right now — this isn't about your art. Please try again in a few minutes.",
      };
    }
    return {
      ...empty,
      subject,
      features,
      rounds: roundsUsed,
      guesses: best?.guesses ?? [],
      hits: best?.hits ?? 0,
      meanConfidence: best?.meanConfidence ?? 0,
      resemblance: best?.resemblance ?? 0,
      message: composite
        ? `We tried ${roundsUsed} redraws of your artwork, but none passed — the whole composition never looked enough like your original, and no single element from it was reliably recognized on its own${best?.guesses.length ? ` (closest attempt: ${best.guesses.join(", ")})` : ""}. A simpler or higher-contrast reference image may work better.`
        : `We tried ${roundsUsed} redraws of "${subject}"${usedSubject !== subject ? ` (and its ${usedSubject})` : ""}, but blind judges never reliably recognized any of them${best?.guesses.length ? ` (best attempt was seen as: ${best.guesses.join(", ")})` : ""}. This subject may need a simpler reference image.`,
    };
  }

  return {
    contour: best.contour,
    subject: usedSubject,
    features: usedFeatures,
    guesses: best.guesses,
    hits: best.hits,
    meanConfidence: best.meanConfidence,
    resemblance: best.resemblance,
    composite: acceptedComposite,
    rounds: roundsUsed,
    previewPngBase64: best.png.toString("base64"),
  };
}
