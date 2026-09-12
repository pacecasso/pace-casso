/**
 * FRESH BATCH — the test of the product definition: a stranger uploads an
 * image nobody prepared, presses one button, gets a route. Nothing here is
 * chosen by a person: images are seeded-random picks from two public
 * catalogues (Simple Icons brand marks, Twemoji emoji), extraction is
 * automatic (--mask=auto), no cropping, seat sweep over Manhattan, and the
 * only judge afterwards is a human looking at the contact sheet.
 * Zero model calls.
 *
 * Usage: npx tsx scripts/fresh-batch.ts [--n=20] [--seed=7] [--par=4] [--out=tmp-fresh]
 *        [--stage=fetch|run|sheet|all]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { sharp } from "./finisher-shared";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(opt("n", "20"));
const SEED = Number(opt("seed", "7"));
const PAR = Number(opt("par", "4"));
const OUT = opt("out", "tmp-fresh");
const STAGE = opt("stage", "all");

let seed = SEED;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T,>(arr: T[], k: number): T[] => {
  const a = arr.slice();
  const out: T[] = [];
  while (out.length < k && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]!);
  return out;
};

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { "User-Agent": "pace-casso fresh batch (dev)" } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}
async function svgToPng(svgUrl: string, file: string): Promise<boolean> {
  const r = await fetch(svgUrl, { headers: { "User-Agent": "pace-casso fresh batch (dev)" } });
  if (!r.ok) return false;
  const svg = Buffer.from(await r.arrayBuffer());
  try {
    await sharp(svg, { density: 400 }).resize(512, 512, { fit: "contain", background: "#fff" }).flatten({ background: "#fff" }).png().toFile(file);
    return true;
  } catch {
    return false;
  }
}

type Item = { name: string; kind: "brand" | "emoji"; file: string; label: string };

async function stageFetch(): Promise<Item[]> {
  await fs.mkdir(OUT, { recursive: true });
  const half = Math.ceil(N / 2);
  const items: Item[] = [];
  // brand marks: every slug in the Simple Icons catalogue, seeded-random pick
  const icons = await fetchJson<{ icons: { title: string; slug?: string }[] }>("https://cdn.jsdelivr.net/npm/simple-icons@13/_data/simple-icons.json");
  const slugOf = (t: string) => t.toLowerCase().replace(/\+/g, "plus").replace(/\./g, "dot").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  const brandPool = icons.icons.map((i) => ({ title: i.title, slug: i.slug ?? slugOf(i.title) }));
  for (const b of pick(brandPool, half * 3)) {
    if (items.filter((i) => i.kind === "brand").length >= half) break;
    const file = path.join(OUT, `brand-${b.slug}.png`);
    if (await svgToPng(`https://cdn.jsdelivr.net/npm/simple-icons@13/icons/${b.slug}.svg`, file)) items.push({ name: `brand-${b.slug}`, kind: "brand", file, label: b.title });
  }
  // emoji: every single-codepoint Twemoji asset, seeded-random pick (flags and skin tones are sequences, so they are out by construction)
  const tw = await fetchJson<{ files: { name: string }[] }>("https://data.jsdelivr.com/v1/package/gh/twitter/twemoji@14.0.2/flat");
  const emojiPool = tw.files.map((f) => f.name).filter((n) => /^\/assets\/svg\/[0-9a-f]{4,5}\.svg$/.test(n)).map((n) => n.slice("/assets/svg/".length, -4));
  for (const cp of pick(emojiPool, N - items.length + 6)) {
    if (items.length >= N) break;
    const file = path.join(OUT, `emoji-${cp}.png`);
    if (await svgToPng(`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${cp}.svg`, file)) items.push({ name: `emoji-${cp}`, kind: "emoji", file, label: String.fromCodePoint(parseInt(cp, 16)) });
  }
  await fs.writeFile(path.join(OUT, "items.json"), JSON.stringify(items, null, 1));
  console.log(`fetched ${items.length} images: ${items.map((i) => i.label).join(" ")}`);
  return items;
}

function runOne(item: Item): Promise<string> {
  return new Promise((resolve) => {
    const args = ["tsx", "scripts/finisher-geo.ts", item.file, "--mask=auto", `--name=${item.name}`, "--sweep=1", "--bbox=40.70,-74.02,40.78,-73.94", "--step=500", "--scales=1300,1700", "--top=3", "--iters=900", "--minutes=45"];
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, { cwd: process.cwd(), shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const final = out.split("\n").find((l) => l.startsWith("FINAL")) ?? out.split("\n").filter(Boolean).slice(-1)[0] ?? "no output";
      const mask = out.match(/mask (\w+),/)?.[1] ?? "?";
      console.log(`${item.name}: ${final.slice(0, 90)} | mask ${mask}`);
      resolve(`${item.name}\t${item.label}\t${mask}\t${final}`);
    });
  });
}

async function stageRun(items: Item[]): Promise<void> {
  const results: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++]!;
      results.push(await runOne(it));
      await fs.writeFile(path.join(OUT, "results.tsv"), results.join("\n"));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAR, items.length) }, worker));
}

async function stageSheet(items: Item[]): Promise<void> {
  const cellW = 600, cellH = 275, cols = 2;
  const tiles: object[] = [];
  const rows = Math.ceil(items.length / cols);
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const cmp = path.join("tmp-finisher", it.name, "best-compare.png");
    let buf: Buffer;
    try {
      buf = await sharp(cmp).resize(cellW, cellH, { fit: "contain", background: "#fff" }).toBuffer();
    } catch {
      buf = await sharp({ create: { width: cellW, height: cellH, channels: 3, background: "#f3d0d0" } }).png().toBuffer();
    }
    const label = Buffer.from(`<svg width="${cellW}" height="${cellH}" xmlns="http://www.w3.org/2000/svg"><text x="8" y="18" font-family="Arial" font-size="15" fill="#222">${i + 1}. ${it.name}</text></svg>`);
    tiles.push({ input: buf, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH });
    tiles.push({ input: label, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH });
  }
  const file = path.join(OUT, "contact-sheet.png");
  await sharp({ create: { width: cols * cellW, height: rows * cellH, channels: 3, background: "#fff" } }).composite(tiles).png().toFile(file);
  console.log(`wrote ${file}`);
}

async function main() {
  let items: Item[];
  if (STAGE === "fetch" || STAGE === "all") items = await stageFetch();
  else items = JSON.parse(await fs.readFile(path.join(OUT, "items.json"), "utf8")) as Item[];
  if (STAGE === "run" || STAGE === "all") await stageRun(items);
  if (STAGE === "sheet" || STAGE === "all") await stageSheet(items);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
