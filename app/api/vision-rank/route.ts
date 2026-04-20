import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { rateLimitAllow } from "../../../lib/mapboxRateLimit";

export const runtime = "nodejs";
// Vision ranking calls can take 20-40s with adaptive thinking — bump the route timeout well past default.
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
/** ~4 MB base64 per image — 2 images per request. Current Anthropic per-image cap is ~5 MB. */
const MAX_B64 = 4_000_000;

function clientKey(req: Request): string {
  const h = req.headers.get("x-forwarded-for");
  if (h) return h.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

type UserHistoryEntry = {
  center: [number, number];
  rotationDeg: number;
  scale: number;
  distanceKm: number;
};

function buildPrompt(
  count: number,
  topK: number,
  userHistory: UserHistoryEntry[],
  cityLabel: string,
): string {
  const historyBlock =
    userHistory.length > 0
      ? `\n\n**Gentle user preference signal** (do NOT pick a visibly worse candidate just to match this — but when two candidates are close in quality, prefer the one that matches the user's past style):
This user has previously kept these placements after finishing the full workflow:
${userHistory
  .slice(0, 5)
  .map(
    (h, i) =>
      `${i + 1}. center≈[${h.center[0].toFixed(4)}, ${h.center[1].toFixed(4)}], scale≈${h.scale.toFixed(2)}×, rotation≈${Math.round(h.rotationDeg)}°, distance≈${h.distanceKm.toFixed(1)} km`,
  )
  .join("\n")}`
      : "";

  const city = cityLabel || "the selected city";

  return `You are seeing two images:
1. A grid of ${count} candidate GPS walking routes, numbered 1–${count} in the top-left of each tile. Each tile shows the route drawn in red on a real map of **${city}** — you can see streets (light gray), water (pale blue), and parks (pale green) underneath.
2. A reference image showing the target subject the route is trying to draw.

The route follows real ${city} streets, so every line is a blocky step-staircase that reflects that city's grid character (Manhattan's 29° skew, Brooklyn's mixed orientations, Chicago's strict north-south grid, San Francisco's hills, DC's diagonal avenues, etc.). Curves become jagged. Exact shape matching is impossible — treat them as etch-a-sketch interpretations of the subject at ${city}'s street scale. That is fine.

Rank by TWO things, in this priority order:

A) **Geographic plausibility in ${city}** — the route must sit on walkable streets **in ${city}**. IMMEDIATELY disqualify any candidate whose red line crosses water, sits mostly in a park or cemetery, hugs a shoreline in a way that doesn't match the subject, cuts across non-walkable infrastructure (rail yards, freeways, bridges-as-shortcuts), or has long straight segments jumping across non-street areas. A route that fails here should not appear in your top ${topK}, no matter how good the shape is.

B) **Shape recognizability** — among the geographically valid candidates, pick the ones where a person would most likely recognize the reference subject. Focus on gestalt: silhouette, proportions, distinctive features, correct orientation (not upside-down or mirrored in a way that breaks the subject). A shape that reads clearly against ${city}'s particular grid character is worth more than one that is geometrically closer to the reference but fights the street layout.${historyBlock}

Return ONLY a JSON array of exactly ${topK} objects ordered best-first:
[{"id": N, "reason": "short phrase"}]

In "reason", lead with why the candidate is geographically sound in ${city} ("solid grid placement", "all on ${city} streets", "walkable corridor") AND why the shape reads (e.g. "clear R silhouette", "apple proportions with stem"). No other text, no markdown code fences.`;
}

export async function POST(req: Request) {
  if (!rateLimitAllow(`vision-rank:${clientKey(req)}`, 20)) {
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
    gridImageBase64?: unknown;
    originalImageBase64?: unknown;
    originalMediaType?: unknown;
    count?: unknown;
    topK?: unknown;
    userHistory?: unknown;
    cityLabel?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const grid =
    typeof body.gridImageBase64 === "string" ? body.gridImageBase64 : null;
  const orig =
    typeof body.originalImageBase64 === "string"
      ? body.originalImageBase64
      : null;
  const origType =
    typeof body.originalMediaType === "string" &&
    ALLOWED_MEDIA.has(body.originalMediaType)
      ? body.originalMediaType
      : "image/png";
  const count =
    typeof body.count === "number" && Number.isFinite(body.count)
      ? Math.floor(body.count)
      : 0;
  const topK =
    typeof body.topK === "number" && Number.isFinite(body.topK)
      ? Math.floor(body.topK)
      : 5;
  const cityLabel =
    typeof body.cityLabel === "string" && body.cityLabel.trim().length > 0
      ? body.cityLabel.trim().slice(0, 80)
      : "";

  // User's previously-finalized placements, if any. Validated loosely —
  // anything malformed is just dropped and the prompt proceeds without history.
  const userHistory: UserHistoryEntry[] = Array.isArray(body.userHistory)
    ? body.userHistory
        .filter((h): h is UserHistoryEntry => {
          if (!h || typeof h !== "object") return false;
          const r = h as Partial<UserHistoryEntry>;
          return (
            Array.isArray(r.center) &&
            r.center.length === 2 &&
            typeof r.center[0] === "number" &&
            Number.isFinite(r.center[0]) &&
            typeof r.center[1] === "number" &&
            Number.isFinite(r.center[1]) &&
            typeof r.rotationDeg === "number" &&
            Number.isFinite(r.rotationDeg) &&
            typeof r.scale === "number" &&
            Number.isFinite(r.scale) &&
            typeof r.distanceKm === "number" &&
            Number.isFinite(r.distanceKm)
          );
        })
        .slice(0, 5)
    : [];

  if (!grid || !orig) {
    return NextResponse.json(
      { error: "gridImageBase64 and originalImageBase64 are required" },
      { status: 400 },
    );
  }
  if (count < 2 || topK < 1 || topK > count) {
    return NextResponse.json(
      { error: "count >= 2 and 1 <= topK <= count required" },
      { status: 400 },
    );
  }
  if (grid.length > MAX_B64 || orig.length > MAX_B64) {
    return NextResponse.json({ error: "Image data too large" }, { status: 413 });
  }

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: grid,
              },
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: origType as
                  | "image/png"
                  | "image/jpeg"
                  | "image/gif"
                  | "image/webp",
                data: orig,
              },
            },
            {
              type: "text",
              text: buildPrompt(count, topK, userHistory, cityLabel),
            },
          ],
        },
      ],
    });

    // Dump the full message content so we can see thinking + text together.
    console.log(
      "[vision-rank] Claude message content blocks:",
      message.content.map((b) =>
        b.type === "text"
          ? { type: "text", text: b.text }
          : b.type === "thinking"
            ? { type: "thinking", chars: b.thinking?.length ?? 0 }
            : { type: b.type },
      ),
    );
    console.log("[vision-rank] usage:", message.usage, "stop_reason:", message.stop_reason);

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      console.warn("[vision-rank] no text block in response");
      return NextResponse.json(
        { error: "Model returned no text block" },
        { status: 502 },
      );
    }
    const raw = textBlock.text.trim();
    console.log("[vision-rank] raw text response:", raw);

    // Tolerate stray prose around the JSON — find the first [...] block.
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start < 0 || end <= start) {
      console.warn("[vision-rank] no JSON array delimiters in response");
      return NextResponse.json(
        { error: "No JSON array in response", raw },
        { status: 502 },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (parseErr) {
      console.warn("[vision-rank] JSON.parse failed:", parseErr);
      return NextResponse.json(
        { error: "Invalid JSON in response", raw },
        { status: 502 },
      );
    }
    if (!Array.isArray(parsed)) {
      console.warn("[vision-rank] parsed response is not an array:", parsed);
      return NextResponse.json(
        { error: "Response is not an array", raw },
        { status: 502 },
      );
    }

    const ranked: { id: number; reason: string }[] = [];
    const rejected: { raw: unknown; reason: string }[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        rejected.push({ raw: item, reason: "not an object" });
        continue;
      }
      const rec = item as { id?: unknown; reason?: unknown };
      const id = typeof rec.id === "number" ? rec.id : null;
      if (id == null || !Number.isFinite(id)) {
        rejected.push({ raw: item, reason: "id missing or non-finite" });
        continue;
      }
      if (id < 1 || id > count) {
        rejected.push({ raw: item, reason: `id ${id} out of range [1, ${count}]` });
        continue;
      }
      const reason = typeof rec.reason === "string" ? rec.reason : "";
      ranked.push({ id: Math.floor(id), reason });
    }
    console.log(
      `[vision-rank] accepted ${ranked.length}/${parsed.length} items (count was ${count}, topK was ${topK})`,
    );
    if (rejected.length > 0) {
      console.log("[vision-rank] rejected items:", rejected);
    }

    return NextResponse.json({ ranked });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
