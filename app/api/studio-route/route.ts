import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import { runStudio } from "../../../lib/studioRouteServer";

export const runtime = "nodejs";
// Placement sweeps + judge calls; runStudio budgets itself well inside the
// platform's function limit.
export const maxDuration = 300;

/**
 * The studio lane: the offline pipeline that produced the verified route
 * batch, slimmed to fit a request. Dual-cadence street tracing at hero
 * scale, then a zero-context correct-name gate on the rendered route.
 * Streams NDJSON progress lines (same protocol as wow-place) so the UI
 * stays alive and proxies don't kill an idle connection. Returns
 * street-native chains — no Mapbox spend. Core logic lives in
 * lib/studioRouteServer so the async route-job runner shares it.
 */
export async function POST(req: Request) {
  const shield = shieldExpensiveRoute(req, "studio-route", 600);
  if (!shield.ok) {
    return Response.json({ error: shield.message }, { status: shield.status });
  }
  if (!rateLimitAllow(`studio-route:${trustedClientIp(req)}`, 8)) {
    return Response.json({ error: "Rate limit" }, { status: 429 });
  }
  let body: { contour?: unknown; cityId?: unknown; subject?: unknown; imageBase64?: unknown };
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
        const result = await runStudio(body, (detail) => send({ type: "progress", detail }));
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
