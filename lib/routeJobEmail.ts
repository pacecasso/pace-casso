import type { RouteJob } from "./routeJobServer";

/**
 * Result notification via Resend's REST API (no SDK). Configured by
 * RESEND_API_KEY; RESEND_FROM overrides the sender once pacecasso.com is
 * domain-verified (until then Resend's onboarding sender only delivers to
 * the account owner's own address — fine for the current single-user
 * phase). Email failure never fails the job — the result also waits on
 * the site.
 */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export async function sendJobResultEmail(job: RouteJob): Promise<boolean> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key || !job.email) return false;
  const from = process.env.RESEND_FROM?.trim() || "PaceCasso <onboarding@resend.dev>";
  const link = `https://www.pacecasso.com/create?job=${job.id}`;
  const found = job.result && job.result.kind !== "none";
  const subject = found
    ? "Your PaceCasso route is ready"
    : "Your PaceCasso search finished — no route this time";
  const body = found
    ? `<p>Your route search finished — a route cleared the blind judges.</p>` +
      `<p><a href="${link}">Open your route</a> to review, tweak, and export it for your watch.</p>`
    : `<p>Your route search finished, but nothing cleared the judge's bar this time.</p>` +
      `<p>Bold, simple shapes work best. <a href="${link}">See the details</a> or try another image.</p>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [job.email], subject, html: body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
