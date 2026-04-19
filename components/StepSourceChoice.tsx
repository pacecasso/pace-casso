"use client";

import { ImageIcon, PencilLine, Sparkles } from "lucide-react";
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
  loadCachedSuggestions,
  saveCachedSuggestions,
  type CitySuggestion,
} from "../lib/citySuggestionCache";
import { emojiToContour } from "../lib/emojiToContour";
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

  const [suggestions, setSuggestions] = useState<CitySuggestion[] | null>(null);
  const [suggestionsBusy, setSuggestionsBusy] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<number | null>(null);

  function handleUseSuggestion(s: CitySuggestion, idx: number): void {
    setSuggestionError(null);
    if (!s.emoji || !onPickAreaTemplate) return;
    const contour = emojiToContour(s.emoji);
    if (!contour || contour.length < 4) {
      setSuggestionError(idx);
      return;
    }
    onPickAreaTemplate(contour);
  }

  // Reset + try cache whenever city changes.
  useEffect(() => {
    setSuggestions(null);
    setSuggestionsError(null);
    if (!cityPreset) return;
    const cached = loadCachedSuggestions(cityPreset.id);
    if (cached) setSuggestions(cached);
  }, [cityPreset?.id, cityPreset]);

  async function fetchSuggestions(): Promise<void> {
    if (!cityPreset) return;
    setSuggestionsBusy(true);
    setSuggestionsError(null);
    try {
      const res = await fetch("/api/city-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cityLabel: cityPreset.label,
          cityRegion: cityPreset.region,
          gridBearings: cityPreset.dominantGridBearingsDeg,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        setSuggestionsError(
          res.status === 503
            ? "AI suggestions aren't configured on this deployment."
            : `Couldn't get ideas (${res.status})`,
        );
        console.warn("[city-suggestions] http", res.status, errText);
        return;
      }
      const json = (await res.json()) as {
        suggestions?: CitySuggestion[];
      };
      if (!json.suggestions?.length) {
        setSuggestionsError("No suggestions returned. Try again?");
        return;
      }
      setSuggestions(json.suggestions);
      saveCachedSuggestions(cityPreset.id, json.suggestions);
    } catch (err) {
      console.warn("[city-suggestions] fetch failed:", err);
      setSuggestionsError("Couldn't reach the AI — try again.");
    } finally {
      setSuggestionsBusy(false);
    }
  }

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

      {cityPreset ? (
        <div className="mt-6 w-full max-w-4xl border-t border-pace-line pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="flex items-center gap-1.5 font-bebas text-[11px] tracking-[0.14em] text-pace-muted">
                <Sparkles className="h-3 w-3 text-pace-yellow" aria-hidden />
                Ideas for {cityPreset.label}
              </p>
              <p className="mt-1 font-dm text-[11px] leading-relaxed text-pace-muted sm:text-xs">
                Ask PaceCasso for 5 shape ideas tailored to {cityPreset.label} —
                from simple to elaborate, including local landmarks.
              </p>
            </div>
            {!suggestions && !suggestionsBusy && (
              <button
                type="button"
                onClick={() => void fetchSuggestions()}
                className="pace-toolbar-btn shrink-0 px-3 py-2 text-[11px]"
              >
                Ask PaceCasso
              </button>
            )}
            {suggestions && !suggestionsBusy && (
              <button
                type="button"
                onClick={() => void fetchSuggestions()}
                className="pace-toolbar-btn shrink-0 px-3 py-1.5 text-[10px]"
                title="Ask for fresh ideas"
              >
                Ask again
              </button>
            )}
          </div>

          {suggestionsBusy && (
            <p className="mt-3 font-dm text-[11px] italic text-pace-muted">
              Thinking up shapes for {cityPreset.label}…
            </p>
          )}
          {suggestionsError && (
            <p className="mt-3 font-dm text-[11px] text-red-600">
              {suggestionsError}
            </p>
          )}
          {suggestions && suggestions.length > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {suggestions.map((s, i) => {
                const diffColor =
                  s.difficulty === "simple"
                    ? "bg-emerald-100 text-emerald-700"
                    : s.difficulty === "medium"
                      ? "bg-pace-yellow/25 text-pace-ink"
                      : "bg-red-100 text-red-700";
                return (
                  <div
                    key={i}
                    className="flex flex-col gap-1.5 rounded-lg border border-pace-line bg-pace-white p-3 shadow-sm transition hover:border-pace-yellow/60 hover:shadow-md"
                  >
                    <div className="flex items-center gap-2">
                      {s.emoji && (
                        <span
                          aria-hidden
                          className="select-none text-2xl leading-none"
                        >
                          {s.emoji}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 font-bebas text-sm tracking-[0.08em] text-pace-ink">
                        {s.title}
                      </span>
                      {s.iconic && (
                        <span className="shrink-0 rounded-full bg-pace-blue/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-pace-blue">
                          Iconic
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] leading-snug text-pace-muted">
                      {s.description}
                    </p>
                    <span
                      className={`inline-flex w-fit items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${diffColor}`}
                    >
                      {s.difficulty}
                    </span>
                    {s.emoji && onPickAreaTemplate ? (
                      <button
                        type="button"
                        onClick={() => handleUseSuggestion(s, i)}
                        className="pace-toolbar-btn-primary mt-1 w-full px-3 py-2 text-[11px] tracking-[0.08em]"
                        title={`Use the ${s.emoji} silhouette`}
                      >
                        Use this shape →
                      </button>
                    ) : (
                      <p className="mt-1 text-[10px] italic leading-snug text-pace-muted">
                        No emoji match for this one — trace a reference image
                        or draw it freehand.
                      </p>
                    )}
                    {suggestionError === i && (
                      <p className="text-[10px] text-red-600">
                        Couldn&apos;t convert this emoji to a shape. Try Photo
                        or Draw below.
                      </p>
                    )}
                    <div className="flex items-center justify-end gap-1 border-t border-pace-line/70 pt-1.5">
                      <button
                        type="button"
                        onClick={onChooseImage}
                        title={`Trace a photo of "${s.title}"`}
                        className="inline-flex items-center gap-1 rounded-full border border-pace-line bg-pace-white px-2 py-0.5 text-[9px] font-semibold text-pace-ink transition hover:border-pace-blue hover:bg-pace-blue/10 hover:text-pace-blue"
                        aria-label={`Trace a photo of ${s.title}`}
                      >
                        <ImageIcon className="h-3 w-3" aria-hidden />
                        Photo
                      </button>
                      <button
                        type="button"
                        onClick={onChooseFreehand}
                        title={`Draw "${s.title}" freehand on the map`}
                        className="inline-flex items-center gap-1 rounded-full border border-pace-line bg-pace-white px-2 py-0.5 text-[9px] font-semibold text-pace-ink transition hover:border-pace-yellow hover:bg-pace-yellow/20"
                        aria-label={`Draw ${s.title} freehand`}
                      >
                        <PencilLine className="h-3 w-3" aria-hidden />
                        Draw
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {showTemplates ? (
        <div className="mt-6 w-full max-w-4xl border-t border-pace-line pt-5">
          <p className="font-bebas text-[11px] tracking-[0.14em] text-pace-muted">
            Starter shapes
          </p>
          <p className="mt-1 font-dm text-[11px] leading-relaxed text-pace-muted sm:text-xs">
            {AREA_TEMPLATE_INTRO}
          </p>
          <p className="mt-1.5 font-dm text-[10px] leading-snug text-pace-muted sm:text-[11px]">
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
                  <p className="mb-2 flex items-baseline gap-2 font-bebas text-[10px] tracking-[0.14em] text-pace-muted">
                    <span className="inline-block h-px w-6 bg-pace-yellow" aria-hidden />
                    {COMPLEXITY_LABEL[tier]}
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5 lg:grid-cols-4">
                    {tierTemplates.map((t) => {
                      const row = templateSnap[t.id];
                      const snapBadge =
                        row?.status === "loading" ? (
                          <span className="mt-1 block text-[9px] font-dm text-pace-muted">
                            Checking map…
                          </span>
                        ) : row?.status === "done" ? (
                          <span
                            className={
                              row.meetsThreshold
                                ? "mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700"
                                : "mt-1 block text-[9px] font-dm text-pace-muted"
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
                          className="pace-card-editorial group flex flex-col gap-1 overflow-hidden p-0 text-left text-[11px] shadow-sm transition hover:border-pace-yellow hover:shadow-md active:scale-[0.99]"
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
