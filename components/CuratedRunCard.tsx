"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import type { CuratedRun } from "../lib/curatedManhattanRuns";

const Step5PreviewMap = dynamic(() => import("./Step5PreviewMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[280px] w-full items-center justify-center rounded-xl border border-pace-line bg-pace-warm text-xs text-pace-muted">
      Loading map…
    </div>
  ),
});

/**
 * Gallery card for a curated run. Clicking opens an interactive map preview
 * of the actual route — the GPX download lives inside the preview, so nobody
 * gets a surprise download from a single click.
 */
export default function CuratedRunCard({ run }: { run: CuratedRun }) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="pace-card-editorial group flex flex-col overflow-hidden text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow focus-visible:ring-offset-2"
        title={`Preview ${run.title} on the map`}
      >
        <div className="relative aspect-square w-full overflow-hidden bg-white">
          <Image
            src={`/curated/${run.id}.png`}
            alt={`${run.title} — the actual route drawn on the Manhattan street map`}
            fill
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            className="object-cover transition group-hover:scale-[1.03]"
          />
        </div>
        <div className="border-t border-pace-line p-4">
          <h3 className="font-bebas text-lg tracking-[0.08em] text-pace-ink">
            {run.title}
          </h3>
          <p className="mt-0.5 font-bebas text-[11px] tracking-[0.14em] text-pace-yellow">
            {run.area} · {run.distanceKm} km
          </p>
          <p className="mt-2 text-xs leading-relaxed text-pace-muted">
            {run.blurb}
          </p>
          <p className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-pace-blue">
            Preview on map →
          </p>
        </div>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[1200] flex items-center justify-center bg-pace-ink/60 p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`${run.title} route preview`}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-pace-line bg-pace-white shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-pace-line px-4 py-3">
              <div className="min-w-0">
                <h3 className="font-bebas text-xl tracking-[0.08em] text-pace-ink">
                  {run.title}
                </h3>
                <p className="mt-0.5 truncate font-bebas text-[11px] tracking-[0.14em] text-pace-yellow">
                  {run.area} · {run.distanceKm} km · verified walkable
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl leading-none text-pace-muted transition hover:bg-pace-ink/10 hover:text-pace-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow"
                aria-label="Close preview"
              >
                ×
              </button>
            </div>
            <div className="h-[min(55dvh,460px)] min-h-[320px] p-3">
              <Step5PreviewMap
                routeLine={run.coords}
                originalArt={[]}
                showOriginalArt={false}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-pace-line px-4 py-3">
              <p className="text-xs text-pace-muted">
                Pan and zoom to check the streets, then take it with you.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={close}
                  className="rounded border-2 border-pace-line bg-pace-white px-4 py-2 font-bebas text-xs tracking-[0.14em] text-pace-muted transition hover:border-pace-ink hover:text-pace-ink"
                >
                  Close
                </button>
                <a
                  href={`/api/curated-gpx/${run.id}`}
                  download
                  className="pace-btn-primary px-5 py-2 text-xs"
                >
                  Download GPX
                </a>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
