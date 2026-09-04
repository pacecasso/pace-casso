import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import { runPaint } from "../../../lib/strokePainterServer";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * The instant first draft: the stroke painter seats the upload as a filled
 * silhouette on real streets in under a minute with no Mapbox or model
 * spend. Streams NDJSON progress lines (same protocol as studio-route).
 * Core logic lives in lib/strokePainterServer so the async route-job
 * runner shares it.
 */
export async function POST(req: Request) {
  const shield = shieldExpensiveRoute(req, "paint-route", 600);
  if (!shield.ok) {
    return Response.json({ error: shield.message }, { status: shield.status });
  }
  if (!rateLimitAllow(`paint-route:${trustedClientIp(req)}`, 12)) {
    return Response.json({ error: "Rate limit" }, { status: 429 });
  }
  let body: { contour?: unknown; cityId?: unknown; imageBase64?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const cityId = typeof body.cityId === "string" ? body.cityId : "manhattan";
  if (cityId !== "manhattan") {
    return Response.json({ ok: false, reason: "manhattan-only" });
  }

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
        const result = await runPaint(body, (detail) => send({ type: "progress", detail }));
        send({ type: "result", result });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
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
