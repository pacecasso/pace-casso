/**
 * corpus-movebook.ts — turn the per-piece catalogue into a move book.
 * ZERO model calls: reads the collected batch results and aggregates.
 *
 * Keeps only pieces that are runnable (follows_streets yes/mostly) and read
 * well without a caption (stranger_would_name_it >= --min, default 7), then
 * for each normalised feature (eye, ear, tail, leg, letter, ...) counts which
 * street move drew it and keeps example pieces + the artist's concrete trick.
 * Also compares strong pieces with weak ones: which moves separate them.
 *
 *   npx tsx scripts/corpus-movebook.ts [--dir=tmp-corpus/stravart] [--min=7]
 * Output: <dir>/movebook.json, <dir>/movebook.md
 */
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const DIR = args.dir ?? "tmp-corpus/stravart";
const MIN = Number(args.min ?? 7);
const CAT_DIR = path.join(DIR, "catalog");

type Feature = { feature: string; move: string; how: string };
type Entry = {
  file: string;
  subject?: string;
  stranger_would_name_it?: number;
  follows_streets?: string;
  setting?: string;
  features?: Feature[];
  omitted_or_simplified?: string;
  connector_strategy?: string;
  why_it_reads?: string;
};

/** Map free-text feature names onto a small shared vocabulary. */
const FEATURE_KEYS: [string, RegExp][] = [
  ["eye", /\beyes?\b|pupil/],
  ["ear", /\bears?\b/],
  ["nose/snout/beak", /nose|snout|muzzle|beak|bill\b|trunk/],
  ["mouth/jaw", /mouth|jaw|smile|teeth|tongue/],
  ["head", /\bhead\b|face|skull/],
  ["horn/antler/antenna", /horn|antler|antenna|tusk|crest|spike/],
  ["neck", /neck/],
  ["tail", /tail/],
  ["leg/foot/paw", /\blegs?\b|foot|feet|paw|hoof|limb|claw|flipper/],
  ["arm/hand", /\barms?\b|hand|finger/],
  ["wing/fin", /wing|fin\b|fins\b/],
  ["body/outline", /body|torso|outline|silhouette|shell|belly|back\b|rump|hull/],
  ["hair/mane/fur", /hair|mane|fur|whisker|beard/],
  ["letter/number", /letter|number|digit|word|text|\b[a-z]\b/],
  ["stem/stick/pole", /stem|stick|pole|trunk of|mast|handle|stalk|barrel/],
  ["wheel/circle", /wheel|circle|ring|ball/],
  ["window/door/hole", /window|door|hole|opening/],
  ["detail lines", /stripe|seam|line|pattern|scute|spoke|stitch|segment/],
];

function featureKey(name: string): string {
  const n = name.toLowerCase();
  for (const [key, re] of FEATURE_KEYS) if (re.test(n)) return key;
  return "other";
}

function load(): Entry[] {
  const seen = new Map<string, Entry>();
  // Newest batch wins, so the re-run pilot (better prompt) replaces the first pilot.
  const files = fs
    .readdirSync(CAT_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, t: fs.statSync(path.join(CAT_DIR, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t);
  for (const { f } of files) {
    for (const line of fs.readFileSync(path.join(CAT_DIR, f), "utf8").trim().split("\n")) {
      const e = JSON.parse(line) as Entry;
      if (e.features) seen.set(e.file, e);
    }
  }
  return [...seen.values()];
}

function main() {
  const all = load();
  const runnable = all.filter((e) => e.follows_streets === "yes" || e.follows_streets === "mostly");
  const strong = runnable.filter((e) => (e.stranger_would_name_it ?? 0) >= MIN);
  const weak = runnable.filter((e) => (e.stranger_would_name_it ?? 0) <= 4);

  const moveShare = (set: Entry[]) => {
    const m: Record<string, number> = {};
    let n = 0;
    for (const e of set) for (const f of e.features ?? []) (m[f.move] = (m[f.move] ?? 0) + 1), n++;
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, +(v / Math.max(1, n)).toFixed(3)]));
  };
  const avg = (set: Entry[], fn: (e: Entry) => number) => +(set.reduce((a, e) => a + fn(e), 0) / Math.max(1, set.length)).toFixed(2);

  const book: Record<string, { count: number; moves: Record<string, number>; examples: { file: string; subject: string; move: string; how: string }[] }> = {};
  for (const e of strong) {
    for (const f of e.features ?? []) {
      const key = featureKey(f.feature);
      const b = (book[key] ??= { count: 0, moves: {}, examples: [] });
      b.count++;
      b.moves[f.move] = (b.moves[f.move] ?? 0) + 1;
      if (b.examples.length < 12) b.examples.push({ file: e.file, subject: e.subject ?? "", move: f.move, how: f.how });
    }
  }

  const summary = {
    catalogued: all.length,
    runnable: runnable.length,
    not_runnable: all.length - runnable.length,
    strong_pieces: strong.length,
    weak_pieces: weak.length,
    features_per_piece: { strong: avg(strong, (e) => e.features?.length ?? 0), weak: avg(weak, (e) => e.features?.length ?? 0) },
    move_share: { strong: moveShare(strong), weak: moveShare(weak) },
    setting_strong: strong.reduce<Record<string, number>>((a, e) => ((a[e.setting ?? "?"] = (a[e.setting ?? "?"] ?? 0) + 1), a), {}),
    model_calls: 0,
  };
  fs.writeFileSync(path.join(DIR, "movebook.json"), JSON.stringify({ summary, book }, null, 2));

  const md: string[] = [
    `# GPS art move book`,
    ``,
    `${all.length} pieces catalogued; ${runnable.length} follow streets; ${strong.length} runnable pieces a stranger would name (>= ${MIN}/10).`,
    ``,
    `Features per piece: strong ${summary.features_per_piece.strong}, weak ${summary.features_per_piece.weak}.`,
    ``,
    `## Moves: strong vs weak pieces (share of all features)`,
    ``,
    `| move | strong | weak |`,
    `|---|---|---|`,
    ...[...new Set([...Object.keys(summary.move_share.strong), ...Object.keys(summary.move_share.weak)])]
      .sort((a, b) => (summary.move_share.strong[b] ?? 0) - (summary.move_share.strong[a] ?? 0))
      .map((m) => `| ${m} | ${summary.move_share.strong[m] ?? 0} | ${summary.move_share.weak[m] ?? 0} |`),
    ``,
  ];
  for (const [key, b] of Object.entries(book).sort((a, c) => c[1].count - a[1].count)) {
    const moves = Object.entries(b.moves)
      .sort((a, c) => c[1] - a[1])
      .map(([m, v]) => `${m} ${Math.round((100 * v) / b.count)}%`)
      .join(", ");
    md.push(`## ${key} (${b.count} in strong pieces)`, ``, moves, ``);
    for (const x of b.examples.slice(0, 6)) md.push(`- **${x.subject}** (${x.file}, ${x.move}): ${x.how}`);
    md.push(``);
  }
  fs.writeFileSync(path.join(DIR, "movebook.md"), md.join("\n"));
  console.log(JSON.stringify(summary, null, 2));
}

main();
