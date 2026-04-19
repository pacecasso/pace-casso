import { NextResponse } from "next/server";
import { getServerMapboxToken } from "../../../../lib/mapboxServerToken";
import { rateLimitAllow } from "../../../../lib/mapboxRateLimit";

export const runtime = "nodejs";

function clientKey(req: Request): string {
  const h = req.headers.get("x-forwarded-for");
  if (h) return h.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

const ALLOWED_STYLES = new Set(["light-v11", "streets-v12", "outdoors-v12"]);
const DEFAULT_STYLE = "light-v11";

/**
 * GET /api/mapbox/static-map?encoded=<polyline>&size=<px>&style=<id>
 *
 * Returns a PNG of a map with the route drawn as a red path overlay, auto-fit
 * to the route's extent. Uses the server Mapbox token so the client never sees
 * it. Used by the top-5 preview tiles and the composite vision grid.
 */
export async function GET(req: Request) {
  if (!rateLimitAllow(`static:${clientKey(req)}`, 240)) {
    return NextResponse.json({ error: "Rate limit" }, { status: 429 });
  }
  const token = getServerMapboxToken();
  if (!token) {
    return NextResponse.json(
      { error: "Mapbox token not configured on server" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const encoded = url.searchParams.get("encoded");
  const sizeRaw = url.searchParams.get("size") ?? "256";
  const size = Math.max(64, Math.min(1024, parseInt(sizeRaw, 10) || 256));
  const styleRaw = url.searchParams.get("style") ?? DEFAULT_STYLE;
  const style = ALLOWED_STYLES.has(styleRaw) ? styleRaw : DEFAULT_STYLE;

  if (!encoded) {
    return NextResponse.json(
      { error: "`encoded` polyline is required" },
      { status: 400 },
    );
  }
  if (encoded.length > 6000) {
    return NextResponse.json(
      { error: "encoded polyline too long" },
      { status: 413 },
    );
  }

  // `path-{width}+{hexColor}(polyline)` — Mapbox escapes polyline chars itself;
  // we still need to URI-encode the whole overlay segment for URL safety.
  const path = `path-4+e60000(${encodeURIComponent(encoded)})`;
  const mapboxUrl = `https://api.mapbox.com/styles/v1/mapbox/${style}/static/${path}/auto/${size}x${size}?padding=12&access_token=${token}`;

  try {
    const res = await fetch(mapboxUrl);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `mapbox ${res.status}`, detail: detail.slice(0, 300) },
        { status: 502 },
      );
    }
    const contentType = res.headers.get("content-type") ?? "image/png";
    const body = await res.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        // Identical encoded+size+style inputs produce identical output, so the
        // browser + any CDN in front of this can safely cache for a while.
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
