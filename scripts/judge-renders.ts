/**
 * Cold-name judge for rendered route PNGs, with the shared spend ledger.
 * No source image is shown: "what were they trying to draw?"
 *
 * Usage: npx tsx scripts/judge-renders.ts --expect="unicorn,horse" [--judges=3] [--cap=45] file1.png file2.png ...
 * Ledger: tmp-blockraster/ledger.json (refuses past the cap).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const FILES = argv.filter((a) => !a.startsWith("--"));
const EXPECT = opt("expect", "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const JUDGES = Number(opt("judges", "3"));
const CAP_USD = Number(opt("cap", "45"));
const MODEL = "claude-fable-5";
const LEDGER = path.join(process.cwd(), "tmp-blockraster", "ledger.json");

type Ledger = { calls: number; usd: number; log: string[] };
async function readLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await fs.readFile(LEDGER, "utf8")) as Ledger;
  } catch {
    return { calls: 0, usd: 0, log: [] };
  }
}
async function writeLedger(l: Ledger): Promise<void> {
  await fs.mkdir(path.dirname(LEDGER), { recursive: true });
  await fs.writeFile(LEDGER, JSON.stringify(l, null, 1));
}
let KEY = "";
async function claude(content: unknown[], tag: string): Promise<string> {
  const ledger = await readLedger();
  if (ledger.usd >= CAP_USD) throw new Error(`SPEND CAP: ledger at $${ledger.usd.toFixed(2)} >= $${CAP_USD}`);
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1200, output_config: { effort: "low" }, messages: [{ role: "user", content }] }),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
        continue;
      }
      const j = (await res.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
        error?: { message?: string };
      };
      const u = j.usage ?? {};
      const usd = (u.input_tokens ?? 0) * 10e-6 + (u.output_tokens ?? 0) * 50e-6 + (u.cache_creation_input_tokens ?? 0) * 12.5e-6 + (u.cache_read_input_tokens ?? 0) * 1e-6;
      const l = await readLedger();
      l.calls++;
      l.usd += usd;
      l.log.push(`${new Date().toISOString()} ${tag} in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"} $${usd.toFixed(4)} total=$${l.usd.toFixed(2)}`);
      await writeLedger(l);
      if (j.error) throw new Error(j.error.message ?? "api error");
      return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
    } catch (e) {
      if (String(e).includes("SPEND CAP")) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
    }
  }
  return "";
}
const COLD_PROMPT =
  "The orange line is a GPS route someone recorded while running; they were trying to draw a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words, or \"nothing recognizable\">\nCONFIDENCE: <0-10>";

async function main() {
  KEY = (await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8")).match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  if (!KEY) throw new Error("ANTHROPIC_API_KEY missing in .env.local");
  if (!FILES.length) throw new Error("no files");
  const before = await readLedger();
  console.log(`ledger before: ${before.calls} calls $${before.usd.toFixed(2)}; this batch: ${FILES.length * JUDGES} calls`);
  for (const f of FILES) {
    const jpg: Buffer = await sharp(f).resize({ width: 1400 }).jpeg({ quality: 88 }).toBuffer();
    const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpg.toString("base64") } };
    const names: { guess: string; conf: number }[] = [];
    for (let i = 0; i < JUDGES; i++) {
      const t = await claude([img, { type: "text", text: COLD_PROMPT }], path.basename(f));
      const guess = (t.match(/GUESS\**:?\**\s*(.+?)\s*(?:\n|\*|CONFIDENCE|$)/i)?.[1] ?? "").trim();
      names.push({ guess: guess || "?", conf: Number(t.match(/CONFIDENCE\**:?\**\s*(\d+)/i)?.[1] ?? 0) });
    }
    const ok = names.filter((n) => EXPECT.some((e) => n.guess.toLowerCase().includes(e)));
    const meanConf = names.reduce((s, n) => s + n.conf, 0) / Math.max(1, names.length);
    const pass = EXPECT.length > 0 && ok.length === names.length && meanConf >= 7;
    console.log(`${f}: ${names.map((n) => `${n.guess} ${n.conf}`).join(" / ")} => ${pass ? "PASS" : `${ok.length}/${names.length} correct, conf ${meanConf.toFixed(1)}`}`);
  }
  const after = await readLedger();
  console.log(`ledger after: ${after.calls} calls $${after.usd.toFixed(2)} of $${CAP_USD} cap`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
