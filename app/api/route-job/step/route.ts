import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { jobStepToken } from "../../../../lib/routeJobStore";
import { advanceJob, loadJob, saveJob } from "../../../../lib/routeJobServer";
import { sendJobResultEmail } from "../../../../lib/routeJobEmail";

export const runtime = "nodejs";
// One cascade stage per invocation; each stage budgets itself under this.
export const maxDuration = 300;

function selfOrigin(req: Request): string {
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Internal chain link for async route jobs: authenticated by an HMAC of
 * the job id (no session cookies cross this hop), responds 202
 * immediately, runs ONE stage via waitUntil, then fires the next link
 * until the job finishes. On finish, sends the result email.
 */
export async function POST(req: Request) {
  let body: { jobId?: unknown; token?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const token = typeof body.token === "string" ? body.token : "";
  if (!jobId || !token) return Response.json({ error: "bad request" }, { status: 400 });
  const expected = jobStepToken(jobId);
  if (
    token.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  ) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const job = await loadJob(jobId);
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  if (job.status === "done" || job.status === "failed") {
    return Response.json({ ok: true, status: job.status });
  }
  if (job.status === "running" && job.leaseUntil && job.leaseUntil > Date.now()) {
    // another step invocation is actively working this job
    return Response.json({ ok: true, status: "leased" });
  }

  waitUntil(
    (async () => {
      const advanced = await advanceJob(job);
      if (advanced.status === "running" || advanced.status === "queued") {
        // chain the next stage; the status endpoint's watchdog re-fires
        // if this fetch is lost.
        await fetch(`${selfOrigin(req)}/api/route-job/step`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId, token: jobStepToken(jobId) }),
        }).catch(() => {});
        return;
      }
      if (advanced.status === "done" && advanced.email && !advanced.emailedAt) {
        const sent = await sendJobResultEmail(advanced);
        if (sent) {
          advanced.emailedAt = Date.now();
          await saveJob(advanced);
        }
      }
    })(),
  );
  return Response.json({ ok: true, stage: job.stage }, { status: 202 });
}
