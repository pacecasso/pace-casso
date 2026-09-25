import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import { jobStoreConfigured } from "../../../lib/routeJobStore";
import { enqueue, loadDrawJob, newDrawJobId, queuedIds, saveDrawJob, type DrawJob } from "../../../lib/drawJob";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_IMAGE_B64 = 4_000_000;

/** Queue an upload for the GPU worker. Returns immediately. */
export async function POST(req: Request) {
  const shield = shieldExpensiveRoute(req, "draw-job", 200);
  if (!shield.ok) return Response.json({ error: shield.message }, { status: shield.status });
  if (!rateLimitAllow(`draw-job:${trustedClientIp(req)}`, 6)) {
    return Response.json({ error: "Too many uploads - try again in a minute." }, { status: 429 });
  }
  if (!jobStoreConfigured()) return Response.json({ error: "job store not configured" }, { status: 503 });
  let body: { imageBase64?: unknown; email?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const imageBase64 =
    typeof body.imageBase64 === "string" && body.imageBase64.length > 100 && body.imageBase64.length <= MAX_IMAGE_B64
      ? body.imageBase64
      : null;
  if (!imageBase64) return Response.json({ error: "Upload a PNG, JPG or WebP under 3 MB." }, { status: 400 });
  const email =
    typeof body.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email.trim())
      ? body.email.trim().slice(0, 254)
      : null;
  const job: DrawJob = {
    kind: "draw",
    id: newDrawJobId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "queued",
    email,
    imageBase64,
    subject: null,
    routes: [],
    error: null,
    claimedAt: null,
  };
  await saveDrawJob(job);
  await enqueue(job.id);
  return Response.json({ jobId: job.id });
}

/** Status for the page; never returns the image or the email. */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const job = await loadDrawJob(id);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  let ahead = 0;
  if (job.status === "queued") {
    const q = await queuedIds();
    ahead = Math.max(0, q.indexOf(job.id));
  }
  return Response.json({
    jobId: job.id,
    status: job.status,
    ahead,
    createdAt: job.createdAt,
    subject: job.subject,
    routes: job.status === "done" ? job.routes : [],
    error: job.error,
  });
}
