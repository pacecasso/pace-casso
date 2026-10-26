/**
 * Minimal Upstash Redis REST client (plain fetch, no SDK).
 *
 * Added Oct 26 when the Vercel Blob store stayed suspended for weeks after
 * the Sep 26 poll burned its Hobby operation allowance: job records and
 * the /draw queue move here whenever Redis is configured. The Vercel
 * Marketplace Upstash integration sets KV_REST_API_URL / KV_REST_API_TOKEN;
 * a direct Upstash database uses the UPSTASH_REDIS_REST_* names.
 */

function config(): { url: string; token: string } | null {
  const url = (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL)?.trim();
  const token = (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN)?.trim();
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

export function redisConfigured(): boolean {
  return config() !== null;
}

/** Run one Redis command, e.g. redis(["SET", "k", "v"]). Throws on a Redis error. */
export async function redis<T = unknown>(command: (string | number)[]): Promise<T> {
  const c = config();
  if (!c) throw new Error("Redis not configured");
  const res = await fetch(c.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command.map(String)),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok || body.error) throw new Error(`Redis ${command[0]}: ${body.error ?? res.status}`);
  return body.result as T;
}
