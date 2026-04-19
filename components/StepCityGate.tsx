"use client";

import {
  CITY_PRESETS,
  CITY_PRESETS_ORDERED,
  DEFAULT_CITY_ID,
} from "../lib/cityPresets";

type Props = {
  selectedCityId: string;
  onSelectCityId: (id: string) => void;
  onContinue: () => void;
};

export default function StepCityGate({
  selectedCityId,
  onSelectCityId,
  onContinue,
}: Props) {
  const preset = CITY_PRESETS[selectedCityId] ?? CITY_PRESETS[DEFAULT_CITY_ID];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-4 px-3 py-3 sm:gap-5 sm:py-4">
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="flex items-center gap-2 font-bebas text-xs tracking-[0.2em] text-pace-yellow">
          <span className="inline-block h-px w-6 bg-pace-yellow" aria-hidden />
          Step 1
          <span className="inline-block h-px w-6 bg-pace-yellow" aria-hidden />
        </p>
        <h2 className="font-pace-heading text-2xl uppercase leading-tight tracking-tight text-pace-ink sm:text-3xl">
          Pick your city
        </h2>
        <p className="max-w-md font-dm text-xs leading-relaxed text-pace-muted sm:text-sm">
          Each city uses its street grid to help auto-placement snap your shape
          cleanly. More cities coming.
        </p>
      </div>

      <div className="grid w-full gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3">
        {CITY_PRESETS_ORDERED.map((city) => {
          const selected = selectedCityId === city.id;
          const hasGrid = Boolean(city.dominantGridBearingsDeg?.length);
          return (
            <button
              key={city.id}
              type="button"
              onClick={() => onSelectCityId(city.id)}
              aria-pressed={selected}
              className={`group relative flex flex-col gap-1.5 overflow-hidden rounded-lg border p-3 text-left shadow-sm transition-all duration-150 ease-out sm:p-4 ${
                selected
                  ? "-translate-y-0.5 border-pace-yellow bg-pace-yellow/10 shadow-md ring-2 ring-pace-yellow/60"
                  : "border-pace-line bg-pace-white hover:-translate-y-0.5 hover:border-pace-yellow/60 hover:shadow-md"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-bebas text-base tracking-[0.1em] text-pace-ink sm:text-lg">
                  {city.label}
                </span>
                {selected && (
                  <span className="rounded-full bg-pace-yellow px-2 py-0.5 font-bebas text-[9px] tracking-widest text-pace-ink">
                    SELECTED
                  </span>
                )}
              </div>
              {city.region && (
                <span className="text-[10px] font-medium uppercase tracking-wider text-pace-muted">
                  {city.region}
                </span>
              )}
              {city.tagline && (
                <span className="text-[11px] leading-snug text-pace-muted sm:text-xs">
                  {city.tagline}
                </span>
              )}
              <span className="mt-1 flex flex-wrap items-center gap-1">
                <span className="inline-flex items-center gap-1 rounded-full bg-pace-line/40 px-1.5 py-0.5 text-[9px] font-medium text-pace-muted">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full bg-pace-yellow"
                    aria-hidden
                  />
                  {hasGrid
                    ? `Grid-aligned (${city.dominantGridBearingsDeg![0]}°)`
                    : "No street grid"}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex flex-col items-center gap-2 rounded-lg border border-pace-line bg-pace-panel/50 px-4 py-2 text-center sm:flex-row sm:gap-4">
        <span className="font-bebas text-[10px] tracking-[0.14em] text-pace-muted">
          Coverage
        </span>
        <span className="font-dm text-[11px] tabular-nums text-pace-muted">
          {preset.searchBounds.south.toFixed(2)}°–
          {preset.searchBounds.north.toFixed(2)}° N ·{" "}
          {Math.abs(preset.searchBounds.west).toFixed(2)}°–
          {Math.abs(preset.searchBounds.east).toFixed(2)}°{" "}
          {preset.searchBounds.west < 0 ? "W" : "E"}
        </span>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="pace-btn-primary px-8"
      >
        Continue with {preset.label}
      </button>
    </div>
  );
}
