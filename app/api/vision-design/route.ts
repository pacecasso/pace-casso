import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { rateLimitAllow } from "../../../lib/mapboxRateLimit";

export const runtime = "nodejs";
export const maxDuration = 120;

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
const MAX_POINTS = 48;
const MAX_DRAFTS = 8;

type NormalizedPoint = { x: number; y: number };
type DesignDraft = {
  label: string;
  description: string;
  visualFeatures?: string[];
  points: NormalizedPoint[];
};

function clientKey(req: Request): string {
  const h = req.headers.get("x-forwarded-for");
  if (h) return h.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function buildPrompt(cityLabel: string | null, draftCount: number): string {
  const city = cityLabel || "a dense city";
  const multiple = draftCount > 1;
  return `Convert this image into ${multiple ? `${draftCount} different` : "a"} etch-a-sketch style one-line GPS-art design${multiple ? "s" : ""} for ${city}.

This is NOT image tracing. You are designing route intents that will be placed and snapped onto real ${city} streets. The runner should recognize the subject from the route alone — like an Etch A Sketch drawing, not a faithful logo reproduction.

Rules:
- Ignore backgrounds, badges, circles, shadows, and decorative fills unless they are the subject.
- Preserve only the 3-6 features that make the subject recognizable.
- Name those features in "visualFeatures" using simple nouns a route generator can use, such as block, loop, handle, cable, head, body, legs, tail, letters, window, connector.
- Redraw the subject as one continuous polyline, like a runner drawing it with GPS.
- Design for streets first. Use rectangles, stair-steps, loops, diagonals, strong corners, and long strokes a runner could plausibly make on city blocks.
- Exaggerate key readable features; drop tiny detail.
- The line should be symbolic when needed. A person should recognize the subject when viewing only the route.
- Prefer a neighborhood-scale runnable idea over a giant city mural. A strong 10-22 km simplification is better than a 35 km route that preserves more detail but looks messy. Up to ~25 km is fine when it clearly improves readability.
- Prefer a bold etch-a-sketch icon over a faithful contour. For example: a gas-pump logo should become pump block + hose curve + simplified person/headphones, not every hand/nozzle pixel; a face can become face outline + connected glasses + one mouth instead of tiny eyes.
- For internal features, use connected features that can share travel strokes. If literal disconnected details would require ugly connector jumps, replace them with a street-friendly symbol.
- If the subject is a wordmark or letters (for example LOVE), preserve reading order and major letter strokes. Use simple block-letter strokes and purposeful bridges between letters; do not trace the outside blob of filled text.
- If the subject is an animal or mascot (for example tiger/lion), preserve the big silhouette and 2-4 signature features such as head, back, tail, legs, mane/stripes. Do not chase fur, small facial marks, or texture.
- If the subject is a logo/icon with multiple objects (for example a gas pump plus person), make several feature-subset drafts: one aggressive simple version, one balanced version, and one fuller version. It is acceptable to drop optional objects if the remaining route reads better and runs cleaner.
- Avoid pretty fantasy curves that need empty space to work. Prefer the kind of blocky, slightly jagged route that would still read after snapping to ${city}'s streets.
- Coordinates must be normalized to the image box: x and y from 0 to 1.
- Use 8-40 points. Fewer, stronger points are better.
- Avoid self-crossing unless it is needed to move between features.
- Prefer an open route for complex scenes and icons; closed loops are fine for single silhouettes.
- Make the drafts meaningfully different: change simplification, emphasis, and route order. Do not return tiny variations of the same line.
- Favor designs that could survive being snapped to ${city} streets over designs that match the pixels exactly.
- Include at least one draft that is outline-only, one that emphasizes the most distinctive internal feature, and one that uses an alternate connected symbol if the literal details are too small.
- For logos with multiple objects, merge them into one readable route story. The runner should not draw every object separately; connectors should feel like part of the icon.
- Make at least two drafts aggressively simple enough to still read after being forced onto a rectangular street grid.
- The first draft should be your best map-realistic representation, not the closest trace.

Return ONLY JSON with this exact shape:
{
  "label": "short name",
  "description": "short explanation of what was preserved",
  "visualFeatures": ["block", "loop", "head"],
  "points": [{"x": 0.12, "y": 0.84}, ...],
  "drafts": [
    {
      "label": "short name",
      "description": "what this draft emphasizes",
      "visualFeatures": ["block", "loop", "head"],
      "points": [{"x": 0.12, "y": 0.84}, ...]
    }
  ]
}

For a single-sketch request, "points" should match the best draft. For a multi-draft request, "drafts" must contain exactly ${draftCount} usable drafts and "points" should match draft #1.

No markdown. No extra keys.`;
}

function parseImageBase64(imageBase64: string, fallbackMediaType = "image/png"): {
  data: string;
  mediaType: string;
} {
  if (imageBase64.startsWith("data:")) {
    const comma = imageBase64.indexOf(",");
    if (comma !== -1) {
      const mediaType =
        imageBase64.slice(0, comma).split(":")[1]?.split(";")[0] ??
        "image/png";
      return { data: imageBase64.slice(comma + 1), mediaType };
    }
  }
  return { data: imageBase64, mediaType: fallbackMediaType };
}

function validPoint(v: unknown): NormalizedPoint | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r.x !== "number" ||
    typeof r.y !== "number" ||
    !Number.isFinite(r.x) ||
    !Number.isFinite(r.y)
  ) {
    return null;
  }
  return {
    x: Math.max(0, Math.min(1, r.x)),
    y: Math.max(0, Math.min(1, r.y)),
  };
}

