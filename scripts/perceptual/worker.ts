/**
 * The GPU worker behind /draw: claims queued uploads from the site, runs
 * scripts/perceptual/auto.sh on them (the same code, byte for byte, that
 * made the routes Ralph judged), and posts the routes back.
 *
 *   SITE=https://www.pacecasso.com npx tsx scripts/perceptual/worker.ts
 *
 * One job at a time: each run holds the 500k-node graph (~1.8 GB) and the GPU.
 *
 * Polling is cheap by design: an empty claim hands back the URL of a public
 * "queue flag" blob, and from then on the worker only reads that URL over
 * the CDN (cached 60 s, no Blob operation). It calls the claim API, which
 * costs a Blob list(), only when the flag says something is queued. Idle
 * waits start at 1 min and double to 10 min. The old 15 s claim loop used
 * up a month of Blob operations in about 8 hours (Sep 26).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SITE = (process.env.SITE ?? "http://localhost:3000").replace(/\/$/, "");
// the secret lives outside the repo; the same value is DRAW_WORKER_SECRET on Vercel
const SECRET_FILE = "C:/Users/ralph/pacecasso-worker-secret.txt";
const SECRET = (process.env.DRAW_WORKER_SECRET ?? (existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, "utf8") : "")).trim();
const IDLE_MIN_MS = 60_000;
const IDLE_MAX_MS = 10 * 60_000;
if (!SECRET) throw new Error("DRAW_WORKER_SECRET is required");

const auth = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

function run(cmd: string, args: string[], logFile: string, env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: process.cwd(), env: { ...process.env, ...env } });
    const log: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => log.push(d));
    p.stderr.on("data", (d: Buffer) => log.push(d));
    p.on("close", (code) => {
      writeFileSync(logFile, Buffer.concat(log));
      resolve(code ?? 1);
    });
  });
}

function gpxPoints(file: string): [number, number][] {
  const t = readFileSync(file, "utf8");
  return [...t.matchAll(/lat="([-\d.]+)"\s+lon="([-\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

function km(pts: [number, number][]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = pts[i - 1]!, [c, d] = pts[i]!;
    const dy = (c - a) * 110_540, dx = (d - b) * 111_320 * Math.cos((a * Math.PI) / 180);
    m += Math.hypot(dx, dy);
  }
  return Math.round(m / 100) / 10;
}

function extFor(b64: string): string {
  if (b64.startsWith("data:image/jpeg") || b64.startsWith("/9j/")) return "jpg";
  if (b64.startsWith("data:image/webp") || b64.startsWith("UklGR")) return "webp";
  return "png";
}

type Claim = { job: { id: string; imageBase64: string } | null; flagUrl: string | null };

/** Nothing over this is ever offered; a runner can bike it or split it, but 65 km is the edge. */
const MAX_KM = 65;
/** The second lane: the best readable version that comes in under this. */
const SHORT_KM = 25;
/** A draft this far below the best draft's score (log-prob units) is a scribble. */
const SCORE_GAP = 1.5;
/**
 * The flat length charge auto.sh gives the free search (KM_W). The fit's
 * `score` has it subtracted, which made a 6.1 km heart outrank the 14.6 km
 * one Ralph picked (Oct 12): adding it back ranks drafts by how much they
 * look like the picture, which is what "our pick" means. Must match auto.sh.
 */
const FREE_KM_W = 0.02;

type Draft = { seat: number; score: number; mainRank: number; km: number; points: [number, number][] };
type Labeled = { km: number; points: [number, number][]; label: "pick" | "short" | "alt" };

/**
 * The drafts a fit run believes in, best score first.
 *
 * streetfit.py writes four finalists (seat0..3), each with a `score`
 * (main-scorer log-prob minus penalties) and `main_rank` (how many of the
 * scorer's own vocabulary words outranked the subject on that drawing; 0
 * means the drawing reads as the subject). The Oct 12 batch (size-oct12.png)
 * showed that the unreadable drafts were exactly the ones with main_rank > 0
 * or a score 1.5+ below their siblings, and every readable draft passed both.
 */
function readDrafts(dir: string, kmW = 0): Draft[] {
  const seats: Draft[] = [];
  for (let i = 0; i < 4; i++) {
    const gpx = path.join(dir, `route${i}.gpx`);
    if (!existsSync(gpx)) continue;
    let score = 0, mainRank = 0;
    const meta = path.join(dir, "fit", `seat${i}.json`);
    if (existsSync(meta)) {
      try {
        const j = JSON.parse(readFileSync(meta, "utf8")) as { score?: number; main_rank?: number; km_ink?: number };
        // recognizability: the fit's score with the flat length charge added back
        score = Number(j.score ?? 0) + kmW * Number(j.km_ink ?? 0);
        mainRank = Number(j.main_rank ?? 0);
      } catch {
        /* unreadable meta: keep the draft, the old behaviour */
      }
    }
    const points = gpxPoints(gpx);
    if (points.length < 2) continue;
    seats.push({ seat: i, score, mainRank, km: km(points), points });
  }
  const best = Math.max(...seats.map((s) => s.score), -Infinity);
  const kept = seats.filter((s) => s.mainRank === 0 && s.score >= best - SCORE_GAP);
  const dropped = seats.filter((s) => !kept.includes(s));
  if (dropped.length) {
    console.log(`  ${path.basename(dir)}: dropped ${dropped.map((s) => `seat${s.seat} (score ${s.score.toFixed(2)}, rank ${s.mainRank})`).join(", ")}`);
  }
  return kept.sort((a, b) => b.score - a.score);
}

