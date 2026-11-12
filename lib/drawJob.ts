import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redis, redisConfigured } from "./redisRest";
import { loadJobRecord, saveJobRecord } from "./routeJobStore";

/**
 * "Draw my logo" jobs: the site queues an upload, a GPU worker runs the
 * offline pipeline (scripts/perceptual/auto.sh — the exact code behind the
 * routes Ralph judged OK, NOT a port of it) and posts the routes back.
 *
 * Job records reuse the encrypted route-job store. The queue holds nothing
 * but ids, so the worker can list pending work without being able to read
 * anyone's job: a Redis sorted set (score = enqueue time) when Redis is
 * configured, else marker blobs (`draw-queue/<id>`), else files (dev).
 */

export type DrawRoute = {
  km: number;
  /** [lat, lng], street-following, one continuous line */
  points: [number, number][];
  /**
   * mark = a word logo's picture on its own; initials = that picture with
   * `text` lettered under it, under 25 km (Nov 11). Jobs before Nov 9 carry
   * pick = best with no distance limit; short = best under 25 km; alt = the runner-up.
   */
  label?: DrawLabel;
  /** initials routes: the letters drawn under the picture, e.g. "TW" */
  text?: string;
  /** how much the route looks like the drawing, 0..1 (the page's "best" sort); absent before Nov 9 */
  score?: number;
};

export type DrawLabel = "pick" | "short" | "alt" | "mark" | "initials";
const LABELS: DrawLabel[] = ["pick", "short", "alt", "mark", "initials"];
/** the page shows up to five versions, sortable by best match or by distance */
export const MAX_DRAW_ROUTES = 5;

/**
 * sketch = turn the upload into the simple line drawing (simplify.py) for the
 * person to touch up; lineart = plot that touched-up drawing (Oct 31). Jobs
 * with no mode are uploads drawn as they are (before Oct 31).
 */
export type DrawMode = "sketch" | "lineart";
export const DRAW_MODES: DrawMode[] = ["sketch", "lineart"];
/** a line drawing is a few hundred KB at most; anything bigger is refused */
export const MAX_LINE_ART_B64 = 2_000_000;

export type DrawJob = {
  kind: "draw";
  mode?: DrawMode;
  id: string;
  createdAt: number;
  updatedAt: number;
  status: "queued" | "running" | "done" | "failed";
  email: string | null;
  imageBase64: string | null;
  /** what the worker's automatic reading of the upload called it */
  subject: string | null;
  routes: DrawRoute[];
  /** sketch jobs: the line drawing as a PNG data URL */
  lineArt?: string | null;
  /**
   * sketch jobs since Nov 11: every drawing the person can choose from, the
   * one shown first at the front (it is also `lineArt`); one or two
   */
  lineArts?: string[];
  /**
   * the name read off the upload (Nov 11): a sketch job reports it, the page
   * hands it to the lineart job, and the worker letters the short version
   * with it (the name itself when very short, else its initials)
   */
  words?: string | null;
  /** sketch jobs: wording read off the upload that the drawing leaves out (small print, a name past one row) */
  left?: string | null;
  /** a line for the page about what could not be offered, e.g. no version under 25 km */
  note?: string | null;
  error: string | null;
  claimedAt: number | null;
};

const QUEUE_PREFIX = "draw-queue";
/**
 * One public blob holding "1" while anything is queued, "0" otherwise. The
 * worker polls THIS over the CDN (cached 60 s, no Blob operation) instead
 * of listing the queue every few seconds: list() is an advanced operation
 * and a 15 s poll used up a month of them in hours (Sep 26).
 */
const FLAG_PATH = "draw-queue-flag";
const FS_QUEUE = path.join(process.cwd(), ".route-jobs", QUEUE_PREFIX);
const FS_FLAG = path.join(process.cwd(), ".route-jobs", FLAG_PATH);
/** same precedence as the job store: Redis, then Blob, then the filesystem */
const usingBlob = () => !redisConfigured() && Boolean(process.env.BLOB_READ_WRITE_TOKEN);

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

