import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import {
  buildInterpretationPrompt,
  MAX_SKETCH_POINTS,
} from "../../../lib/interpretationPrompt";
import { reviewStreetDesignSketch } from "../../../lib/streetDesignSketch";

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
// Detail-density grammar (July 2026): dense curve sampling and texture
// strokes need real point budgets — 48 points forced minimal icons.
const MAX_POINTS = MAX_SKETCH_POINTS;
const MAX_DRAFTS = 8;

type NormalizedPoint = { x: number; y: number };
type DesignDraft = {
  label: string;
  description: string;
  visualFeatures?: string[];
  points: NormalizedPoint[];
};



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
  const shield = shieldExpensiveRoute(req, "vision-design", 400);
  if (!shield.ok) {
    return NextResponse.json({ error: shield.message }, { status: shield.status });
  }
  if (!rateLimitAllow(`vision-design:${trustedClientIp(req)}`, 20)) {
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

  const generate = async (
    extraGuidance: string,
  ): Promise<
    | { ok: true; fallbackDraft: DesignDraft; drafts: DesignDraft[] }
    | { ok: false; error: string; raw?: string }
  > => {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16000,
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
            {
              type: "text",
              text:
                buildInterpretationPrompt(cityLabel, draftCount) +
                extraGuidance,
            },
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
      return { ok: false, error: "No JSON object in response", raw };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return { ok: false, error: "Invalid JSON in response", raw };
    }
    if (!parsedJson || typeof parsedJson !== "object") {
      return { ok: false, error: "Response is not an object", raw };
    }
    const rec = parsedJson as Record<string, unknown>;
    const points = cleanPoints(rec.points);
    if (points.length < 2) {
      return {
        ok: false,
        error: "Response did not contain enough valid points",
        raw,
      };
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
    return { ok: true, fallbackDraft, drafts: cleanDrafts(rec, fallbackDraft) };
  };

  const passCount = (drafts: DesignDraft[]) =>
    drafts.filter((d) => reviewStreetDesignSketch(d.points).pass).length;

  try {
    const first = await generate("");
    if (!first.ok) {
      return NextResponse.json(
        { error: first.error, raw: first.raw },
        { status: 502 },
      );
    }
    let best = first;
    // Draft quality varies run to run; tangled generations are the top cause
    // of unusable routes downstream. If too few drafts survive the sketch
    // gate, retry once with targeted anti-tangle feedback and keep the
    // better generation.
    const wanted = Math.min(2, draftCount);
    if (passCount(first.drafts) < wanted) {
      const retry = await generate(
        "\n\nIMPORTANT — your previous attempt produced tangled lines that failed review. This time: never overlap two circles (use the combined-dome rule); a coil is ONE loop only; keep every stroke's entry and exit tangents flowing in the direction of travel; do not cut across anything you already drew; prefer fewer, cleaner features over more, messier ones.",
      );
      if (retry.ok && passCount(retry.drafts) > passCount(first.drafts)) {
        best = retry;
      }
    }

    // Serve gate-passing drafts first so downstream budget goes to the
    // usable ones.
    const sorted = [...best.drafts].sort(
      (a, b) =>
        Number(reviewStreetDesignSketch(b.points).pass) -
        Number(reviewStreetDesignSketch(a.points).pass),
    );
    return NextResponse.json({
      ...best.fallbackDraft,
      drafts: sorted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