/**
 * Two lanes (Ralph, Oct 12): "our pick" is the best readable draft with no
 * distance limit beyond MAX_KM, because his picks were the largest draft in
 * every row of distance-oct12.png; then one that comes in under SHORT_KM for
 * the runner who will not do 35 km. The free search covers the short lane
 * when it happens to land one; otherwise fit-short.sh refits under the cap,
 * and only a result that passes the same recognition test is used. A third
 * slot takes the free search's runner-up.
 */
async function chooseLanes(dir: string): Promise<{ routes: Labeled[]; note: string | null }> {
  const free = readDrafts(dir, FREE_KM_W).filter((d) => d.km <= MAX_KM);
  const pick = free[0];
  if (!pick) return { routes: [], note: null };
  const strip = (d: Draft, label: Labeled["label"]): Labeled => ({ km: d.km, points: d.points, label });
  const routes: Labeled[] = [strip(pick, "pick")];
  let note: string | null = null;
  let short = free.find((d) => d !== pick && d.km <= SHORT_KM);
  if (!short && pick.km > SHORT_KM) {
    console.log(`  nothing under ${SHORT_KM} km in the free search; refitting under the cap`);
    await run("bash", ["scripts/perceptual/fit-short.sh", dir, String(SHORT_KM)], path.join(dir, "short.log"));
    short = readDrafts(path.join(dir, "short")).find((d) => d.km <= SHORT_KM);
    if (!short) note = `This picture does not read under ${SHORT_KM} km, so there is no shorter version.`;
  }
  if (short) routes.push(strip(short, "short"));
  const alt = free.find((d) => d !== pick && d !== short);
  if (alt) routes.push(strip(alt, "alt"));
  return { routes, note };
}

async function claim(): Promise<Claim> {
  const res = await fetch(`${SITE}/api/draw-job/worker`, { headers: auth });
  if (!res.ok) throw new Error(`claim ${res.status}`);
  return (await res.json()) as Claim;
}

/** true when the flag blob says work is queued; null when it could not be read */
async function flagRaised(url: string): Promise<boolean | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.text()).trim() === "1";
  } catch {
    return null;
  }
}

async function work(job: NonNullable<Claim["job"]>): Promise<void> {
  const dir = path.join("tmp-auto", "jobs", job.id);
  mkdirSync(dir, { recursive: true });
  const b64 = job.imageBase64.includes(",") ? job.imageBase64.slice(job.imageBase64.indexOf(",") + 1) : job.imageBase64;
  const img = path.join(dir, `upload.${extFor(job.imageBase64)}`);
  writeFileSync(img, Buffer.from(b64, "base64"));
  const t0 = Date.now();
  console.log(`${new Date().toISOString()} job ${job.id} started`);
  const code = await run("bash", ["scripts/perceptual/auto.sh", img, dir], path.join(dir, "run.log"));
  const { routes, note } = await chooseLanes(dir);
  const prep = existsSync(path.join(dir, "prep.log")) ? readFileSync(path.join(dir, "prep.log"), "utf8") : "";
  const subject = /^SUBJECT=(.*)$/m.exec(prep)?.[1] ?? null;
  const post = await fetch(`${SITE}/api/draw-job/worker`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: job.id, routes, subject, note, error: routes.length ? null : `pipeline exit ${code}` }),
  });
  console.log(`  ${routes.length} routes (${routes.map((r) => `${r.label} ${r.km} km`).join(", ")}) in ${((Date.now() - t0) / 60000).toFixed(1)} min -> ${post.status}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`worker polling ${SITE}`);
  let flagUrl: string | null = null;
  let idle = IDLE_MIN_MS;
  for (;;) {
    try {
      // With a flag URL in hand, only the flag is read while idle. A
      // failed flag read falls through to the claim API, so a bad CDN
      // response cannot leave jobs stranded.
      const raised = flagUrl ? await flagRaised(flagUrl) : true;
      if (raised === false) {
        await sleep(idle);
        idle = Math.min(idle * 2, IDLE_MAX_MS);
        continue;
      }
      const c = await claim();
      if (c.flagUrl) {
        if (!flagUrl) console.log(`  watching queue flag ${c.flagUrl}`);
        flagUrl = c.flagUrl;
      }
      if (!c.job) {
        await sleep(idle);
        idle = Math.min(idle * 2, IDLE_MAX_MS);
        continue;
      }
      idle = IDLE_MIN_MS;
      await work(c.job);
    } catch (e) {
      console.log(`  ${(e as Error).message}`);
      await sleep(idle);
      idle = Math.min(idle * 2, IDLE_MAX_MS);
    }
  }
}
main();
