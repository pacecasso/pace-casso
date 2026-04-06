"use client";

import { CITY_PRESETS, DEFAULT_CITY_ID } from "../lib/cityPresets";

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
  const cityIds = Object.keys(CITY_PRESETS);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-3 px-3 py-2 sm:gap-4 sm:py-3">
      <p className="max-w-sm text-center font-dm text-xs leading-relaxed text-pace-muted">
        Choose where your run lives—the map and search area start from here. You
        can start over anytime from the header.
      </p>
      <div className="pace-card-editorial w-full max-w-sm p-4 sm:p-5">
        <label className="font-bebas text-xs tracking-[0.14em] text-pace-muted">
          City
        </label>
        <select
          value={selectedCityId}
          onChange={(e) => onSelectCityId(e.target.value)}
          className="font-dm mt-2 w-full border border-pace-line bg-pace-panel px-3 py-2.5 text-sm font-medium text-pace-ink outline-none focus:border-pace-yellow focus:ring-4 focus:ring-pace-yellow/25"
        >
          {cityIds.map((id) => (
            <option key={id} value={id}>
              {CITY_PRESETS[id]?.label ?? id}
            </option>
          ))}
        </select>
        <p className="mt-2 text-[11px] leading-relaxed text-pace-muted">
          Coverage: {preset.searchBounds.south.toFixed(2)}°–
          {preset.searchBounds.north.toFixed(2)}° N,{" "}
          {Math.abs(preset.searchBounds.west).toFixed(2)}°–
          {Math.abs(preset.searchBounds.east).toFixed(2)}° W
        </p>
      </div>

      <button type="button" onClick={onContinue} className="pace-btn-primary">
        Continue
      </button>
    </div>
  );
}