function cleanPoints(raw: unknown): NormalizedPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedPoint[] = [];
  for (const item of raw) {
    const p = validPoint(item);
    if (!p) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 0.006) continue;
    out.push(p);
    if (out.length >= MAX_POINTS) break;
  }
  return out;
}

function cleanVisualFeatures(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().slice(0, 40))
    .slice(0, 8);
  return out.length > 0 ? out : undefined;
}

function cleanDraft(raw: unknown, fallbackLabel: string): DesignDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const points = cleanPoints(rec.points);
  if (points.length < 2) return null;
  return {
    label:
      typeof rec.label === "string" && rec.label.trim()
        ? rec.label.trim().slice(0, 40)
        : fallbackLabel,
    description:
      typeof rec.description === "string" && rec.description.trim()
        ? rec.description.trim().slice(0, 180)
        : "Street-friendly one-line GPS-art sketch.",
    visualFeatures: cleanVisualFeatures(rec.visualFeatures),
    points,
  };
}

function cleanDrafts(rec: Record<string, unknown>, fallback: DesignDraft): DesignDraft[] {
  const out: DesignDraft[] = [];
  if (Array.isArray(rec.drafts)) {
    for (const item of rec.drafts) {
      const draft = cleanDraft(item, `Draft ${out.length + 1}`);
      if (!draft) continue;
      out.push(draft);
      if (out.length >= MAX_DRAFTS) break;
    }
  }
  if (out.length === 0) out.push(fallback);
  return out;
}

export async function POST(req: Request) {
  if (!rateLimitAllow(`vision-design:${clientKey(req)}`, 20)) {
    return NextResponse.json({ error: "Rate limit" }, { status: 429 });
  }
  const client = getClient();
  if (!client) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured on server" },
      { status: 503 },
    );
  }

  let body: {
    imageBase64?: unknown;
    mediaType?: unknown;
    cityLabel?: unknown;
    draftCount?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawImage =
    typeof body.imageBase64 === "string" ? body.imageBase64 : null;
  if (!rawImage) {
    return NextResponse.json(
      { error: "imageBase64 is required" },
      { status: 400 },
    );
  }

  const fallbackMediaType =
    typeof body.mediaType === "string" && ALLOWED_MEDIA.has(body.mediaType)
      ? body.mediaType
      : "image/png";
  const parsed = parseImageBase64(rawImage, fallbackMediaType);
  const mediaType = ALLOWED_MEDIA.has(parsed.mediaType)
    ? parsed.mediaType
    : "image/png";
  if (parsed.data.length > MAX_B64) {
    return NextResponse.json({ error: "Image too large" }, { status: 413 });
  }

  const cityLabel =
    typeof body.cityLabel === "string" && body.cityLabel.trim().length > 0
      ? body.cityLabel.trim().slice(0, 80)
      : null;
  const draftCount =
    typeof body.draftCount === "number" && Number.isFinite(body.draftCount)
      ? Math.max(1, Math.min(MAX_DRAFTS, Math.floor(body.draftCount)))
      : 1;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3800,
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
                data: parsed.data,
              },
            },
            { type: "text", text: buildPrompt(cityLabel, draftCount) },
          ],
        },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const raw =
      textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return NextResponse.json(
        { error: "No JSON object in response", raw },
        { status: 502 },
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON in response", raw },
        { status: 502 },
      );
    }
    if (!parsedJson || typeof parsedJson !== "object") {
      return NextResponse.json(
        { error: "Response is not an object", raw },
        { status: 502 },
      );
    }
    const rec = parsedJson as Record<string, unknown>;
    const points = cleanPoints(rec.points);
    if (points.length < 2) {
      return NextResponse.json(
        { error: "Response did not contain enough valid points", raw },
        { status: 502 },
      );
    }

    const fallbackDraft: DesignDraft = {
      label:
        typeof rec.label === "string" && rec.label.trim()
          ? rec.label.trim().slice(0, 40)
          : "AI sketch",
      description:
        typeof rec.description === "string" && rec.description.trim()
          ? rec.description.trim().slice(0, 160)
          : "Simplified one-line GPS-art sketch.",
      visualFeatures: cleanVisualFeatures(rec.visualFeatures),
      points,
    };
    const drafts = cleanDrafts(rec, fallbackDraft);

    return NextResponse.json({
      ...fallbackDraft,
      drafts,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
