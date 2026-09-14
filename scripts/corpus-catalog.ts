/**
 * corpus-catalog.ts — catalogue HOW GPS artists draw, one piece at a time.
 *
 * For each corpus image a vision model returns structured JSON: the subject,
 * whether a stranger would name it, whether the line really follows streets,
 * and a feature list saying how each identifying feature was drawn (small
 * loop for an eye, out-and-back spur for a mouth, park path for a curve,
 * doubled street for a thick line, shared avenue as a connector, ...).
 *
 * THIS SPENDS MONEY ON RALPH'S ANTHROPIC ACCOUNT. Default is a dry run that
 * only counts tokens (count_tokens is free) and prints the cost. Real calls
 * need BOTH --run and --approved-by-ralph. Runs go through the Batches API
 * (half price) and never retry in a loop.
 *
 *   npx tsx scripts/corpus-catalog.ts --sample=100            # estimate only
 *   npx tsx scripts/corpus-catalog.ts --sample=100 --run --approved-by-ralph
 *   npx tsx scripts/corpus-catalog.ts --collect=<batch_id>    # fetch results, no new spend
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const DIR = args.dir ?? "tmp-corpus/stravart";
const MODEL = args.model ?? "claude-opus-5";
const SAMPLE = args.sample ? Number(args.sample) : Infinity;
const OUT = path.join(DIR, "catalog");
/** Assumed output tokens per piece (JSON + adaptive thinking at low effort). Checked against the pilot. */
const EST_OUTPUT = Number(args["est-output"] ?? 900);

const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-fable-5-1": { in: 10, out: 50 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

const MOVES = [
  "outline",
  "small_loop",
  "out_and_back_spur",
  "doubled_line",
  "zigzag_or_serpentine",
  "park_or_trail_curve",
  "diagonal_street",
  "grid_staircase",
  "shoreline_or_river_edge",
  "bridge_or_causeway",
  "shared_connector",
  "separate_stroke_with_gap",
  "text_or_number",
  "other",
];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "subject",
    "stranger_would_name_it",
    "follows_streets",
    "setting",
    "features",
    "omitted_or_simplified",
    "connector_strategy",
    "why_it_reads",
  ],
  properties: {
    subject: { type: "string", description: "What the drawing shows, a few words." },
    stranger_would_name_it: {
      type: "integer",
      description: "1-10: would a stranger with no caption name the subject from the line alone.",
    },
    follows_streets: {
      type: "string",
      enum: ["yes", "mostly", "no", "not_a_map"],
      description: "Does the line stay on visible roads/paths, or cut straight across blocks?",
    },
    setting: {
      type: "string",
      enum: ["regular_grid", "irregular_streets", "parks_trails", "rural_roads", "mixed", "unknown"],
    },
    features: {
      type: "array",
      description: "Each identifying part of the subject and how it was drawn on the map.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["feature", "move", "how"],
        properties: {
          feature: { type: "string", description: "e.g. eye, ear, tail, horn, window, hose, letter A" },
          move: { type: "string", enum: MOVES },
          how: { type: "string", description: "One sentence: the concrete street trick used." },
        },
      },
    },
    omitted_or_simplified: {
      type: "string",
      description: "What a literal tracing would include that the artist dropped or simplified.",
    },
    connector_strategy: {
      type: "string",
      description: "How separate parts were joined into one run: reused street, hidden inside outline, visible gap, etc.",
    },
    why_it_reads: {
      type: "string",
      description: "One or two sentences: the single most important reason the subject is recognizable (or not).",
    },
  },
};

const PROMPT = `This is a piece of GPS art: a runner or cyclist recorded a route whose line draws a picture on the map.
The gallery filed it under "{category}". Study the line, not the caption.
Describe how the artist made it recognizable using real streets: which features carry the identity, which street trick draws each one, what they left out, and how the parts connect into one route.
Be concrete and short. Judge honestly: if the line cuts straight across blocks, say so; if it does not read, say so.`;

type Piece = { file: string; category: string; subject_hint: string };

