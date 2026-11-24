"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { pickIndex, rankDrawRoutes, routesScored, RUNNABLE_KM, sortDrawRoutes, type DrawSort } from "../lib/drawRouteSort";
import { formatDistance, formatDuration, useRunnerProfile } from "../lib/runnerProfile";
import { drawShareImage } from "../lib/shareImage";
import LineArtEditor, { type LineArtEditorHandle } from "./LineArtEditor";

const Step5PreviewMap = dynamic(() => import("./Step5PreviewMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[280px] w-full items-center justify-center rounded-xl border border-pace-line bg-pace-warm text-xs text-pace-muted">
      Loading map…
    </div>
  ),
});

/** score: the engine's 0..1 match with the drawing (jobs since Nov 9); the page sorts by it */
type Route = {
  km: number;
  points: [number, number][];
  label?: "pick" | "short" | "alt" | "mark" | "initials" | "letters";
  /** initials routes: the letters drawn under the picture; letters routes: the letters drawn on their own */
  text?: string;
  score?: number;
};

/** card titles for jobs from before Nov 9, which carry these labels and no score */
const LABEL_TEXT: Record<NonNullable<Route["label"]>, string> = {
  pick: "Our pick",
  short: "Under 25 km",
  alt: "Another take",
  mark: "Picture only",
  initials: "Picture and initials",
  letters: "Name only",
};
const SORT_TEXT: Record<DrawSort, string> = { best: "Best match", distance: "Distance" };
/**
 * One array for every render: the preview map refits its view whenever this
 * prop changes identity, so a fresh [] on each render threw away the runner's
 * zoom and pan every time the page re-rendered (e.g. on a sort click).
 */
const NO_ART: [number, number][] = [];
const COUNT_TEXT = ["One version", "Two versions", "Three versions", "Four versions", "Five versions"];
type Status = {
  status: "queued" | "running" | "done" | "failed";
  createdAt: number;
  /** what the worker read the picture as, e.g. "a cat seen in profile" */
  subject?: string | null;
  routes: Route[];
  /** what could not be offered, e.g. no version under 25 km */
  note?: string | null;
  error: string | null;
};

/**
 * A typed name as the worker letters it: capitals, digits and single spaces
 * (cleanWords in lib/drawJob.ts keeps "&" too, but the block letters have
 * none, so the worker drops it)
 */
const plainName = (s: string) =>
  s
    .toUpperCase()
    .replace(/&/g, "")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
/** one row of block capitals holds this many characters (ROW_CHARS in scripts/geometry/simplify.py) */
const NAME_ROW = 12;

/** matches MAX_IMAGE_B64 in app/api/draw-job/route.ts */
const MAX_IMAGE_B64 = 4_000_000;

/**
 * The job API never returns the upload, so the page keeps a small copy of
 * it in this browser to show beside the results (Oct 28 cold test: "no
 * picture of my original next to the routes"). Best effort: storage can
 * be blocked or full, and another device simply shows no picture.
 */
const THUMB_KEY = "pace-draw-upload:";
const THUMB_INDEX = "pace-draw-uploads";
const THUMB_KEEP = 5;

async function makeThumbnail(file: Blob): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 360 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * k));
    canvas.height = Math.max(1, Math.round(bmp.height * k));
    canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return canvas.toDataURL("image/webp", 0.85);
  } catch {
    return null;
  }
}

function saveThumbnail(jobId: string, dataUrl: string) {
  try {
    const ids = (JSON.parse(localStorage.getItem(THUMB_INDEX) ?? "[]") as string[]).filter((id) => id !== jobId);
    ids.push(jobId);
    while (ids.length > THUMB_KEEP) localStorage.removeItem(THUMB_KEY + ids.shift());
    localStorage.setItem(THUMB_KEY + jobId, dataUrl);
    localStorage.setItem(THUMB_INDEX, JSON.stringify(ids));
  } catch {
    // storage blocked or full: the results just show no picture
  }
}

function loadThumbnail(jobId: string): string | null {
  try {
    return localStorage.getItem(THUMB_KEY + jobId);
  } catch {
    return null;
  }
}

