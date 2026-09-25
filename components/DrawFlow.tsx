"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatDistance, formatDuration, useRunnerProfile } from "../lib/runnerProfile";

const Step5PreviewMap = dynamic(() => import("./Step5PreviewMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[280px] w-full items-center justify-center rounded-xl border border-pace-line bg-pace-warm text-xs text-pace-muted">
      Loading map…
    </div>
  ),
});

type Route = { km: number; points: [number, number][] };
type Status = {
  status: "queued" | "running" | "done" | "failed";
  ahead: number;
  createdAt: number;
  routes: Route[];
  error: string | null;
};

const MAX_BYTES = 3_000_000;

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
  const [preview, setPreview] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

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
    const tick = async () => {
      const finished = await poll(jobId).catch(() => false);
      if (!stop && !finished) timer = setTimeout(tick, 20_000);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, poll]);

  const submit = async () => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("That file is over 3 MB - try a smaller one.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const imageBase64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("Could not read that file."));
        r.readAsDataURL(file);
      });
      const res = await fetch("/api/draw-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64, email: email.trim() || undefined }),
      });
      const body = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !body.jobId) throw new Error(body.error ?? "Upload failed.");
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
        {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
        {!status && !error ? <p className="mt-4 text-sm text-pace-muted">Checking…</p> : null}
        {status && (status.status === "queued" || status.status === "running") ? (
          <div className="mt-5 rounded-xl border border-pace-line bg-pace-white p-5">
            <p className="font-bebas text-lg tracking-[0.08em]">
              {status.status === "queued"
                ? status.ahead > 0
                  ? `In line - ${status.ahead} drawing${status.ahead === 1 ? "" : "s"} ahead of yours`
                  : "In line - starting soon"
                : "Fitting your drawing onto the streets"}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-pace-muted">
              We try hundreds of places, sizes and angles across New York and keep the ones that still look like
              your picture. This usually takes 15-30 minutes ({mins} min so far). You can close this page - bookmark
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
              Three versions, each one continuous run on real streets. Pick the one you like best and load the GPX
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
                      Option {i + 1} · {formatDistance(r.km, profile.unit)} ·{" "}
                      {formatDuration(r.km * profile.paceSecPerKm)}
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
        give you three versions to choose from. Bold shapes with a clear outline work best.
      </p>
      <div className="mt-6 grid gap-5 rounded-xl border border-pace-line bg-pace-white p-5 sm:grid-cols-[1fr_220px]">
        <div className="flex flex-col gap-4">
          <label className="text-sm font-semibold">
            Your picture
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-2 block w-full text-sm"
            />
          </label>
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
            disabled={!file || busy}
            onClick={submit}
            className="pace-btn-primary self-start px-8 disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Draw it"}
          </button>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
        </div>
        <div
          className={`${preview ? "flex" : "hidden sm:flex"} aspect-square items-center justify-center rounded-lg border border-dashed border-pace-line bg-pace-warm`}
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Your upload" className="max-h-full max-w-full object-contain p-3" />
          ) : (
            <span className="text-xs text-pace-muted">Preview</span>
          )}
        </div>
      </div>
    </div>
  );
}
