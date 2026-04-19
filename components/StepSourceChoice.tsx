"use client";

import { ImageIcon, PencilLine } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AREA_DESIGN_TEMPLATES,
  AREA_TEMPLATE_INTRO,
  COMPLEXITY_LABEL,
  COMPLEXITY_ORDER,
  type AreaDesignComplexity,
  type AreaDesignContour,
} from "../lib/areaDesignTemplates";
import {
  AREA_TEMPLATE_SNAP_MAX_TRIES,
  bestPlacementBySnapMatch,
  MIN_SNAP_MATCH_PERCENT_TO_ADOPT,
} from "../lib/autoFindPlacement";
import type { CityPreset } from "../lib/cityPresets";
import type { ContourPoint } from "../lib/placementFromContour";
import CreateStepIntro from "./CreateStepIntro";

type TemplateSnapRow =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "done";
      meetsThreshold: boolean;
      bestPercent: number | null;
    };

type Props = {
  onBack: () => void;
  onChooseImage: () => void;
  onChooseFreehand: () => void;
  /** Skip trace and jump to placement with a preset contour. */
  onPickAreaTemplate?: (contour: AreaDesignContour[]) => void;
  cityPreset?: CityPreset;
};

export default function StepSourceChoice({
  onBack,
  onChooseImage,
  onChooseFreehand,
  onPickAreaTemplate,
  cityPreset,
}: Props) {
  const showTemplates =
    Boolean(onPickAreaTemplate) &&
    Boolean(cityPreset?.dominantGridBearingsDeg?.length);

  const [templateSnap, setTemplateSnap] = useState<
    Partial<Record<string, TemplateSnapRow>>
  >({});

  useEffect(() => {
    if (!showTemplates || !cityPreset) {
      setTemplateSnap({});
      return;
    }

    let cancelled = false;
    setTemplateSnap({});

    void (async () => {
      for (const t of AREA_DESIGN_TEMPLATES) {
        if (cancelled) return;
        setTemplateSnap((prev) => ({
          ...prev,
          [t.id]: { status: "loading" },
        }));
        try {
          const r = await bestPlacementBySnapMatch(
            t.contour as ContourPoint[],
            cityPreset,
            {
              maxSnapTries: AREA_TEMPLATE_SNAP_MAX_TRIES,
              anchorSource: "image",
            },
          );
          if (cancelled) return;
          setTemplateSnap((prev) => ({
            ...prev,
            [t.id]: {
              status: "done",
              meetsThreshold: r.chosen != null,
              bestPercent: r.bestAttemptPercent,
            },
          }));
        } catch {
          if (cancelled) return;
          setTemplateSnap((prev) => ({
            ...prev,
            [t.id]: {
              status: "done",
              meetsThreshold: false,
              bestPercent: null,
            },
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cityPreset, showTemplates]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 px-3 py-2 sm:gap-5 sm:py-3">
      <CreateStepIntro
        compact
        label="Choose a path"
        title="How do you want to draw?"
        onBack={onBack}
        backLabel="← Change city"
        description={
          <>
            <strong className="text-pace-ink">From a photo</strong> — trace a
            shape, then drop it on the map.{" "}
            <strong className="text-pace-ink">Freehand</strong> — draw right on
            the map, then we snap it to streets.
          </>
        }
      />

      <div className="grid w-full max-w-2xl gap-3 sm:grid-cols-2 sm:gap-4">
        <button
          type="button"
          onClick={onChooseImage}
          className="pace-card-editorial group flex flex-col items-center gap-3 p-4 text-center shadow-sm transition hover:border-pace-blue hover:shadow-md active:scale-[0.99] sm:p-5"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-pace-blue/30 bg-pace-blue/10 text-pace-blue transition group-hover:bg-pace-blue/15 sm:h-12 sm:w-12">
            <ImageIcon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden />
          </span>
          <span>
            <span className="font-bebas block text-base tracking-[0.1em] text-pace-ink sm:text-lg">
              From a photo
            </span>
            <span className="mt-0.5 block text-[11px] leading-snug text-pace-muted sm:text-xs">
              Trace an image, place on map
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onChooseFreehand}
          className="pace-card-editorial group flex flex-col items-center gap-3 border-t-pace-yellow bg-gradient-to-b from-pace-yellow/12 to-white p-4 text-center shadow-sm transition hover:shadow-md active:scale-[0.99] sm:p-5"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-pace-yellow bg-pace-yellow/20 text-pace-ink transition group-hover:bg-pace-yellow/30 sm:h-12 sm:w-12">
            <PencilLine className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden />
          </span>
          <span>
            <span className="font-bebas block text-base tracking-[0.1em] text-pace-ink sm:text-lg">
              Draw on the map
            </span>
            <span className="mt-0.5 block text-[11px] leading-snug text-pace-muted sm:text-xs">
              Sketch your route by hand
            </span>
          </span>
        </button>
      </div>

      {showTemplates ? (
        <div className="mt-6 w-full max-w-4xl border-t border-pace-line pt-5">
          <p className="font-bebas text-[11px] tracking-[0.14em] text-pace-muted">
            Starter shapes
          </p>
          <p className="mt-1 font-dm text-[11px] leading-relaxed text-pace-muted sm:text-xs">
            {AREA_TEMPLATE_INTRO}
          </p>
          <p className="mt-1.5 font-dm text-[11px] leading-snug text-pace-muted sm:text-[11px]">
            Each starter gets snap-tested against {cityPreset?.label ?? "the city"} (top{" "}
            {AREA_TEMPLATE_SNAP_MAX_TRIES} placements). &quot;Street-ready&quot; means
            interpretation score ≥{MIN_SNAP_MATCH_PERCENT_TO_ADOPT}%.
          </p>

          {(["simple", "medium", "elaborate"] as AreaDesignComplexity[]).map(
            (tier) => {
              const tierTemplates = [...AREA_DESIGN_TEMPLATES]
                .sort(
                  (a, b) =>
                    COMPLEXITY_ORDER[a.complexity] -
                    COMPLEXITY_ORDER[b.complexity],
                )
                .filter((t) => t.complexity === tier);
              if (tierTemplates.length === 0) return null;
              return (
                <div key={tier} className="mt-4">
                  <p className="mb-2 flex items-baseline gap-2 font-bebas text-[11px] tracking-[0.14em] text-pace-muted">
                    <span className="inline-block h-px w-6 bg-pace-yellow" aria-hidden />
                    {COMPLEXITY_LABEL[tier]}
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5 lg:grid-cols-4">
                    {tierTemplates.map((t) => {
                      const row = templateSnap[t.id];
                      const snapBadge =
                        row?.status === "loading" ? (
                          <span className="mt-1 block text-[10px] font-dm text-pace-muted">
                            Checking map…
                          </span>
                        ) : row?.status === "done" ? (
                          <span
                            className={
                              row.meetsThreshold
                                ? "mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"
                                : "mt-1 block text-[10px] font-dm text-pace-muted"
                            }
                          >
                            {row.meetsThreshold
                              ? "✓ street-ready"
                              : row.bestPercent != null
                                ? `best ~${Math.round(row.bestPercent)}% — try auto-find`
                                : "preview unavailable"}
                          </span>
                        ) : null;

                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => onPickAreaTemplate?.(t.contour)}
                          className="pace-card-editorial group flex flex-col gap-1 overflow-hidden p-0 text-left text-[11px] shadow-sm transition hover:border-pace-yellow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow focus-visible:ring-offset-2 active:scale-[0.99]"
                        >
                          <div className="relative flex aspect-[5/4] w-full items-center justify-center bg-gradient-to-br from-pace-panel to-pace-white">
                            <span
                              aria-hidden
                              className={`select-none leading-none transition group-hover:scale-110 ${
                                t.icon.length === 1
                                  ? "font-bebas text-[3.25rem] tracking-tight text-pace-ink"
                                  : "text-[2.75rem]"
                              }`}
                            >
                              {t.icon}
                            </span>
                          </div>
                          <div className="flex flex-col gap-0.5 p-2.5 sm:p-3">
                            <span className="font-bebas text-sm tracking-[0.1em] text-pace-ink">
                              {t.title}
                            </span>
                            <span className="leading-snug text-pace-muted">
                              {t.blurb}
                            </span>
                            {snapBadge}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            },
          )}
        </div>
      ) : null}
    </div>
  );
}
