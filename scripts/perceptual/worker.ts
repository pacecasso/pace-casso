/**
 * The GPU worker behind /draw: claims queued uploads from the site, runs
 * scripts/perceptual/auto.sh on them (the same code, byte for byte, that
 * made the routes Ralph judged), and posts the routes back.
 *
 *   SITE=https://www.pacecasso.com npx tsx scripts/perceptual/worker.ts
 *
 * One job at a time: each run holds the 500k-node graph (~1.8 GB) and the GPU.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SITE = (process.env.SITE ?? "http://localhost:3000").replace(/\/$/, "");
// the secret lives outside the repo; the same value is DRAW_WORKER_SECRET on Vercel
const SECRET_FILE = "C:/Users/ralph/pacecasso-worker-secret.txt";
const SECRET = (process.env.DRAW_WORKER_SECRET ?? (existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, "utf8") : "")).trim();
const POLL_MS = 15_000;
if (!SECRET) throw new Error("DRAW_WORKER_SECRET is required");

const auth = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };

function run(cmd: string, args: string[], logFile: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: process.cwd() });
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

async function once(): Promise<boolean> {
  const res = await fetch(`${SITE}/api/draw-job/worker`, { headers: auth });
  if (!res.ok) throw new Error(`claim ${res.status}`);
  const { job } = (await res.json()) as { job: { id: string; imageBase64: string } | null };
  if (!job) return false;
  const dir = path.join("tmp-auto", "jobs", job.id);
  mkdirSync(dir, { recursive: true });
  const b64 = job.imageBase64.includes(",") ? job.imageBase64.slice(job.imageBase64.indexOf(",") + 1) : job.imageBase64;
  const img = path.join(dir, `upload.${extFor(job.imageBase64)}`);
  writeFileSync(img, Buffer.from(b64, "base64"));
  const t0 = Date.now();
  console.log(`${new Date().toISOString()} job ${job.id} started`);
  const code = await run("bash", ["scripts/perceptual/auto.sh", img, dir], path.join(dir, "run.log"));
  const routes = [0, 1, 2]
    .map((i) => path.join(dir, `route${i}.gpx`))
    .filter((f) => existsSync(f))
    .map((f) => {
      const points = gpxPoints(f);
      return { km: km(points), points };
    })
    .filter((r) => r.points.length >= 2);
  const prep = existsSync(path.join(dir, "prep.log")) ? readFileSync(path.join(dir, "prep.log"), "utf8") : "";
  const subject = /^SUBJECT=(.*)$/m.exec(prep)?.[1] ?? null;
  const post = await fetch(`${SITE}/api/draw-job/worker`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ id: job.id, routes, subject, error: routes.length ? null : `pipeline exit ${code}` }),
  });
  console.log(`  ${routes.length} routes (${routes.map((r) => r.km + " km").join(", ")}) in ${((Date.now() - t0) / 60000).toFixed(1)} min -> ${post.status}`);
  return true;
}

async function main() {
  console.log(`worker polling ${SITE}`);
  for (;;) {
    let worked = false;
    try {
      worked = await once();
    } catch (e) {
      console.log(`  ${(e as Error).message}`);
    }
    if (!worked) await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
main();
