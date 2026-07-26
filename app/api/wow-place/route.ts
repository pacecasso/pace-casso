import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import { runWowPlacement } from "../../../lib/wowPlaceServer";
import type { NormalizedPoint } from "../../../lib/streetGraphTrace";

export const runtime = "nodejs";
// Placement sweep (pure CPU) + ~13 vision calls; comfortably under 300 s but
// well over a default timeout — take the Fluid Compute allowance.
export const maxDuration = 300;

const MAX_POINTS = 600;

function cleanContour(raw: unknown): NormalizedPoint[] | null {
  if (!Array.isArray(raw)) return null;
  const pts: NormalizedPoint[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const x = (p as { x?: unknown }).x;
    const y = (p as { y?: unknown }).y;
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
    if (pts.length >= MAX_POINTS) break;
  }
  return pts.length >= 8 ? pts : null;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Verified placement funnel (WOW.md): name the subject from the approved
 * sketch, sweep placements on the real street graph, screen the tightest
 * fits with the primed vision judge, return only picks that clear the bar —
 * or an honest explanation of why none did. Streams NDJSON progress lines,
 * then `{type:"result"}` or `{type:"error"}`.
 */
export async function POST(req: Request) {
  const shield = shieldExpensiveRoute(req, "wow-place", 300);
  if (!shield.ok) return jsonError(shield.message, shield.status);
  // ~13 Anthropic vision calls per run — keep the per-IP window tight.
  if (!rateLimitAllow(`wow-place:${trustedClientIp(req)}`, 4)) {
    return jsonError("Rate limit", 429);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return jsonError("ANTHROPIC_API_KEY not configured on server", 503);

  let body: { contour?: unknown; cityId?: unknown; targetDistanceKm?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  // The walk graph and placement centers are Manhattan facts — refuse other
  // cities instead of producing garbage there (same gate as artist-loop).
  const cityId = typeof body.cityId === "string" ? body.cityId : "manhattan";
  if (cityId !== "manhattan") {
    return jsonError("Verified placement currently supports Manhattan only", 400);
  }

  const contour = cleanContour(body.contour);
  if (!contour) return jsonError("contour must be >= 8 normalized points", 400);
  const targetDistanceKm =
    typeof body.targetDistanceKm === "number" &&
    Number.isFinite(body.targetDistanceKm) &&
    body.targetDistanceKm >= 3 &&
    body.targetDistanceKm <= 45
      ? body.targetDistanceKm
      : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          /* client went away */
        }
      };
      try {
        const result = await runWowPlacement({
          apiKey,
          contour,
          targetDistanceKm,
          onProgress: (detail) => send({ type: "progress", detail }),
        });
        send({ type: "result", result });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
