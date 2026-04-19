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

function clientKey(req: Request): string {
  const h = req.headers.get("x-forwarded-for");
  if (h) return h.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

type CitySuggestion = {
  title: string;
  description: string;
  difficulty: "simple" | "medium" | "elaborate";
  iconic: boolean;
  /** Single Unicode emoji representing the shape. We render it to a canvas
   *  and extract a contour from the silhouette — so the suggestion is
   *  actually usable, not just inspiration text. Null when no suitable
   *  emoji exists (user falls back to Photo/Draw). */
  emoji: string | null;
};

function buildPrompt(
  cityLabel: string,
  cityRegion: string | undefined,
  gridBearings: number[] | undefined,
): string {
  const regionBit = cityRegion ? ` (${cityRegion})` : "";
  const gridBit = gridBearings?.length
    ? `The street grid runs roughly at ${gridBearings.join("°, ")}° from true north — so blocky shapes with orthogonal strokes snap cleanest.`
    : `This city does not have a strong street grid, so flowing / organic shapes work better than strict letters.`;

  return `You're helping a GPS-art designer pick shapes to trace as a walking route in ${cityLabel}${regionBit}.

Context:
- The shape will be drawn by walking city streets. Every stroke becomes a blocky staircase on real streets, so simpler geometric shapes and clear silhouettes read best.
- ${gridBit}
- The shape must be one continuous outline (one walking path).
- Typical routes are 5-20 km long.

Suggest exactly 5 shape ideas, ordered simple → elaborate. Include at least 1–2 iconic-to-${cityLabel} references (landmarks, symbols, local fauna, neighborhood silhouettes). For each:
- "title": 1-3 words
- "description": one short sentence saying what it is and why it fits ${cityLabel}
- "difficulty": "simple" | "medium" | "elaborate"
- "iconic": true if the shape is specifically ${cityLabel}/local, false if it's a universal shape
- "emoji": a single Unicode emoji that best represents the shape's silhouette (🗽 for Statue of Liberty, 🚕 for Taxi cab, 🌉 for Golden Gate Bridge, 🍎 for Apple, 🐟 for Fish, ❤️ for Heart, 🏠 for House, ⚡ for Lightning, 🐻 for Bear, 🚴 for Bicycle, etc.). This is critical — we render the emoji to produce the actual traceable shape. If no reasonable emoji exists for the concept, return null, but prefer to suggest a concept that HAS an emoji when possible.

Return ONLY a JSON array, no markdown fences, no other prose:
[{"title": "...", "description": "...", "difficulty": "simple", "iconic": true, "emoji": "🗽"}, ...]`;
}

const ALLOWED_DIFFICULTY = new Set(["simple", "medium", "elaborate"]);

export async function POST(req: Request) {
  if (!rateLimitAllow(`city-suggestions:${clientKey(req)}`, 30)) {
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
    cityLabel?: unknown;
    cityRegion?: unknown;
    gridBearings?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cityLabel =
    typeof body.cityLabel === "string" && body.cityLabel.trim().length > 0
      ? body.cityLabel.trim().slice(0, 64)
      : null;
  const cityRegion =
    typeof body.cityRegion === "string" && body.cityRegion.trim().length > 0
      ? body.cityRegion.trim().slice(0, 64)
      : undefined;
  const gridBearings = Array.isArray(body.gridBearings)
    ? body.gridBearings
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .slice(0, 4)
    : undefined;

  if (!cityLabel) {
    return NextResponse.json(
      { error: "cityLabel is required" },
      { status: 400 },
    );
  }

  try {
    const message = await client.messages.create({
      // Sonnet is plenty for text-only shape brainstorming.
      model: "claude-sonnet-4-6",
      max_tokens: 768,
      messages: [
        {
          role: "user",
          content: buildPrompt(cityLabel, cityRegion, gridBearings),
        },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    const raw =
      textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    console.log("[city-suggestions] raw response:", raw);

    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start < 0 || end <= start) {
      return NextResponse.json(
        { error: "No JSON array in response", raw },
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
    if (!Array.isArray(parsed)) {
      return NextResponse.json(
        { error: "Response is not an array", raw },
        { status: 502 },
      );
    }

    const suggestions: CitySuggestion[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Partial<CitySuggestion>;
      const title =
        typeof rec.title === "string" && rec.title.trim().length > 0
          ? rec.title.trim().slice(0, 60)
          : null;
      const description =
        typeof rec.description === "string" && rec.description.trim().length > 0
          ? rec.description.trim().slice(0, 240)
          : "";
      const difficulty =
        typeof rec.difficulty === "string" &&
        ALLOWED_DIFFICULTY.has(rec.difficulty)
          ? (rec.difficulty as CitySuggestion["difficulty"])
          : "medium";
      const iconic = rec.iconic === true;
      // Accept emoji strings of 1–8 chars (covers compound / skin-tone emoji).
      // Normalise whitespace, reject anything that looks like prose.
      const rawEmoji =
        typeof rec.emoji === "string" ? rec.emoji.trim() : "";
      const emoji =
        rawEmoji.length > 0 && rawEmoji.length <= 8 && !/\s/.test(rawEmoji)
          ? rawEmoji
          : null;
      if (!title) continue;
      suggestions.push({ title, description, difficulty, iconic, emoji });
      if (suggestions.length >= 5) break;
    }

    if (suggestions.length === 0) {
      return NextResponse.json(
        { error: "No valid suggestions", raw },
        { status: 502 },
      );
    }

    return NextResponse.json({ city: cityLabel, suggestions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
