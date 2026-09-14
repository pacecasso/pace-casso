/**
 * corpus-collect.ts — build a study corpus of posted GPS art.
 *
 * Pulls posts from the Arctic Shift Reddit archive (public, no auth), keeps
 * posts that carry an image, downloads the images, and writes one metadata
 * row per image. ZERO model calls: this is plain HTTP only.
 *
 * Internal study material only. The art belongs to the people who ran it;
 * nothing here is redistributed or shown on the site.
 *
 *   npx tsx scripts/corpus-collect.ts [--out=tmp-corpus] [--max-images=5000]
 *
 * Output: <out>/images/<postid>[_n].<ext>, <out>/posts.jsonl (one row per
 * image), <out>/summary.json. Re-runnable: already-downloaded files are skipped.
 */
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const OUT = args.out ?? "tmp-corpus";
const MAX_IMAGES = Number(args["max-images"] ?? 5000);
const API = "https://arctic-shift.photon-reddit.com/api/posts/search";

/** Dedicated GPS-art communities: take every image post. */
const ART_SUBS = ["STRAVAart", "gpsart", "GPSdrawing"];
/** Big sport communities: only posts whose title says it is GPS art. */
const SPORT_SUBS = ["Strava", "running", "cycling", "bicycling", "Garmin", "trailrunning", "bikecommuting"];
const TITLE_QUERIES = ["strava art", "gps art", "gps drawing"];

type Post = {
  id: string;
  subreddit: string;
  title: string;
  score: number;
  num_comments: number;
  created_utc: number;
  url?: string;
  permalink: string;
  is_gallery?: boolean;
  media_metadata?: Record<string, { status?: string; m?: string; s?: { u?: string } }>;
  gallery_data?: { items: { media_id: string }[] };
  preview?: { images?: { source?: { url?: string } }[] };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, tries = 6): Promise<{ data?: Post[]; error?: string }> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(5000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Post[]; error?: string };
      if (body.error) throw new Error(body.error);
      return body;
    } catch (e) {
      if (i === tries - 1) return { error: String(e) };
      await sleep(10000 * (i + 1));
    }
  }
  return { error: "rate limited" };
}

/** Page oldest-to-newest through one query until the archive runs out. */
async function pullAll(params: Record<string, string>): Promise<Post[]> {
  const out: Post[] = [];
  let after = "2010-01-01";
  for (;;) {
    const qs = new URLSearchParams({ ...params, limit: "100", sort: "asc", after });
    const { data, error } = await getJson(`${API}?${qs}`);
    if (error) {
      console.warn(`  stopped ${JSON.stringify(params)}: ${error}`);
      break;
    }
    if (!data || data.length === 0) break;
    out.push(...data);
    const last = data[data.length - 1].created_utc;
    if (String(last) === after) break;
    after = String(last);
    if (data.length < 100) break;
    await sleep(4000);
  }
  return out;
}

const unescape = (u: string) => u.replace(/&amp;/g, "&");

function imageUrls(p: Post): string[] {
  if (p.is_gallery && p.media_metadata && p.gallery_data) {
    return p.gallery_data.items
      .map((it) => p.media_metadata?.[it.media_id])
      .filter((m) => m && m.status === "valid" && m.s?.u)
      .map((m) => unescape(m!.s!.u!));
  }
  const u = p.url ?? "";
  if (/^https:\/\/(i\.redd\.it|i\.imgur\.com)\/.+\.(png|jpe?g|webp|gif)$/i.test(u)) return [u];
  const prev = p.preview?.images?.[0]?.source?.url;
  return prev ? [unescape(prev)] : [];
}

function extOf(url: string): string {
  const m = url.match(/\.(png|jpe?g|webp|gif)(\?|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}

async function main() {
  fs.mkdirSync(path.join(OUT, "images"), { recursive: true });
  const byId = new Map<string, Post>();

  for (const sub of ART_SUBS) {
    const posts = await pullAll({ subreddit: sub });
    console.log(`r/${sub}: ${posts.length} posts`);
    for (const p of posts) byId.set(p.id, p);
  }
  for (const sub of SPORT_SUBS) {
    for (const q of TITLE_QUERIES) {
      const posts = await pullAll({ subreddit: sub, title: q });
      console.log(`r/${sub} title "${q}": ${posts.length} posts`);
      for (const p of posts) byId.set(p.id, p);
    }
  }

  const posts = [...byId.values()].sort((a, b) => b.score - a.score);
  console.log(`unique posts: ${posts.length}`);

  const rows: string[] = [];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of posts) {
    if (downloaded + skipped >= MAX_IMAGES) break;
    const urls = imageUrls(p);
    for (let i = 0; i < urls.length; i++) {
      const file = `${p.id}${urls.length > 1 ? `_${i}` : ""}.${extOf(urls[i])}`;
      const dest = path.join(OUT, "images", file);
      if (fs.existsSync(dest)) {
        skipped++;
      } else {
        try {
          const res = await fetch(urls[i]);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
          downloaded++;
          await sleep(150);
        } catch {
          failed++;
          continue;
        }
      }
      rows.push(
        JSON.stringify({
          file,
          post_id: p.id,
          subreddit: p.subreddit,
          title: p.title,
          score: p.score,
          num_comments: p.num_comments,
          created: new Date(p.created_utc * 1000).toISOString().slice(0, 10),
          permalink: `https://www.reddit.com${p.permalink}`,
          image_url: urls[i],
          gallery_index: urls.length > 1 ? i : null,
        }),
      );
    }
    if ((downloaded + skipped) % 250 === 0 && downloaded > 0) {
      console.log(`  images so far: ${downloaded + skipped} (failed ${failed})`);
    }
  }

  fs.writeFileSync(path.join(OUT, "posts.jsonl"), rows.join("\n") + "\n");
  const summary = {
    collected: new Date().toISOString(),
    unique_posts: posts.length,
    image_rows: rows.length,
    downloaded,
    already_present: skipped,
    failed,
    by_subreddit: posts.reduce<Record<string, number>>((acc, p) => {
      acc[p.subreddit] = (acc[p.subreddit] ?? 0) + 1;
      return acc;
    }, {}),
    model_calls: 0,
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
