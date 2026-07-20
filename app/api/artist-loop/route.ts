import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import { runArtistLoop } from "../../../lib/artistLoopServer";

export const runtime = "nodejs";
// The full loop (designer rounds + blind judges + lattice compile) runs for
// minutes, not seconds — take the whole Fluid Compute allowance.
export const maxDuration = 300;

const ALLOWED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const);
type AllowedMedia = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const MAX_B64 = 4_000_000;

function parseImageBase64(
  imageBase64: string,
  fallbackMediaType: AllowedMedia = "image/png",
): { data: string; mediaType: AllowedMedia } {
  if (imageBase64.startsWith("data:")) {
    const comma = imageBase64.indexOf(",");
    if (comma !== -1) {
      const mediaType = imageBase64.slice(0, comma).split(":")[1]?.split(";")[0] ?? "image/png";
      return {
        data: imageBase64.slice(comma + 1),
        mediaType: ALLOWED_MEDIA.has(mediaType as AllowedMedia)
          ? (mediaType as AllowedMedia)
          : "image/png",
      };
    }
  }
  return { data: imageBase64, mediaType: fallbackMediaType };
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Server-side artist loop: interpret the uploaded image → place at legible
 * scale on the uniform Manhattan grid → compile onto real street junctions →
 * blind-judge the result → redraw until strangers recognize it (or the time
 * budget runs out). Streams NDJSON progress lines, then a final
 * `{type:"result"}` or `{type:"error"}` line.
 */
export async function POST(req: Request) {
  const shield = shieldExpensiveRoute(req, "artist-loop", 60);
  if (!shield.ok) return jsonError(shield.message, shield.status);
  // Each run is many Anthropic calls — keep the per-IP window tight.
  if (!rateLimitAllow(`artist-loop:${trustedClientIp(req)}`, 4)) {
    return jsonError("Rate limit", 429);
  }
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    return jsonError("ANTHROPIC_API_KEY not configured on server", 503);
  }

  let body: {
    imageBase64?: unknown;
    mediaType?: unknown;
    cityId?: unknown;
    cityLabel?: unknown;
    sourceName?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  const rawImage = typeof body.imageBase64 === "string" ? body.imageBase64 : null;
  if (!rawImage) return jsonError("imageBase64 is required", 400);

  // The lattice compiler and the 119°/29° placement frame are Manhattan
  // facts — refuse other cities instead of producing garbage there.
  const cityId = typeof body.cityId === "string" ? body.cityId : "manhattan";
  if (cityId !== "manhattan") {
    return jsonError("The artist route path currently supports Manhattan only", 400);
  }
  const cityLabel =
    typeof body.cityLabel === "string" && body.cityLabel.trim()
      ? body.cityLabel.trim().slice(0, 80)
      : "Manhattan";
  const sourceName =
    typeof body.sourceName === "string" ? body.sourceName.slice(0, 120) : null;

  const fallbackMediaType = ALLOWED_MEDIA.has(body.mediaType as AllowedMedia)
    ? (body.mediaType as AllowedMedia)
    : "image/png";
  const parsed = parseImageBase64(rawImage, fallbackMediaType);
  if (parsed.data.length > MAX_B64) return jsonError("Image too large", 413);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          /* client went away — let the loop finish or fail on its own */
        }
      };
      try {
        const result = await runArtistLoop({
          imageBase64: parsed.data,
          mediaType: parsed.mediaType,
          cityLabel,
          sourceName,
          onProgress: (p) => send({ type: "progress", ...p }),
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
      // Defeat proxy buffering so progress lines arrive as they happen.
      "X-Accel-Buffering": "no",
    },
  });
}
