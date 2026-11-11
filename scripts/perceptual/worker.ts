/**
 * The worker behind /draw, run on Ralph's PC: claims queued uploads from the
 * site, fits them onto NYC streets, and posts the routes back.
 *
 *   SITE=https://www.pacecasso.com npx tsx scripts/perceptual/worker.ts
 *
 * Engine: scripts/geometry/draw_job.py (CPU, ~20 s a job) by default since
 * Oct 30; ENGINE=old runs scripts/perceptual/auto.sh (CLIP + GPU, ~4 min).
 * One job at a time. Run exactly one worker: two would race for jobs.
 *
 * With Blob storage, an empty claim hands back the URL of a public "queue
 * flag" blob and the worker reads only that URL while idle (the old 15 s
 * claim loop used up a month of Blob operations in about 8 hours, Sep 26).
 * With Redis the claim itself is cheap, so idle polls are a flat 30 s.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SITE = (process.env.SITE ?? "http://localhost:3000").replace(/\/$/, "");
// the secret lives outside the repo; the same value is DRAW_WORKER_SECRET on Vercel
const SECRET_FILE = "C:/Users/ralph/pacecasso-worker-secret.txt";
const SECRET = (process.env.DRAW_WORKER_SECRET ?? (existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, "utf8") : "")).trim();
/** "geometry" (default) or "old" (auto.sh) */
const ENGINE = process.env.ENGINE ?? "geometry";
const PY = process.env.PY ?? "C:/Users/ralph/pacecasso-gpu-env/Scripts/python";
// Redis claims are cheap (Oct 30): a flat 30 s, so an upload never waits 10 min for an idle worker
const IDLE_MIN_MS = 30_000;
const IDLE_MAX_MS = 30_000;
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

type Claim = { job: { id: string; imageBase64: string; mode?: "sketch" | "lineart" | null } | null; flagUrl: string | null };

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
/**
 * score: the geometry engine's 0..1 match with the drawing (the page sorts by
 * it); label "mark" = a word logo's picture on its own. The old engine sends
 * pick/short/alt and no score.
 */
type Labeled = { km: number; points: [number, number][]; label?: "pick" | "short" | "alt" | "mark"; score?: number };
/** the page shows up to this many versions, sortable by best match or distance (Nov 9) */
const MAX_ROUTES = 5;

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
  const strip = (d: Draft, label: "pick" | "short" | "alt"): Labeled => ({ km: d.km, points: d.points, label });
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

type EngineResult = { code: number; routes: Labeled[]; note: string | null; subject: string | null };

/** auto.sh (CLIP-label streetfit) + the two-lane chooser; ENGINE=old */
async function oldEngine(img: string, dir: string): Promise<EngineResult> {
  const code = await run("bash", ["scripts/perceptual/auto.sh", img, dir], path.join(dir, "run.log"));
  const { routes, note } = await chooseLanes(dir);
  const prep = existsSync(path.join(dir, "prep.log")) ? readFileSync(path.join(dir, "prep.log"), "utf8") : "";
  const subject = /^SUBJECT=(.*)$/m.exec(prep)?.[1] ?? null;
  return { code, routes, note, subject };
}

/**
 * The Oct 28 expert's geometry-first fit (scripts/geometry/draw_job.py):
 * it scores routes against the upload's own shape, not a CLIP label. On the
 * Oct 30 rabbit the old engine had nothing under 65 km; this one read at 22
 * and 48 km. It fits five sizes (~10 to ~38 km) and scores each one's match
 * with the drawing (0..1). Until Nov 9 the worker showed two of them (the
 * largest as "our pick", the largest under 25 km) and hid the ~10 km one;
 * a cold review that day found the hidden 10.5 km rocket and 8.7 km duck
 * were the ones a runner would actually run. Now every version up to
 * MAX_ROUTES goes to the page, best match first, and the runner sorts them
 * by best or by distance.
 */
async function geometryEngine(img: string, dir: string, lineart = false): Promise<EngineResult> {
  const out = path.join(dir, "geo");
  const args = ["-u", "scripts/geometry/draw_job.py", img, out, "--text=keep", ...(lineart ? ["--lineart"] : [])];
  const code = await run(PY, args, path.join(dir, "geo.log"));
  const file = path.join(out, "routes.json");
  if (!existsSync(file)) return { code, routes: [], note: null, subject: null };
  const j = JSON.parse(readFileSync(file, "utf8")) as {
    routes: { km: number; points: [number, number][]; label?: string; score?: number }[];
    note: string | null;
    words?: string | null;
  };
  // lettering it read off the logo and redrew as block letters (readtext.py)
  const subject = j.words ? `the words "${j.words}"` : null;
  const routes: Labeled[] = j.routes
    .filter((r) => r.km <= MAX_KM && r.points.length >= 2)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, MAX_ROUTES)
    .map((r) => ({
      km: r.km,
      points: r.points,
      ...(typeof r.score === "number" ? { score: r.score } : {}),
      // the engine's size names (s10, a, b...) mean nothing to the page; "mark" does
      ...(r.label === "mark" ? { label: "mark" as const } : {}),
    }));
  return { code, routes, note: j.note, subject };
}

async function work(job: NonNullable<Claim["job"]>): Promise<void> {
  const dir = path.join("tmp-auto", "jobs", job.id);
  mkdirSync(dir, { recursive: true });
  const b64 = job.imageBase64.includes(",") ? job.imageBase64.slice(job.imageBase64.indexOf(",") + 1) : job.imageBase64;
  const img = path.join(dir, `upload.${extFor(job.imageBase64)}`);
  writeFileSync(img, Buffer.from(b64, "base64"));
  const t0 = Date.now();
  console.log(`${new Date().toISOString()} job ${job.id} started${job.mode ? ` (${job.mode})` : ""}`);
  if (job.mode === "sketch") {
    // upload -> the simple line drawing the person touches up (simplify.py, Oct 31)
    const png = path.join(dir, "lineart.png");
    const code = await run(PY, ["-u", "scripts/geometry/simplify.py", img, png], path.join(dir, "sketch.log"));
    const dataUrl = (f: string) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
    const lineArt = existsSync(png) ? dataUrl(png) : null;
    // a second drawing to choose from, when simplify.py made one (Nov 11): the
    // bold shape beside the detailed one, whichever kept the picture first
    const png2 = path.join(dir, "lineart-2.png");
    const lineArts = lineArt ? [lineArt, ...(existsSync(png2) ? [dataUrl(png2)] : [])] : [];
    const post = await fetch(`${SITE}/api/draw-job/worker`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: job.id, lineArt, lineArts, error: lineArt ? null : `sketch exit ${code}` }),
    });
    console.log(`  line art ${lineArt ? `made (${lineArts.length})` : "FAILED"} in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${post.status}`);
    return;
  }
  const { code, routes, note, subject } =
    ENGINE === "old" ? await oldEngine(img, dir) : await geometryEngine(img, dir, job.mode === "lineart");
  const post = await fetch(`${SITE}/api/draw-job/worker`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: job.id, routes, subject, note, error: routes.length ? null : `pipeline exit ${code}` }),
  });
  console.log(`  ${routes.length} routes (${routes.map((r) => `${r.label ? `${r.label} ` : ""}${r.km} km`).join(", ")}) in ${((Date.now() - t0) / 60000).toFixed(1)} min -> ${post.status}`);
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