function loadPieces(): Piece[] {
  const all = fs
    .readFileSync(path.join(DIR, "pieces.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Piece);
  if (!Number.isFinite(SAMPLE)) return all;
  // Stratified: round-robin across categories so a small pilot covers everything.
  const byCat = new Map<string, Piece[]>();
  for (const p of all) byCat.set(p.category, [...(byCat.get(p.category) ?? []), p]);
  const lists = [...byCat.values()].map((l) => l.filter((_, i) => i % 7 === 3));
  const out: Piece[] = [];
  for (let round = 0; out.length < SAMPLE; round++) {
    let added = false;
    for (const l of lists) {
      if (l[round] && out.length < SAMPLE) {
        out.push(l[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}

async function imageBlock(file: string): Promise<Anthropic.ImageBlockParam> {
  const png = await sharp(path.join(DIR, "images", file)).resize({ width: 1000, withoutEnlargement: true }).png().toBuffer();
  return { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
}

async function params(p: Piece): Promise<Anthropic.MessageCreateParamsNonStreaming> {
  return {
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: [await imageBlock(p.file), { type: "text", text: PROMPT.replace("{category}", p.category) }],
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming;
}

async function collect(client: Anthropic, batchId: string) {
  const batch = await client.messages.batches.retrieve(batchId);
  console.log(`status ${batch.processing_status}`, batch.request_counts);
  if (batch.processing_status !== "ended") return;
  const rows: string[] = [];
  let inTok = 0;
  let outTok = 0;
  for await (const r of await client.messages.batches.results(batchId)) {
    if (r.result.type !== "succeeded") {
      rows.push(JSON.stringify({ file: r.custom_id, error: r.result.type }));
      continue;
    }
    const msg = r.result.message;
    inTok += msg.usage.input_tokens;
    outTok += msg.usage.output_tokens;
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    try {
      rows.push(JSON.stringify({ file: r.custom_id, stop: msg.stop_reason, ...JSON.parse(text) }));
    } catch {
      rows.push(JSON.stringify({ file: r.custom_id, stop: msg.stop_reason, unparsed: text.slice(0, 500) }));
    }
  }
  const price = PRICES[MODEL] ?? PRICES["claude-opus-5"];
  const dollars = ((inTok * price.in + outTok * price.out) / 1e6) * 0.5;
  fs.writeFileSync(path.join(OUT, `${batchId}.jsonl`), rows.join("\n") + "\n");
  console.log(JSON.stringify({ results: rows.length, input_tokens: inTok, output_tokens: outTok, actual_cost_usd: +dollars.toFixed(2) }));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const client = new Anthropic();
  if (args.collect) return collect(client, args.collect);

  const pieces = loadPieces();
  const price = PRICES[MODEL];
  if (!price) throw new Error(`no price for ${MODEL}`);

  // count_tokens is free: measure real input size on a few pieces.
  const probe = pieces.filter((_, i) => i % Math.max(1, Math.floor(pieces.length / 5)) === 0).slice(0, 5);
  let probeTok = 0;
  for (const p of probe) {
    const { model, messages, output_config } = await params(p);
    const c = await client.messages.countTokens({ model, messages, output_config } as Anthropic.MessageCountTokensParams);
    probeTok += c.input_tokens;
  }
  const inPer = Math.round(probeTok / probe.length);
  const standard = (pieces.length * (inPer * price.in + EST_OUTPUT * price.out)) / 1e6;
  console.log(
    JSON.stringify(
      {
        model: MODEL,
        pieces: pieces.length,
        input_tokens_per_piece_measured: inPer,
        output_tokens_per_piece_assumed: EST_OUTPUT,
        estimated_cost_usd_batch: +(standard * 0.5).toFixed(2),
        estimated_cost_usd_standard: +standard.toFixed(2),
      },
      null,
      2,
    ),
  );

  if (!(args.run && args["approved-by-ralph"])) {
    console.log("DRY RUN. No paid calls made. Needs --run --approved-by-ralph.");
    return;
  }

  const requests = [];
  for (const p of pieces) requests.push({ custom_id: p.file.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64), params: await params(p) });
  const batch = await client.messages.batches.create({ requests });
  fs.writeFileSync(
    path.join(OUT, `${batch.id}.request.json`),
    JSON.stringify({ batch_id: batch.id, model: MODEL, files: pieces.map((p) => p.file), created: new Date().toISOString() }, null, 2),
  );
  console.log(`batch ${batch.id} submitted (${requests.length} requests). Collect with --collect=${batch.id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
