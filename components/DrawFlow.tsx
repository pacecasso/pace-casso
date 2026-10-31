"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistance, formatDuration, useRunnerProfile } from "../lib/runnerProfile";
import LineArtEditor, { type LineArtEditorHandle } from "./LineArtEditor";

const Step5PreviewMap = dynamic(() => import("./Step5PreviewMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[280px] w-full items-center justify-center rounded-xl border border-pace-line bg-pace-warm text-xs text-pace-muted">
      Loading map…
    </div>
  ),
});

type Route = { km: number; points: [number, number][]; label?: "pick" | "short" | "alt" };

const LABEL_TEXT: Record<NonNullable<Route["label"]>, string> = {
  pick: "Our pick",
  short: "Under 25 km",
  alt: "Another take",
};
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

/** sketch job: the worker turns the upload into the simple line drawing to touch up */
type Sketch = { state: "working" | "ready" | "failed"; lineArt: File | null };

function gpxFor(route: Route, name: string): string {
  const pts = route.points.map(([lat, lng]) => `<trkpt lat="${lat}" lon="${lng}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

function download(route: Route, i: number) {
  const blob = new Blob([gpxFor(route, `PaceCasso option ${i + 1}`)], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pacecasso-option-${i + 1}-${route.km.toFixed(1)}km.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * Upload -> queued job -> three street routes. The search runs on the GPU
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
    setSketch({ state: "working", lineArt: null });
    const fail = () => {
      if (!stop) setSketch({ state: "failed", lineArt: null });
    };
    void (async () => {
      const imageBase64 = await uploadCopy(file);
      if (!imageBase64 || imageBase64.length > MAX_IMAGE_B64) return fail();
      const res = await fetch("/api/draw-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64, mode: "sketch" }),
      }).catch(() => null);
      const body = res?.ok ? ((await res.json()) as { jobId?: string }) : null;
      if (!body?.jobId) return fail();
      const started = Date.now();
      const tick = async () => {
        if (stop) return;
        const r = await fetch(`/api/draw-job?id=${body.jobId}`, { cache: "no-store" }).catch(() => null);
        const s = r?.ok ? ((await r.json()) as { status: Status["status"]; lineArt?: string | null }) : null;
        if (stop) return;
        if (s?.status === "done" && s.lineArt) {
          const blob = await (await fetch(s.lineArt)).blob();
          if (!stop) setSketch({ state: "ready", lineArt: new File([blob], "line-drawing.png", { type: "image/png" }) });
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
  }, [file]);

  const editorFile = sketch?.state === "ready" ? sketch.lineArt : sketch?.state === "failed" ? file : null;

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
              ones that still look like your picture. This usually takes a minute or two ({mins} min so far). You can close this page - bookmark
              it, or use the link in your email.
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
              {status.routes.length === 1 ? "One version" : status.routes.length === 2 ? "Two versions" : "Three versions"}
              , each one continuous run on real streets. Our pick is the one that looks most like your picture; the
              shorter one is for a run you can finish in a morning.{status.note ? ` ${status.note}` : ""} Load the GPX
              into Strava, Garmin or your watch.
            </p>
            <div className="mt-5 grid gap-5 lg:grid-cols-3">
              {status.routes.map((r, i) => (
                <div key={i} className="flex flex-col overflow-hidden rounded-xl border border-pace-line bg-pace-white">
                  <div className="h-[340px] p-2">
                    <Step5PreviewMap routeLine={r.points} originalArt={[]} showOriginalArt={false} />
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-pace-line px-4 py-3">
                    <p className="font-bebas text-sm tracking-[0.1em]">
                      {r.label ? LABEL_TEXT[r.label] : `Option ${i + 1}`}
                      {r.label === "pick" ? <span className="ml-2 text-pace-yellow">★</span> : null} ·{" "}
                      {formatDistance(r.km, profile.unit)} · {formatDuration(r.km * profile.paceSecPerKm)}
                    </p>
                    <button
                      type="button"
                      onClick={() => download(r, i)}
                      className="pace-btn-primary px-4 py-2 text-xs"
                    >
                      GPX
                    </button>
                  </div>
                </div>
              ))}
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
        Upload a logo or a picture. We turn it into a running route that draws it across New York City streets, and
        give you up to two versions to choose from. Bold shapes with a clear outline work best.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-pace-muted">
        We search Manhattan, Brooklyn and Queens, not only the borough you picked, because the shape has to fit the
        street grid. Your route may land in Brooklyn or Queens.
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
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
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
