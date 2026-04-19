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
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 px-3 py-4 sm:gap-5 sm:py-6">
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
          Your shape will be placed on this city&apos;s streets and snapped to
          real walkable routes. More cities coming.
        </p>
      </div>

      <div className="w-full max-w-sm rounded-xl border border-pace-line bg-pace-white p-4 shadow-sm sm:p-5">
        <label
          htmlFor="city-picker"
          className="block font-bebas text-xs tracking-[0.14em] text-pace-muted"
        >
          City
        </label>
        <select
          id="city-picker"
          value={selectedCityId}
          onChange={(e) => onSelectCityId(e.target.value)}
          className="font-dm mt-2 w-full rounded-lg border border-pace-line bg-pace-panel px-3 py-3 text-base font-medium text-pace-ink outline-none transition focus:border-pace-yellow focus:ring-4 focus:ring-pace-yellow/25"
        >
          {CITY_PRESETS_ORDERED.map((city) => (
            <option key={city.id} value={city.id}>
              {city.label}
              {city.region ? ` — ${city.region}` : ""}
            </option>
          ))}
        </select>

        {preset.tagline && (
          <p className="mt-3 text-[12px] leading-relaxed text-pace-muted">
            {preset.tagline}
          </p>
        )}

        <p className="mt-3 flex items-baseline justify-between gap-2 border-t border-pace-line pt-3 text-[11px] tabular-nums text-pace-muted">
          <span className="font-bebas tracking-[0.14em]">Coverage</span>
          <span>
            {preset.searchBounds.south.toFixed(2)}°–
            {preset.searchBounds.north.toFixed(2)}° N ·{" "}
            {Math.abs(preset.searchBounds.west).toFixed(2)}°–
            {Math.abs(preset.searchBounds.east).toFixed(2)}°{" "}
            {preset.searchBounds.west < 0 ? "W" : "E"}
          </span>
        </p>
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
