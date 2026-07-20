import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import {
  traceShapeOnStreets,
  type NormalizedPoint,
} from "../../../lib/streetGraphTrace";

export const runtime = "nodejs";
// Pure CPU on the cached street graph — a request runs a placement sweep +
// corridor A* traces, typically ~10 s.
export const maxDuration = 120;

const MAX_POINTS = 600;

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

/**
 * Etch-a-sketch street tracing: find where Manhattan's real street graph
 * best draws the uploaded shape, and trace it there. No external API spend —
 * the graph ships with the app.
 */
export async function POST(req: Request) {
  // No paid API behind this route, but it burns server CPU — same-origin
  // gate plus a generous budget.
  const shield = shieldExpensiveRoute(req, "street-trace", 600);
  if (!shield.ok) {
    return Response.json({ error: shield.message }, { status: shield.status });
  }
  if (!rateLimitAllow(`street-trace:${trustedClientIp(req)}`, 12)) {
    return Response.json({ error: "Rate limit" }, { status: 429 });
  }

  let body: { contour?: unknown; cityId?: unknown; targetDistanceKm?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cityId = typeof body.cityId === "string" ? body.cityId : "manhattan";
  if (cityId !== "manhattan") {
    return Response.json(
      { error: "Street tracing currently supports Manhattan only" },
      { status: 400 },
    );
  }
  const contour = cleanContour(body.contour);
  if (contour.length < 8) {
    return Response.json({ error: "contour too short" }, { status: 400 });
  }
  const targetDistanceKm =
    typeof body.targetDistanceKm === "number" && Number.isFinite(body.targetDistanceKm)
      ? body.targetDistanceKm
      : undefined;

  try {
    const candidates = await traceShapeOnStreets(contour, {
      topK: 3,
      targetDistanceKm,
    });
    return Response.json({
      candidates: candidates.map((c) => ({
        chain: c.chain,
        km: c.km,
        meanDeviationM: c.meanDeviationM,
        center: c.center,
        scaleM: c.scaleM,
        rotDeg: c.rotDeg,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
