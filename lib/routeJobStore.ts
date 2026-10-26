import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redis, redisConfigured } from "./redisRest";

/**
 * Persistence for async route-search jobs. Backend is Upstash Redis when
 * configured, else Vercel Blob when BLOB_READ_WRITE_TOKEN is configured,
 * else the local filesystem (dev).
 *
 * Blob URLs are public-if-you-know-them, and a job carries the user's
 * email and uploaded image — so every job is encrypted at rest
 * (AES-256-GCM) with a key derived from server-only secret material. The
 * blob store only ever sees ciphertext; our API decrypts server-side and
 * exposes exactly the status/result fields.
 */

const FS_DIR = path.join(process.cwd(), ".route-jobs");
const BLOB_PREFIX = "route-jobs";

function secretKey(): Buffer {
  const material = process.env.ROUTE_JOB_SECRET?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!material) throw new Error("No server secret available for job encryption");
  return crypto.createHash("sha256").update(`route-job:${material}`).digest();
}

export function newJobId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** HMAC token gating the internal step endpoint for a given job. */
export function jobStepToken(jobId: string): string {
  return crypto.createHmac("sha256", secretKey()).update(`step:${jobId}`).digest("hex");
}

function encrypt(plain: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(buf: Buffer): string {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const body = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/** Redis keeps a job this long; the result link in the email outlives any run. */
const REDIS_TTL_S = 60 * 24 * 3600;

export function jobStoreConfigured(): boolean {
  return redisConfigured() || Boolean(process.env.BLOB_READ_WRITE_TOKEN) || process.env.NODE_ENV !== "production";
}

/** Redis wins over Blob when both are set (the Blob store was suspended Oct 4 – Oct 26+). */
function usingBlob(): boolean {
  return !redisConfigured() && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function saveJobRecord(jobId: string, record: unknown): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(jobId)) throw new Error("bad job id");
  const data = encrypt(JSON.stringify(record));
  if (redisConfigured()) {
    await redis(["SET", `${BLOB_PREFIX}:${jobId}`, data.toString("base64"), "EX", REDIS_TTL_S]);
    return;
  }
  if (usingBlob()) {
    const { put } = await import("@vercel/blob");
    await put(`${BLOB_PREFIX}/${jobId}.bin`, data, {
      access: "public",
      contentType: "application/octet-stream",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
    return;
  }
  await fs.mkdir(FS_DIR, { recursive: true });
  await fs.writeFile(path.join(FS_DIR, `${jobId}.bin`), data);
}

export async function loadJobRecord<T>(jobId: string): Promise<T | null> {
  if (!/^[0-9a-f]{32}$/.test(jobId)) return null;
  let data: Buffer | null = null;
  if (redisConfigured()) {
    try {
      const s = await redis<string | null>(["GET", `${BLOB_PREFIX}:${jobId}`]);
      if (!s) return null;
      data = Buffer.from(s, "base64");
    } catch {
      return null;
    }
  } else if (usingBlob()) {
    const { head } = await import("@vercel/blob");
    try {
      const meta = await head(`${BLOB_PREFIX}/${jobId}.bin`);
      // no-store: a stale cached read of a finished job would re-run a stage
      const res = await fetch(meta.url, { cache: "no-store" });
      if (!res.ok) return null;
      data = Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  } else {
    try {
      data = await fs.readFile(path.join(FS_DIR, `${jobId}.bin`));
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(decrypt(data)) as T;
  } catch {
    return null;
  }
}
