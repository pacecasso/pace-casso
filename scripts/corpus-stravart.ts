/**
 * corpus-stravart.ts — collect the curated strav.art gallery for study.
 *
 * strav.art is a hand-curated gallery of GPS art (~3,300 pieces) sorted into
 * subject categories. Its public sitemap lists every gallery image with a
 * title, a caption naming the athlete, the activity type and date, and a link
 * to the Strava activity. This script parses the sitemap, keeps the canonical
 * /home/<category> gallery pages, and downloads each image once.
 *
 * ZERO model calls. Internal study material only: the art belongs to the
 * athletes who made it and is never redistributed or shown on the site.
 *
 *   npx tsx scripts/corpus-stravart.ts [--out=tmp-corpus/stravart] [--max=5000]
 */
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const OUT = args.out ?? "tmp-corpus/stravart";
const MAX = Number(args.max ?? 5000);
const SITEMAP = "https://www.strav.art/sitemap.xml";
const UA = "Mozilla/5.0 (pacecasso study corpus)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

type Row = {
  file: string;
  category: string;
  title: string;
  caption: string;
  subject_hint: string;
  activity_type: string | null;
  activity_date: string | null;
  strava_activity: string | null;
  image_url: string;
};

/** "Bear-2023-03-25-at-15.05.29.png" -> "bear"; generic names -> "". */
function subjectHint(url: string): string {
  const base = decodeURIComponent(url.split("/").pop() ?? "").replace(/\.[a-z]+$/i, "");
  const word = base
    .replace(/[-_ ]?\d{4}-\d{2}-\d{2}.*$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
  if (!word || /^(image asset|img|image|screenshot|photo|untitled|\d+x\d+|[0-9a-f-]{20,})/.test(word)) return "";
  return word;
}

async function main() {
  fs.mkdirSync(path.join(OUT, "images"), { recursive: true });
  const xml = await (await fetch(SITEMAP, { headers: { "User-Agent": UA } })).text();

  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>(.*?)<\/loc>/)?.[1] ?? "";
    const cat = loc.match(/strav\.art\/home\/([a-z-]+)$/)?.[1];
    if (!cat) continue;
    for (const im of m[1].matchAll(/<image:image>([\s\S]*?)<\/image:image>/g)) {
      const url = im[1].match(/<image:loc>(.*?)<\/image:loc>/)?.[1];
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = decode(im[1].match(/<image:title>([\s\S]*?)<\/image:title>/)?.[1] ?? "");
      const caption = decode(im[1].match(/<image:caption>([\s\S]*?)<\/image:caption>/)?.[1] ?? "");
      const act = caption.match(/\b(Run|Ride|Walk|Hike|Swim|Ski|E-Bike Ride|Virtual Ride)\s+(\d{2}\/\d{2}\/\d{2,4})/i);
      const ext = (url.match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "jpg").toLowerCase().replace("jpeg", "jpg");
      rows.push({
        file: `${cat}-${String(rows.length).padStart(4, "0")}.${ext}`,
        category: cat,
        title,
        caption,
        subject_hint: subjectHint(url),
        activity_type: act ? act[1] : null,
        activity_date: act ? act[2] : null,
        strava_activity: caption.match(/https:\/\/www\.strava\.com\/activities\/\d+/)?.[0] ?? null,
        image_url: url,
      });
    }
  }
  console.log(`gallery images in sitemap: ${rows.length}`);

  let downloaded = 0;
  let present = 0;
  let failed = 0;
  const kept: Row[] = [];
  for (const r of rows.slice(0, MAX)) {
    const dest = path.join(OUT, "images", r.file);
    if (fs.existsSync(dest)) {
      present++;
      kept.push(r);
      continue;
    }
    try {
      // Squarespace serves a bounded size with ?format=; 1000w keeps detail and disk small.
      const res = await fetch(`${r.image_url}?format=1000w`, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      downloaded++;
      kept.push(r);
      if (downloaded % 250 === 0) console.log(`  downloaded ${downloaded} (failed ${failed})`);
      await sleep(120);
    } catch {
      failed++;
    }
  }

  fs.writeFileSync(path.join(OUT, "pieces.jsonl"), kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const byCat: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const r of kept) {
    byCat[r.category] = (byCat[r.category] ?? 0) + 1;
    const t = r.activity_type ?? "unknown";
    byType[t] = (byType[t] ?? 0) + 1;
  }
  const summary = {
    collected: new Date().toISOString(),
    source: SITEMAP,
    pieces: kept.length,
    downloaded,
    already_present: present,
    failed,
    with_strava_link: kept.filter((r) => r.strava_activity).length,
    with_subject_hint: kept.filter((r) => r.subject_hint).length,
    by_category: byCat,
    by_activity_type: byType,
    model_calls: 0,
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
