import { waitUntil } from "@vercel/functions";
import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import { jobStoreConfigured, newJobId, jobStepToken } from "../../../lib/routeJobStore";
import { loadJob, saveJob, type RouteJob } from "../../../lib/routeJobServer";
import type { NormalizedPoint } from "../../../lib/streetGraphTrace";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_POINTS = 600;
const MAX_IMAGE_B64 = 4_000_000;
/** a job stuck "running" longer than this gets its chain re-fired */
const STALE_RUNNING_MS = 6 * 60_000;

function cleanContour(raw: unknown): NormalizedPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedPoint[] = [];
  for (const p of raw) {
    if (
      p &&
      typeof p === "object" &&
      Number.isFinite((p as { x?: number }).x) &&
      Number.isFinite((p as { y?: number }).y)
    ) {
      out.push({
        x: Math.min(1, Math.max(0, (p as { x: number }).x)),
        y: Math.min(1, Math.max(0, (p as { y: number }).y)),
      });
      if (out.length >= MAX_POINTS) break;
    }
  }
  return out;
}

function selfOrigin(req: Request): string {
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Fire the next step invocation without waiting for it to finish. */
function fireStep(req: Request, jobId: string): void {
  const url = `${selfOrigin(req)}/api/route-job/step`;
  waitUntil(
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, token: jobStepToken(jobId) }),
    }).catch(() => {
      /* the status watchdog will re-fire a stalled chain */
    }),
  );
}

/**
 * Async route search: POST creates a job and returns immediately — the
 * user can close the tab; GET reports status/result. The cascade runs as
 * chained /api/route-job/step invocations, state in the encrypted job
 * store.
 */
export async function POST(req: Request) {
  const shield = shieldExpensiveRoute(req, "route-job", 200);
  if (!shield.ok) {
    return Response.json({ error: shield.message }, { status: shield.status });
  }
  if (!rateLimitAllow(`route-job:${trustedClientIp(req)}`, 6)) {
    return Response.json({ error: "Rate limit" }, { status: 429 });
  }
  if (!jobStoreConfigured()) {
    // Blob store not enabled yet — the client falls back to the live
    // in-tab cascade so the product keeps working.
    return Response.json({ error: "job store not configured" }, { status: 503 });
  }
  let body: {
    contour?: unknown;
    cityId?: unknown;
    cityLabel?: unknown;
    subject?: unknown;
    imageBase64?: unknown;
    sourceName?: unknown;
    email?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const cityId = typeof body.cityId === "string" ? body.cityId : "manhattan";
  if (cityId !== "manhattan") {
    return Response.json({ error: "manhattan-only" }, { status: 400 });
  }
  const contour = cleanContour(body.contour);
  if (contour.length < 8) {
    return Response.json({ error: "contour too short" }, { status: 400 });
  }
  const email =
    typeof body.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email.trim())
      ? body.email.trim().slice(0, 254)
      : null;
  const imageBase64 =
    typeof body.imageBase64 === "string" &&
    body.imageBase64.length > 100 &&
    body.imageBase64.length <= MAX_IMAGE_B64
      ? body.imageBase64
      : null;

  const job: RouteJob = {
    id: newJobId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    email,
    cityId,
    cityLabel: typeof body.cityLabel === "string" ? body.cityLabel.slice(0, 60) : "Manhattan",
    status: "queued",
    stage: "studio",
    round: 0,
    stageNote: "Queued…",
    input: {
      contour,
      subject:
        typeof body.subject === "string" && body.subject.trim()
          ? body.subject.trim().slice(0, 80)
          : null,
      imageBase64,
      sourceName:
        typeof body.sourceName === "string" ? body.sourceName.slice(0, 120) : null,
    },
    lastMessage: null,
    pendingRedraw: null,
    result: null,
    error: null,
    emailedAt: null,
    leaseUntil: null,
  };
  await saveJob(job);
  fireStep(req, job.id);
  return Response.json({ jobId: job.id, email: job.email });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("id") ?? "";
  const job = await loadJob(jobId);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  // watchdog: a running job whose chain died (function killed mid-stage)
  // gets re-fired on any status poll.
  if (
    (job.status === "running" || job.status === "queued") &&
    Date.now() - job.updatedAt > STALE_RUNNING_MS
  ) {
    fireStep(req, job.id);
  }
  return Response.json({
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    round: job.round,
    stageNote: job.stageNote,
    result: job.status === "done" ? job.result : null,
    error: job.error,
    // lets a fresh browser (email link on another device) reconstruct the
    // flow: contour → Step 2 → the pickup effect applies the result.
    contour: job.input.contour,
    subject: job.input.subject,
    cityId: job.cityId,
  });
}
