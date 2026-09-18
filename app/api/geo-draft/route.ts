import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import { getStreetGraph, type NormalizedPoint } from "../../../lib/streetGraphTrace";
import { filledMaskFromContour, type PainterGraph } from "../../../lib/strokePainter";
import { CENTRAL_PARK, geoDraft, MANHATTAN_GEO_DEFAULTS } from "../../../lib/geoDraft";
import { loadMask } from "../../../lib/geoMask";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * The first draft, the way Ralph's approved Sep 12 gas route was made: the
 * upload's strokes are tried at every near-upright seat in the Manhattan
 * core, scored by render-and-compare likeness to the upload, and the best
 * seats are polished by small edits. Zero model calls, zero Mapbox calls.
 * Streams NDJSON progress lines (same protocol as paint-route).
 */
export async function POST(req: Request) {
  const shield = shieldExpensiveRoute(req, "geo-draft", 600);
  if (!shield.ok) {
    return Response.json({ error: shield.message }, { status: shield.status });
  }
  if (!rateLimitAllow(`geo-draft:${trustedClientIp(req)}`, 8)) {
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
        let masked: { mask: Uint8Array; w: number; h: number } | null = null;
        if (typeof body.imageBase64 === "string" && body.imageBase64.length > 100) {
          send({ type: "progress", detail: "Reading your image…" });
          const raw = body.imageBase64;
          const data = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
          try {
            masked = await loadMask(Buffer.from(data, "base64"), "auto");
          } catch {
            masked = null;
          }
        }
        if (!masked) {
          const contour = cleanContour(body.contour);
          if (contour.length >= 8) masked = filledMaskFromContour(contour, 320);
        }
        if (!masked) {
          send({ type: "result", result: { ok: false, reason: "no-shape" } });
          return;
        }
        const g = (await getStreetGraph()) as unknown as PainterGraph;
        const onProgress = (detail: string) => send({ type: "progress", detail });
        // Seat on the regular grid (Chelsea up to Harlem) and keep the drawing out of
        // Central Park: on the irregular downtown streets and the park's curving paths a
        // shape turns into a blob (Sep 18, Ralph's cat on his phone). Same cat here:
        // 18.3 km of mush -> 13.2 km with the ears readable.
        let result = await geoDraft(g, masked.mask, masked.w, masked.h, {
          ...MANHATTAN_GEO_DEFAULTS,
          bbox: [40.745, -74.01, 40.83, -73.92],
          avoid: [CENTRAL_PARK],
          sweepBudgetMs: 110_000,
          totalBudgetMs: 170_000,
          onProgress,
        });
        // A shape that cannot be seated there (very wide or very tall) still gets a route:
        // fall back to the whole island with the remaining time.
        if (!result.ok) {
          onProgress("Widening the search to the rest of the island…");
          result = await geoDraft(g, masked.mask, masked.w, masked.h, {
            ...MANHATTAN_GEO_DEFAULTS,
            sweepBudgetMs: 45_000,
            totalBudgetMs: 70_000,
            onProgress,
          });
        }
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

function cleanContour(raw: unknown): NormalizedPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedPoint[] = [];
  for (const p of raw) {
    const x = (p as { x?: unknown })?.x;
    const y = (p as { y?: unknown })?.y;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      out.push({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
      if (out.length >= 600) break;
    }
  }
  return out;
}