/**
 * The upload as sent to the worker for its line drawing: at most 1200 px on
 * white (as the worker composites transparent PNGs), PNG when it fits under
 * the API's limit, else JPEG (a large photo as PNG can run to 5+ MB).
 */
async function uploadCopy(file: Blob): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * k));
    canvas.height = Math.max(1, Math.round(bmp.height * k));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const png = canvas.toDataURL("image/png");
    return png.length <= MAX_IMAGE_B64 ? png : canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return null;
  }
}

/**
 * sketch job: the worker turns the upload into the simple line drawing to
 * touch up. Since Nov 11 it can send two (a detailed one and a bold one) and
 * the person picks; `url` is the drawing's data URL, for its thumbnail.
 */
type LineArt = { url: string; file: File };
type Sketch = {
  state: "working" | "ready" | "failed";
  lineArts: LineArt[];
  /** the name the worker read off the picture; it goes back with the touched-up drawing */
  words?: string | null;
  /** wording read off the picture that the drawing leaves out */
  left?: string | null;
};

/**
 * What the results are, from the labels actually shown: the Oct 31 blind
 * test read "the shorter one is for a run you can finish in a morning"
 * above a pick and an "Another take" that was LONGER than the pick.
 */
function resultsIntro(routes: Route[]): string {
  const count = COUNT_TEXT[routes.length - 1] ?? `${routes.length} versions`;
  const parts = [`${count}, each one continuous run on real streets.`];
  if (routesScored(routes)) {
    // since Nov 9: every size the engine fitted, ranked by its match score
    if (routes.length > 1) {
      const ranked = rankDrawRoutes(routes);
      const starIsBest = ranked.find((r) => r.rank === 0)?.index === pickIndex(ranked);
      parts.push(
        starIsBest
          ? "They are your drawing at different sizes: ★ is the one that looks most like your picture, and you can sort them by best match or by distance."
          : `They are your drawing at different sizes: ★ is our pick, the best match you can run in one go (under ${RUNNABLE_KM} km). "Best match" looks a little more like your picture but is a much longer run. You can sort them by best match or by distance.`,
      );
    }
    if (routes.some((r) => r.label === "mark")) {
      parts.push('"Picture only" is your picture without its words, which makes a shorter run.');
    }
    const lettered = routes.find((r) => r.label === "initials" && r.text);
    if (lettered) {
      parts.push(`A whole name needs a long run, so one shorter version has your picture with "${lettered.text}" under it.`);
    }
    const alone = routes.find((r) => r.label === "letters" && r.text);
    if (alone) {
      parts.push(
        lettered
          ? `Another is just "${alone.text}" in large letters.`
          : `A whole name needs a long run, so one shorter version is just "${alone.text}" in large letters.`,
      );
    }
    if (routes.every((r) => r.km > RUNNABLE_KM)) {
      // Nov 24 blind review: a 54 km star and nothing said about why there was no short one
      parts.push(
        `We could not make a version under ${RUNNABLE_KM} km that still reads: this drawing needs the longer distance. A drawing with fewer lines or a shorter name makes a shorter run.`,
      );
    }
    return parts.join(" ");
  }
  if (routes.length > 1) parts.push("Our pick ★ is the one we think looks most like your picture.");
  if (routes.some((r) => r.label === "short")) {
    parts.push(`"${LABEL_TEXT.short}" is a shorter run; for a logo with words it is the picture on its own.`);
  }
  if (routes.some((r) => r.label === "alt")) parts.push("Another take is the same drawing at a different size.");
  return parts.join(" ");
}

