import { cleanRoutes, dequeue, loadDrawJob, queuedIds, saveDrawJob, workerAuthorized } from "../../../../lib/drawJob";

export const runtime = "nodejs";
export const maxDuration = 30;

/** a claimed job with no result after this is handed out again */
const RECLAIM_MS = 60 * 60_000;

/**
 * The GPU worker's side of the queue (scripts/perceptual/worker.ts).
 * GET claims the oldest queued job and returns its image; POST stores the
 * routes. Both need DRAW_WORKER_SECRET as a bearer token.
 */
export async function GET(req: Request) {
  if (!workerAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  for (const id of await queuedIds()) {
    const job = await loadDrawJob(id);
    if (!job || job.status === "done" || job.status === "failed") {
      await dequeue(id);
      continue;
    }
    if (job.status === "running" && job.claimedAt && Date.now() - job.claimedAt < RECLAIM_MS) continue;
    job.status = "running";
    job.claimedAt = Date.now();
    await saveDrawJob(job);
    return Response.json({ job: { id: job.id, imageBase64: job.imageBase64 } });
  }
  return Response.json({ job: null });
}

export async function POST(req: Request) {
  if (!workerAuthorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body: { id?: unknown; routes?: unknown; subject?: unknown; error?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const job = await loadDrawJob(typeof body.id === "string" ? body.id : "");
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  const routes = cleanRoutes(body.routes);
  job.subject = typeof body.subject === "string" ? body.subject.slice(0, 120) : null;
  job.routes = routes;
  job.status = routes.length ? "done" : "failed";
  job.error = routes.length ? null : typeof body.error === "string" ? body.error.slice(0, 300) : "No route found.";
  // the upload is only needed by the worker; do not keep it
  job.imageBase64 = null;
  await saveDrawJob(job);
  await dequeue(job.id);
  if (job.email) await sendDrawEmail(job.email, job.id, routes.length > 0);
  return Response.json({ ok: true, routes: routes.length });
}

async function sendDrawEmail(to: string, id: string, found: boolean): Promise<void> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return;
  const from = process.env.RESEND_FROM?.trim() || "PaceCasso <onboarding@resend.dev>";
  const link = `https://www.pacecasso.com/draw?job=${id}`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: found ? "Your PaceCasso routes are ready" : "Your PaceCasso drawing - no route this time",
        html: found
          ? `<p>Your drawing is on the map. Pick the one you like and download the GPX.</p><p><a href="${link}">See your routes</a></p>`
          : `<p>We could not fit this image onto the streets. Bold, simple shapes work best.</p><p><a href="${link}">Details</a></p>`,
      }),
    });
  } catch {
    /* the result also waits on the page */
  }
}
