/**
 * corpus-sheet.ts — contact sheet of catalogued pieces for Ralph's eye.
 * ZERO model calls. Picks runnable picture pieces (not words/hearts/shapes/
 * geography) at a rating band and tiles them with their subject.
 *
 *   npx tsx scripts/corpus-sheet.ts --min=8 --max=10 --n=24 --out=tmp-corpus/sheet-strong.jpg
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"]; }));
const DIR = "tmp-corpus/stravart";
const MIN = Number(args.min ?? 8), MAX = Number(args.max ?? 10), N = Number(args.n ?? 24);
const OUT = args.out ?? "tmp-corpus/sheet.jpg";
type R = { file: string; subject: string; stranger_would_name_it: number; follows_streets: string; features?: unknown[] };

const catDir = path.join(DIR, "catalog");
const byFile = new Map<string, R>();
for (const f of fs.readdirSync(catDir).filter((x) => x.endsWith(".jsonl")).sort((a, b) => fs.statSync(path.join(catDir, a)).mtimeMs - fs.statSync(path.join(catDir, b)).mtimeMs))
  for (const l of fs.readFileSync(path.join(catDir, f), "utf8").trim().split("\n")) { const r = JSON.parse(l) as R; if (r.features) byFile.set(r.file, r); }
const pool = [...byFile.values()].filter((r) => (r.follows_streets === "yes" || r.follows_streets === "mostly") && !/^(words|hearts|shapes|geography)/.test(r.file) && r.stranger_would_name_it >= MIN && r.stranger_would_name_it <= MAX);
const step = Math.max(1, Math.floor(pool.length / N));
const picks = pool.filter((_, i) => i % step === 0).slice(0, N);

async function main() {
const TW = 400, TH = 300, CAP = 36, COLS = 4;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const tiles = await Promise.all(picks.map(async (r, i) => {
  const img = r.file.replace(/_(jpg|png|webp|gif)$/, ".$1");
  const pic = await sharp(path.join(DIR, "images", img)).resize(TW, TH, { fit: "cover" }).toBuffer();
  const cap = Buffer.from(`<svg width="${TW}" height="${CAP}"><rect width="100%" height="100%" fill="#111"/><text x="8" y="24" font-family="Arial" font-size="17" fill="#fff">${i + 1}. ${esc(r.subject.slice(0, 38))}</text></svg>`);
  return { input: await sharp({ create: { width: TW, height: TH + CAP, channels: 3, background: "#111" } }).composite([{ input: pic, top: 0, left: 0 }, { input: cap, top: TH, left: 0 }]).png().toBuffer(), left: (i % COLS) * TW, top: Math.floor(i / COLS) * (TH + CAP) };
}));
const rows = Math.ceil(picks.length / COLS);
await sharp({ create: { width: COLS * TW, height: rows * (TH + CAP), channels: 3, background: "#111" } }).composite(tiles).jpeg({ quality: 82 }).toFile(OUT);
console.log(JSON.stringify({ pool: pool.length, shown: picks.length, out: OUT, files: picks.map((p) => p.file) }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
