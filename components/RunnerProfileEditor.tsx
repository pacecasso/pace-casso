"use client";

import { useState } from "react";
import {
  formatPace,
  parsePace,
  type DistanceUnit,
  type RunnerProfile,
} from "../lib/runnerProfile";

type Props = {
  profile: RunnerProfile;
  onChange: (next: RunnerProfile) => void;
  /** Compact variant for inline use in a summary row; full variant is a small panel. */
  compact?: boolean;
};

/**
 * Pace + unit editor. Shows the current pace in the user's chosen unit
 * ("6:00 /km" or "9:39 /mi") and lets them type a new one. Writes through
 * parent `onChange` (which in turn persists via `useRunnerProfile`).
 *
 * Pace is the input the user actually thinks about; unit drives how the
 * displayed pace and all route stats are formatted everywhere else.
 */
export default function RunnerProfileEditor({
  profile,
  onChange,
  compact = false,
}: Props) {
  const [draft, setDraft] = useState<string>(() =>
    formatPace(profile.paceSecPerKm, profile.unit).replace(/\s*\/.*$/, ""),
  );
  const [error, setError] = useState<string | null>(null);

  // Re-sync the draft when the unit flips so the user sees pace in the new unit
  const [lastUnit, setLastUnit] = useState<DistanceUnit>(profile.unit);
  if (lastUnit !== profile.unit) {
    setDraft(formatPace(profile.paceSecPerKm, profile.unit).replace(/\s*\/.*$/, ""));
    setLastUnit(profile.unit);
    setError(null);
  }

  const commit = () => {
    const parsed = parsePace(draft, profile.unit);
    if (parsed == null) {
      setError("Try a format like 6:00");
      return;
    }
    setError(null);
    onChange({ ...profile, paceSecPerKm: parsed });
  };

  return (
    <div
      className={`flex flex-col gap-1.5 ${compact ? "" : "rounded-md border border-pace-line bg-pace-panel/50 p-3"}`}
    >
      <div className="flex items-center gap-2">
        <label className="font-bebas text-[11px] tracking-[0.12em] text-pace-muted">
          Easy pace
        </label>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="6:00"
          aria-label={`Your easy pace, formatted as minutes:seconds per ${profile.unit === "mi" ? "mile" : "kilometer"}`}
          className="w-16 rounded border border-pace-line bg-pace-white px-1.5 py-1 text-center font-mono text-[12px] text-pace-ink outline-none focus:border-pace-yellow focus:ring-2 focus:ring-pace-yellow/40"
        />
        <span className="font-bebas text-[11px] tracking-[0.12em] text-pace-muted">
          /
        </span>
        {/* Inline km / mi toggle — two tiny pill buttons */}
        <div
          className="inline-flex overflow-hidden rounded border border-pace-line"
          role="radiogroup"
          aria-label="Distance unit"
        >
          {(["km", "mi"] as DistanceUnit[]).map((u) => {
            const active = profile.unit === u;
            return (
              <button
                key={u}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange({ ...profile, unit: u })}
                className={`px-2 py-1 font-bebas text-[11px] tracking-[0.12em] transition ${
                  active
                    ? "bg-pace-yellow text-pace-ink"
                    : "bg-pace-white text-pace-muted hover:text-pace-ink"
                }`}
              >
                {u}
              </button>
            );
          })}
        </div>
      </div>
      {error ? (
        <p className="text-[11px] text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {!compact ? (
        <p className="text-[10px] leading-snug text-pace-muted">
          Your typical easy-run pace. Lives in this browser, drives the time
          estimates and units across every step.
        </p>
      ) : null}
    </div>
  );
}
