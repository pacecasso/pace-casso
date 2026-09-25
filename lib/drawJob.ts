import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadJobRecord, saveJobRecord } from "./routeJobStore";

/**
 * "Draw my logo" jobs: the site queues an upload, a GPU worker runs the
 * offline pipeline (scripts/perceptual/auto.sh — the exact code behind the
 * routes Ralph judged OK, NOT a port of it) and posts the routes back.
 *
 * Job records reuse the encrypted route-job store. The queue is a set of
 * marker blobs (`draw-queue/<id>`) holding nothing but the id, so the worker
 * can list pending work without being able to read anyone's job.
 */

export type DrawRoute = {
  km: number;
  /** [lat, lng], street-following, one continuous line */
  points: [number, number][];
};

export type DrawJob = {
  kind: "draw";
  id: string;
  createdAt: number;
  updatedAt: number;
  status: "queued" | "running" | "done" | "failed";
  email: string | null;
  imageBase64: string | null;
  /** what the worker's automatic reading of the upload called it */
  subject: string | null;
  routes: DrawRoute[];
  error: string | null;
  claimedAt: number | null;
};

const QUEUE_PREFIX = "draw-queue";
const FS_QUEUE = path.join(process.cwd(), ".route-jobs", QUEUE_PREFIX);
const usingBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

export function newDrawJobId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function saveDrawJob(job: DrawJob): Promise<void> {
  job.updatedAt = Date.now();
  await saveJobRecord(job.id, job);
}

export async function loadDrawJob(id: string): Promise<DrawJob | null> {
  const j = await loadJobRecord<DrawJob>(id);
  return j && j.kind === "draw" ? j : null;
}

export async function enqueue(id: string): Promise<void> {
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(`${QUEUE_PREFIX}/${id}`, id, {
      access: "public",
      contentType: "text/plain",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
    return;
  }
  await fs.mkdir(FS_QUEUE, { recursive: true });
  await fs.writeFile(path.join(FS_QUEUE, id), id);
}

export async function dequeue(id: string): Promise<void> {
  if (usingBlob()) {
    const { list, del } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: `${QUEUE_PREFIX}/${id}` });
    if (blobs.length) await del(blobs.map((b) => b.url));
    return;
  }
  await fs.rm(path.join(FS_QUEUE, id), { force: true });
}

/** queued ids, oldest first */
export async function queuedIds(): Promise<string[]> {
  if (usingBlob()) {
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: `${QUEUE_PREFIX}/` });
    return blobs
      .sort((a, b) => +new Date(a.uploadedAt) - +new Date(b.uploadedAt))
      .map((b) => b.pathname.slice(QUEUE_PREFIX.length + 1));
  }
  try {
    const names = await fs.readdir(FS_QUEUE);
    const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fs.stat(path.join(FS_QUEUE, n))).mtimeMs })));
    return stats.sort((a, b) => a.t - b.t).map((s) => s.n);
  } catch {
    return [];
  }
}

/** constant-time check of the worker's bearer secret */
export function workerAuthorized(req: Request): boolean {
  const secret = process.env.DRAW_WORKER_SECRET?.trim();
  if (!secret) return false;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** keep only finite lat/lng pairs inside the NYC box; drop anything else */
export function cleanRoutes(raw: unknown): DrawRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: DrawRoute[] = [];
  for (const r of raw.slice(0, 3)) {
    const pts = Array.isArray((r as { points?: unknown })?.points) ? (r as { points: unknown[] }).points : [];
    const points: [number, number][] = [];
    for (const p of pts.slice(0, 20_000)) {
      if (!Array.isArray(p)) continue;
      const [lat, lng] = p as number[];
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat > 40.3 && lat < 41.1 && lng > -74.4 && lng < -73.5) {
        points.push([Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6]);
      }
    }
    const km = Number((r as { km?: unknown }).km);
    if (points.length >= 2) out.push({ km: Number.isFinite(km) ? km : 0, points });
  }
  return out;
}