/**
 * Raise or lower the queue flag. Returns the flag's public URL on Blob
 * (the worker polls it directly), null otherwise. Redis needs no flag: an
 * empty claim there is one ZRANGE, so the worker just claims on its backoff.
 */
export async function setQueueFlag(pending: boolean): Promise<string | null> {
  if (redisConfigured()) return null;
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    const r = await put(FLAG_PATH, pending ? "1" : "0", {
      access: "public",
      contentType: "text/plain",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60, // the Blob minimum; a new upload is seen within a minute
    });
    return r.url;
  }
  await fs.mkdir(path.dirname(FS_FLAG), { recursive: true });
  await fs.writeFile(FS_FLAG, pending ? "1" : "0");
  return null;
}

export async function enqueue(id: string): Promise<void> {
  if (redisConfigured()) {
    await redis(["ZADD", QUEUE_PREFIX, "NX", Date.now(), id]);
    return;
  }
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(`${QUEUE_PREFIX}/${id}`, id, {
      access: "public",
      contentType: "text/plain",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } else {
    await fs.mkdir(FS_QUEUE, { recursive: true });
    await fs.writeFile(path.join(FS_QUEUE, id), id);
  }
  await setQueueFlag(true);
}

export async function dequeue(id: string): Promise<void> {
  if (redisConfigured()) {
    await redis(["ZREM", QUEUE_PREFIX, id]);
    return;
  }
  if (usingBlob()) {
    const { del } = await import("@vercel/blob");
    // del by pathname: no list() round trip (that was an advanced op per dequeue)
    await del(`${QUEUE_PREFIX}/${id}`);
    return;
  }
  await fs.rm(path.join(FS_QUEUE, id), { force: true });
}

/** queued ids, oldest first */
export async function queuedIds(): Promise<string[]> {
  if (redisConfigured()) return (await redis<string[]>(["ZRANGE", QUEUE_PREFIX, 0, -1])) ?? [];
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

/** a PNG data URL the worker posted, or null */
export function cleanLineArt(raw: unknown): string | null {
  return typeof raw === "string" && raw.startsWith("data:image/png;base64,") && raw.length <= MAX_LINE_ART_B64 ? raw : null;
}

/** the page offers at most this many drawings of one upload */
export const MAX_LINE_ARTS = 3;

/**
 * The drawings to choose from: `first` (the one shown first) and then the
 * worker's other drawings, each a valid PNG data URL, no repeats. A worker
 * from before Nov 11 posts no list, which leaves just `first`.
 */
export function cleanLineArts(first: string | null, raw: unknown): string[] {
  if (!first) return [];
  const out = [first];
  for (const r of Array.isArray(raw) ? raw : []) {
    const art = cleanLineArt(r);
    if (art && !out.includes(art) && out.length < MAX_LINE_ARTS) out.push(art);
  }
  return out;
}

/** the longest name kept; logo names run to a few words */
export const MAX_WORDS = 40;

/** a name the worker read or the page handed back: capitals, digits, & and single spaces; else null */
export function cleanWords(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const words = raw
    .toUpperCase()
    .replace(/[^A-Z0-9& ]+/g, " ")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, MAX_WORDS)
    .trim();
  return words || null;
}

/** keep only finite lat/lng pairs inside the NYC box; drop anything else */
export function cleanRoutes(raw: unknown): DrawRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: DrawRoute[] = [];
  for (const r of raw.slice(0, MAX_DRAW_ROUTES)) {
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
    const label = (r as { label?: unknown }).label;
    if (points.length >= 2) {
      const route: DrawRoute = { km: Number.isFinite(km) ? km : 0, points };
      if (LABELS.includes(label as DrawLabel)) route.label = label as DrawLabel;
      const text = cleanWords((r as { text?: unknown }).text);
      if (route.label === "initials" && text && text.length <= 5) route.text = text;
      const score = (r as { score?: unknown }).score;
      if (typeof score === "number" && Number.isFinite(score)) {
        route.score = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
      }
      out.push(route);
    }
  }
  return out;
}
