import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import { interpretSketch } from "../../../lib/sketchInterpretServer";

export const runtime = "nodejs";
// Up to 4 draw/judge rounds (~17 vision calls worst case).
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
 * AI street-ready redraw: interpret the ORIGINAL upload as a bold one-line
 * drawing (the class of art that measurably survives street placement),
 * blind-judging every draft and returning only versions >= 2/3 strangers
 * recognized — or an honest refusal. City-independent (pure art step).
 * Streams NDJSON progress, then {type:"result"} / {type:"error"}.
 */
export async function POST(req: Request) {
  const shield = shieldExpensiveRoute(req, "interpret-sketch", 200);
  if (!shield.ok) return jsonError(shield.message, shield.status);
  // Each run is up to ~17 Anthropic calls — keep the per-IP window tight.
  if (!rateLimitAllow(`interpret-sketch:${trustedClientIp(req)}`, 4)) {
    return jsonError("Rate limit", 429);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return jsonError("ANTHROPIC_API_KEY not configured on server", 503);

  let body: { imageBase64?: unknown; mediaType?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError("Invalid JSON", 400);
  }
  const rawImage = typeof body.imageBase64 === "string" ? body.imageBase64 : null;
  if (!rawImage) return jsonError("imageBase64 is required", 400);
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
          /* client went away */
        }
      };
      try {
        const result = await interpretSketch({
          apiKey,
          imageBase64: parsed.data,
          mediaType: parsed.mediaType,
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
