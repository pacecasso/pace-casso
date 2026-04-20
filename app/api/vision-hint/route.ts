import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { rateLimitAllow } from "../../../lib/mapboxRateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key });
  return _client;
}

const ALLOWED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_B64 = 4_000_000;

function clientKey(req: Request): string {
  const h = req.headers.get("x-forwarded-for");
  if (h) return h.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function buildPrompt(cityLabel: string | null): string {
  const cityLine = cityLabel
    ? `\n\nThe route will be placed in ${cityLabel}, so consider how the shape will read against that city's street layout when you pick the rotation strategy.\n`
    : "";
  return `Look at this image. It will be turned into a GPS art route — a walking path drawn on city streets.${cityLine}\n\n${PROMPT_BODY}`;
}

const PROMPT_BODY = `Classify it so we can generate better candidate placements. Return ONLY a JSON object with these exact keys, no other text, no markdown fences:

{
  "shapeClass": "letter" | "creature" | "geometric" | "abstract",
  "rotationStrategy": "upright" | "grid-aligned" | "flexible",
  "scaleHint": "compact" | "medium" | "sprawling",
  "reason": "short phrase (<= 10 words)"
}

Definitions:
- shapeClass:
  - letter: a letter, number, or text glyph (R, L, 8, LOVE)
  - creature: animal, person, or organic silhouette (tiger, face)
  - geometric: simple regular shape (star, heart, circle)
  - abstract: logo, doodle, or complex pattern that doesn't fit the above
- rotationStrategy:
  - upright: must be shown vertical / right-side up to be recognizable (letters, faces)
  - grid-aligned: strong orthogonal strokes that benefit from aligning with the city's street grid (geometric shapes, blocky letters)
  - flexible: works at many rotations (abstract, symmetric creatures)
- scaleHint:
  - compact: reads well at a small size (fine features, tight details)
  - medium: typical scale, fits comfortably in a single neighborhood
  - sprawling: bold silhouette that benefits from filling a bigger area

Pick one value per field. Prefer "upright" for clear letters. Prefer "grid-aligned" for simple orthogonal shapes.`;

export async function POST(req: Request) {
  if (!rateLimitAllow(`vision-hint:${clientKey(req)}`, 40)) {
    return NextResponse.json({ error: "Rate limit" }, { status: 429 });
  }
  const client = getClient();
  if (!client) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured on server" },
      { status: 503 },
    );
  }

  let body: { imageBase64?: unknown; mediaType?: unknown; cityLabel?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data =
    typeof body.imageBase64 === "string" ? body.imageBase64 : null;
  const mediaType =
    typeof body.mediaType === "string" && ALLOWED_MEDIA.has(body.mediaType)
      ? body.mediaType
      : "image/png";
  const cityLabel =
    typeof body.cityLabel === "string" && body.cityLabel.trim().length > 0
      ? body.cityLabel.trim().slice(0, 80)
      : null;

  if (!data) {
    return NextResponse.json(
      { error: "imageBase64 is required" },
      { status: 400 },
    );
  }
  if (data.length > MAX_B64) {
    return NextResponse.json({ error: "Image too large" }, { status: 413 });
  }

  try {
    const message = await client.messages.create({
      // Sonnet is plenty for a single classification call — faster + cheaper
      // than Opus and doesn't need adaptive thinking for this.
      model: "claude-sonnet-4-6",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as
                  | "image/png"
                  | "image/jpeg"
                  | "image/gif"
                  | "image/webp",
                data,
              },
            },
            { type: "text", text: buildPrompt(cityLabel) },
          ],
        },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const raw =
      textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    console.log("[vision-hint] raw:", raw);

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return NextResponse.json(
        { error: "No JSON object in response", raw },
        { status: 502 },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON in response", raw },
        { status: 502 },
      );
    }
    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json(
        { error: "Response is not an object", raw },
        { status: 502 },
      );
    }

    const rec = parsed as Record<string, unknown>;
    const shapeClass = validEnum(rec.shapeClass, [
      "letter",
      "creature",
      "geometric",
      "abstract",
    ]);
    const rotationStrategy = validEnum(rec.rotationStrategy, [
      "upright",
      "grid-aligned",
      "flexible",
    ]);
    const scaleHint = validEnum(rec.scaleHint, [
      "compact",
      "medium",
      "sprawling",
    ]);
    const reason = typeof rec.reason === "string" ? rec.reason : "";

    if (!shapeClass || !rotationStrategy || !scaleHint) {
      return NextResponse.json(
        { error: "Response missing required fields", raw },
        { status: 502 },
      );
    }

    console.log(
      `[vision-hint] classified: ${shapeClass} / ${rotationStrategy} / ${scaleHint} — "${reason}"`,
    );

    return NextResponse.json({
      shapeClass,
      rotationStrategy,
      scaleHint,
      reason,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

function validEnum<T extends string>(v: unknown, allowed: T[]): T | null {
  return typeof v === "string" && (allowed as string[]).includes(v)
    ? (v as T)
    : null;
}