function gpxFor(route: Route, name: string): string {
  const pts = route.points.map(([lat, lng]) => `<trkpt lat="${lat}" lon="${lng}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

/** a card's title as part of a file name: "Match #3" -> "match-3" */
const fileSlug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * title: the card's title, so the file is named as the card is (Nov 24 review 6:
 * the card "Match #3" saved as "option-4").
 * Returns the file's name, which the card then shows: the browser saves it
 * without a word, and the Nov 11 reviewer could not tell the click had worked.
 */
function download(route: Route, title: string): string {
  const blob = new Blob([gpxFor(route, `PaceCasso ${title.toLowerCase()}`)], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pacecasso-${fileSlug(title)}-${route.km.toFixed(1)}km.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return a.download;
}

/** the share picture: the upload beside its route, saved as a PNG; returns the file's name, or null if it could not be made */
async function downloadShare(route: Route, title: string, picture: string | null, stats: string): Promise<string | null> {
  const blob = await drawShareImage(route.points, picture, stats).catch(() => null);
  if (!blob) return null;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pacecasso-${fileSlug(title)}-${route.km.toFixed(1)}km.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return a.download;
}

/**
 * Upload -> queued job -> up to five street routes. The search runs on the GPU
 * worker (scripts/perceptual/worker.ts) and takes minutes, so the page
 * polls and the job id lives in the URL: closing the tab loses nothing.
 */
export default function DrawFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const jobId = params.get("job");
  const [profile] = useRunnerProfile();
  const [file, setFile] = useState<File | null>(null);
  const editorRef = useRef<LineArtEditorHandle>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [uploadThumb, setUploadThumb] = useState<string | null>(null);
  const [sketch, setSketch] = useState<Sketch | null>(null);
  /** the name box at the touch-up step, and the name last sent for a redraw (null: letter what was read) */
  const [name, setName] = useState("");
  const [typed, setTyped] = useState<string | null>(null);
  /** which of the worker's drawings is in the editor */
  const [choice, setChoice] = useState(0);
  const [sort, setSort] = useState<DrawSort>("best");
  /** the file last saved (GPX or share picture), and the card (delivered index) it came from */
  const [saved, setSaved] = useState<{ index: number; name: string; kind: "gpx" | "picture" } | null>(null);

  useEffect(() => {
    setUploadThumb(jobId ? loadThumbnail(jobId) : null);
  }, [jobId]);

  // A new picture goes to the worker first, which turns it into a simple bold
  // line drawing (Ralph, Oct 31: picture -> line art -> touch up -> plot).
  // If that fails, the picture itself is shown to touch up, as before.
  useEffect(() => {
    if (!file) {
      setSketch(null);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSketch({ state: "working", lineArts: [] });
    setChoice(0);
    const fail = () => {
      if (!stop) setSketch({ state: "failed", lineArts: [] });
    };
    void (async () => {
      const imageBase64 = await uploadCopy(file);
      if (!imageBase64 || imageBase64.length > MAX_IMAGE_B64) return fail();
      const res = await fetch("/api/draw-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64, mode: "sketch", words: typed ?? undefined }),
      }).catch(() => null);
      const body = res?.ok ? ((await res.json()) as { jobId?: string }) : null;
      if (!body?.jobId) return fail();
      const started = Date.now();
      const tick = async () => {
        if (stop) return;
        const r = await fetch(`/api/draw-job?id=${body.jobId}`, { cache: "no-store" }).catch(() => null);
        const s = r?.ok
          ? ((await r.json()) as { status: Status["status"]; lineArt?: string | null; lineArts?: string[]; words?: string | null; left?: string | null })
          : null;
        if (stop) return;
        if (s?.status === "done" && s.lineArt) {
          // the drawing to show first leads the list; a site build from before Nov 11 sends no list
          const urls = s.lineArts?.length ? s.lineArts : [s.lineArt];
          const lineArts = await Promise.all(
            urls.map(async (url, i) => ({
              url,
              file: new File([await (await fetch(url)).blob()], `line-drawing-${i + 1}.png`, { type: "image/png" }),
            })),
          );
          if (!stop) {
            setSketch({ state: "ready", lineArts, words: s.words ?? null, left: s.left ?? null });
            setName(s.words ?? "");
          }
          return;
        }
        // the worker may be busy with another drawing; after 5 min show the picture instead
        if (s?.status === "failed" || Date.now() - started > 5 * 60_000) return fail();
        timer = setTimeout(tick, 3000);
      };
      void tick();
    })().catch(fail);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [file, typed]);

  const drawings = sketch?.state === "ready" ? sketch.lineArts : [];
  const editorFile =
    sketch?.state === "ready" ? (drawings[choice] ?? drawings[0])?.file ?? null : sketch?.state === "failed" ? file : null;

  const poll = useCallback(async (id: string) => {
    const res = await fetch(`/api/draw-job?id=${id}`, { cache: "no-store" });
    if (!res.ok) {
      setError(res.status === 404 ? "That drawing was not found." : "Could not check on your drawing.");
      return true;
    }
    const s = (await res.json()) as Status;
    setStatus(s);
    return s.status === "done" || s.status === "failed";
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Jobs live in Redis now and the geometry engine finishes in under a
    // minute, so poll every 10 s at first; a job still waiting after 10 min
    // is stuck in the queue, and after half an hour the tab may have been
    // forgotten and every 5 min is enough.
    const started = Date.now();
    const tick = async () => {
      const finished = await poll(jobId).catch(() => false);
      if (stop || finished) return;
      const age = Date.now() - started;
      timer = setTimeout(tick, age < 10 * 60_000 ? 10_000 : age < 30 * 60_000 ? 45_000 : 5 * 60_000);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, poll]);

  const submit = async () => {
    if (!file) return;
    // the edited canvas is what gets drawn; it is capped at 1200 px so it
    // stays well under the API's size limit even when the original file is not
    const imageBase64 = editorRef.current?.toDataUrl();
    if (!imageBase64) {
      setError("Your picture is still loading - try again in a moment.");
      return;
    }
    if (imageBase64.length > MAX_IMAGE_B64) {
      setError("That picture is too detailed to upload - try a simpler one.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/draw-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          email: email.trim() || undefined,
          // the touched-up line drawing is plotted line for line; the picture itself (sketch failed) as before
          mode: sketch?.state === "ready" ? "lineart" : undefined,
          // the name read off the picture: the short version is lettered with it or its initials
          words: (sketch?.state === "ready" && sketch.words) || undefined,
        }),
      });
      const body = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !body.jobId) throw new Error(body.error ?? "Upload failed.");
      // the results page shows the original picture, not the line drawing
      const thumb = await makeThumbnail(file);
      if (thumb) saveThumbnail(body.jobId, thumb);
      router.push(`/draw?job=${body.jobId}`);
    } catch (e) {
      setError((e as Error).message || "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  if (jobId) {
    const mins = status ? Math.max(0, Math.round((Date.now() - status.createdAt) / 60000)) : 0;
    const routes = status?.status === "done" ? status.routes : [];
    const scored = routesScored(routes);
    // The cards stay in best-match order in the page and only their grid
    // position (CSS order) changes with the sort: moving a live Leaflet map
    // to another place in the page crashed it (Nov 9, "_leaflet_pos" of a
    // map that had been torn down).
    const ranked = rankDrawRoutes(routes);
    // the star: the best match short enough to run in one go
    const pick = pickIndex(ranked);
    const place = new Map(sortDrawRoutes(ranked, sort, pick).map((r, at) => [r.index, at]));
    return (
      <div>
        <h1 className="font-pace-heading text-3xl uppercase tracking-wide text-pace-blue sm:text-4xl">
          Your drawing
        </h1>
        {uploadThumb || status?.subject ? (
          <div className="mt-4 flex items-center gap-4">
            {uploadThumb ? (
              <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg border border-pace-line bg-pace-warm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={uploadThumb} alt="Your picture" className="max-h-full max-w-full object-contain p-2" />
              </div>
            ) : null}
            <div className="text-sm">
              <p className="font-semibold">Your picture</p>
              {status?.subject ? <p className="text-pace-muted">We read it as: {status.subject}</p> : null}
            </div>
          </div>
        ) : null}
        {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
        {!status && !error ? <p className="mt-4 text-sm text-pace-muted">Checking…</p> : null}
        {status && (status.status === "queued" || status.status === "running") ? (
          <div className="mt-5 rounded-xl border border-pace-line bg-pace-white p-5">
            <p className="font-bebas text-lg tracking-[0.08em]">
              {status.status === "queued" ? "In line - waiting for the next free slot" : "Fitting your drawing onto the streets"}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-pace-muted">
              We try hundreds of places, sizes and angles across Manhattan, Brooklyn and Queens and keep the
              ones that still look like your picture. This usually takes a minute or two ({mins} min so far). You can close this page and
              come back to this link later; if you gave us your email, we will send you the link too.
            </p>
          </div>
        ) : null}
        {status?.status === "failed" ? (
          <div className="mt-5 rounded-xl border border-pace-line bg-pace-white p-5">
            <p className="font-bebas text-lg tracking-[0.08em]">No route this time</p>
            <p className="mt-2 text-sm text-pace-muted">
              We could not fit this picture onto the streets. Bold shapes with a clear outline work best.
            </p>
            <a href="/draw" className="pace-btn-primary mt-4 inline-block px-6 py-2 text-xs">
              Try another picture
            </a>
          </div>
        ) : null}
        {status?.status === "done" ? (
          <>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-pace-muted">
              {resultsIntro(routes)}
              {status.note ? ` ${status.note}` : ""} Load the GPX into Strava, Garmin or your watch.
            </p>
            {routes.length > 1 ? (
              <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Sort the versions">
                <span className="font-bebas text-xs tracking-[0.14em] text-pace-muted">Sort by</span>
                {(["best", "distance"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={sort === m}
                    onClick={() => setSort(m)}
                    className={`rounded border px-3 py-1.5 font-bebas text-xs tracking-[0.1em] transition ${
                      sort === m
                        ? "border-pace-blue bg-pace-blue text-white"
                        : "border-pace-line bg-pace-white text-pace-ink hover:border-pace-blue"
                    }`}
                  >
                    {SORT_TEXT[m]}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              {ranked.map(({ route: r, rank, index }) => {
                // jobs since Nov 9 are titled by their best-match rank, which a card
                // keeps when the page is sorted by distance; older jobs keep their labels
                const best = scored ? index === pick : r.label === "pick";
                // the other cards count on from the best match, skipping the pick: with the
                // pick ranked fourth the page read "Match #3" then "Match #5" (Nov 12 and 24 reviews)
                const pickRank = ranked.find((x) => x.index === pick)?.rank ?? -1;
                const number = rank + 1 - (pickRank > 0 && pickRank < rank ? 1 : 0);
                const title = scored
                  ? rank === 0
                    ? "Best match"
                    : best
                      ? "Our pick"
                      : `Match #${number}`
                  : r.label
                    ? LABEL_TEXT[r.label]
                    : `Option ${index + 1}`;
                return (
                  <div
                    key={index}
                    style={{ order: place.get(index) ?? rank }}
                    className="flex flex-col overflow-hidden rounded-xl border border-pace-line bg-pace-white"
                  >
                    <div className="h-[340px] p-2 lg:h-[420px]">
                      <Step5PreviewMap routeLine={r.points} originalArt={NO_ART} showOriginalArt={false} showEndpoints pageScroll slim />
                    </div>
                    <div className="flex items-center justify-between gap-3 border-t border-pace-line px-4 py-3">
                      <div>
                        <p className="font-bebas text-sm tracking-[0.1em]">
                          {title}
                          {best ? <span className="ml-2 text-pace-yellow">★</span> : null} ·{" "}
                          {formatDistance(r.km, profile.unit)} · {formatDuration(r.km * profile.paceSecPerKm)}
                        </p>
                        {scored && r.label === "mark" ? (
                          <p className="mt-0.5 text-xs text-pace-muted">Picture only, without the words</p>
                        ) : null}
                        {scored && r.label === "initials" && r.text ? (
                          <p className="mt-0.5 text-xs text-pace-muted">Your picture with &quot;{r.text}&quot; under it</p>
                        ) : null}
                        {scored && r.label === "letters" && r.text ? (
                          <p className="mt-0.5 text-xs text-pace-muted">Just &quot;{r.text}&quot;, in large letters</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            const stats = `${formatDistance(r.km, profile.unit)} · ${formatDuration(r.km * profile.paceSecPerKm)}`;
                            const name = await downloadShare(r, title, uploadThumb, stats);
                            if (name) setSaved({ index, name, kind: "picture" });
                          }}
                          className="pace-btn-ghost pace-btn-ghost--sm"
                        >
                          Share picture
                        </button>
                        <button
                          type="button"
                          onClick={() => setSaved({ index, name: download(r, title), kind: "gpx" })}
                          className="pace-btn-primary px-4 py-2 text-xs"
                        >
                          GPX
                        </button>
                      </div>
                    </div>
                    {r.points.length > 1 ? (
                      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-pace-line px-4 py-2 text-xs text-pace-muted">
                        <span className="w-full lg:hidden">Use two fingers to move or zoom the map.</span>
                        <span>
                          <span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-green-600" />
                          Start
                        </span>
                        <span>
                          <span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-gray-900" />
                          Finish
                        </span>
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${r.points[0][0]},${r.points[0][1]}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-pace-blue"
                        >
                          See where it starts →
                        </a>
                      </p>
                    ) : null}
                    {saved?.index === index ? (
                      <p role="status" className="border-t border-pace-line bg-pace-warm px-4 py-3 text-xs leading-relaxed text-pace-ink">
                        <span className="font-semibold">Downloading {saved.name}</span> - look in your Downloads folder.{" "}
                        {saved.kind === "gpx"
                          ? "To follow it on a run, import the file as a route in Strava (website: My Routes, Create New Route, then upload) or as a course in Garmin Connect (Training, Courses, Import)."
                          : "It is a square picture of your logo beside its route, ready to post."}{" "}
                        If no file arrives, your browser is asking whether this page may download more than one file:
                        look for a prompt by the address bar and allow it.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <a href="/draw" className="mt-8 inline-block text-sm font-semibold text-pace-blue">
              Draw another →
            </a>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <h1 className="font-pace-heading text-3xl uppercase tracking-wide text-pace-blue sm:text-4xl">
        Draw my logo
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-pace-muted">
        <strong className="font-semibold text-pace-ink">New York City only for now.</strong> Upload a logo or a
        picture. We turn it into a running route that draws it across New York City streets, and
        give you up to five versions to choose from, from about 10 km up. Bold shapes with a clear outline work best.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-pace-muted">
        We search Manhattan, Brooklyn and Queens for the streets that fit your shape best, so your route may land
        in Brooklyn or Queens.
      </p>
      <div className="mt-6 flex flex-col gap-5 rounded-xl border border-pace-line bg-pace-white p-5">
        <div className="text-sm font-semibold">
          Your picture
          {/* the native file input reads as plain text; a real button stands in for it */}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <label htmlFor="draw-file" className="pace-btn-ghost pace-btn-ghost--sm cursor-pointer">
              {file ? "Change picture" : "Choose picture"}
            </label>
            <span className="min-w-0 truncate font-normal text-pace-muted">{file ? file.name : "No picture chosen yet"}</span>
          </div>
          <input
            id="draw-file"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              setTyped(null);
              setName("");
              setFile(e.target.files?.[0] ?? null);
            }}
            className="sr-only"
          />
        </div>
        {file && sketch?.state === "working" ? (
          <div className="rounded-lg border border-pace-line bg-pace-warm p-5">
            <p className="font-bebas text-lg tracking-[0.08em]">Turning your picture into a simple drawing…</p>
            <p className="mt-1 text-sm text-pace-muted">This usually takes under a minute.</p>
          </div>
        ) : null}
        {file && editorFile ? (
          <div>
            <p className="text-sm font-semibold">This is what we will draw - touch it up first</p>
            <p className="mt-1 mb-3 max-w-2xl text-sm leading-relaxed text-pace-muted">
              {sketch?.state === "ready"
                ? "We turned your picture into a simple line drawing; every line becomes streets. Erase lines you do not want, and use the pen to add or fix one. Blue lines are your words."
                : "Erase anything you do not want on the streets, like small text or tiny details. Use the pen to close gaps or thicken thin lines. Bold, simple shapes read best."}
            </p>
            {sketch?.state === "ready" && sketch.left ? (
              <p className="mb-3 max-w-2xl rounded-lg border border-pace-line bg-pace-warm px-3 py-2 text-sm leading-relaxed text-pace-ink">
                <span className="font-semibold">Left out: &quot;{sketch.left}&quot;.</span> Words are drawn as one row of
                big block capitals, at most 12 letters, because small print and long names cannot be read at street
                size. The blue lines are the words we kept.
              </p>
            ) : null}
            {sketch?.state === "ready" ? (
              <form
                className="mb-4 max-w-2xl rounded-lg border border-pace-line bg-pace-white px-3 py-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = plainName(name);
                  if (next && next !== plainName(sketch.words ?? "")) setTyped(next);
                }}
              >
                <label htmlFor="draw-name" className="text-sm font-semibold">
                  {sketch.words ? "The name on your route" : "Want your name on the route?"}
                </label>
                <p className="mt-1 text-sm leading-relaxed text-pace-muted">
                  {/* Nov 24 review 6: it said 'We read "TORNION"' after the customer typed it, and showed
                      "LANYON BOWDLER" in the box over a drawing that says LANYON with no word on why */}
                  {!sketch.words
                    ? "We found no name on your picture. Type one and we will letter it under the drawing."
                    : typed && plainName(sketch.words) === typed
                      ? `The drawing now uses the name you typed, "${sketch.words}". To change it again, type another.`
                      : `We read "${sketch.words}" off your picture. If that is wrong, or you would rather have another word, type it here.`}{" "}
                  {sketch.words && plainName(sketch.words).length > NAME_ROW
                    ? `Only ${NAME_ROW} letters fit on the row, so the drawing shows just the first part of it: the blue lines are what will be drawn. To have a different word, type that word alone.`
                    : `Up to ${NAME_ROW} letters fit on the row, and a short name makes a shorter run.`}{" "}
                  Redrawing starts the touch-up over.
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <input
                    id="draw-name"
                    type="text"
                    value={name}
                    maxLength={40}
                    autoComplete="off"
                    onChange={(e) => setName(e.target.value)}
                    placeholder="YOUR NAME"
                    className="block w-56 rounded border border-pace-line px-3 py-2 text-sm font-normal uppercase"
                  />
                  <button
                    type="submit"
                    disabled={!plainName(name) || plainName(name) === plainName(sketch.words ?? "")}
                    className="pace-btn-ghost pace-btn-ghost--sm disabled:opacity-50"
                  >
                    Redraw with this name
                  </button>
                </div>
                {typed && plainName(sketch.words ?? "") !== typed ? (
                  <p className="mt-2 text-sm text-red-700">
                    We could not change the name just now - the drawing still shows what we read. Use the eraser and
                    pen instead, or try again in a few minutes.
                  </p>
                ) : null}
              </form>
            ) : null}
            {drawings.length > 1 ? (
              <div className="mb-4">
                <p className="text-sm font-semibold">We made {drawings.length === 2 ? "two" : drawings.length} drawings - pick the one that looks more like your picture</p>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-pace-muted">
                  You can still touch up the one you pick. Switching starts the touch-up over.
                </p>
                <div className="mt-3 flex flex-wrap gap-3" role="group" aria-label="Choose a drawing">
                  {drawings.map((d, i) => (
                    <button
                      key={i}
                      type="button"
                      aria-pressed={choice === i}
                      onClick={() => setChoice(i)}
                      className={`overflow-hidden rounded-lg border-2 bg-white transition ${
                        choice === i ? "border-pace-blue" : "border-pace-line hover:border-pace-blue"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={d.url} alt={`Drawing ${i + 1}`} className="h-36 w-36 object-contain sm:h-44 sm:w-44" />
                      <span
                        className={`block px-2 py-1 font-bebas text-xs tracking-[0.1em] ${
                          choice === i ? "bg-pace-blue text-white" : "text-pace-ink"
                        }`}
                      >
                        {choice === i ? `Drawing ${i + 1} - chosen` : `Drawing ${i + 1}`}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <LineArtEditor ref={editorRef} file={editorFile} />
          </div>
        ) : null}
        <div className="flex max-w-md flex-col gap-4">
          <label className="text-sm font-semibold">
            Email me when it is ready (optional)
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-2 block w-full rounded border border-pace-line px-3 py-2 text-sm font-normal"
            />
          </label>
          <button
            type="button"
            disabled={!file || !editorFile || busy}
            onClick={submit}
            className="pace-btn-primary self-start px-8 disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Draw it"}
          </button>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
