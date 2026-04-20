/**
 * Runner profile: pace + unit preference, persisted in localStorage so route
 * stats can be rendered in the units Dan actually thinks in ("7.1 mi · 1h 24m"
 * instead of "11.4 km"). Canonical storage is pace-per-kilometer; display-per-
 * unit is derived at format time.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "pacecasso-runner-profile-v1";
/** 6:00 /km, moderate easy pace. Keeps first-time users from seeing "0:00". */
export const DEFAULT_PACE_SEC_PER_KM = 360;
export const DEFAULT_UNIT: DistanceUnit = "km";
const MIN_PACE_SEC_PER_KM = 120; // 2:00/km — elite pro pace; any tighter is a typo
const MAX_PACE_SEC_PER_KM = 1200; // 20:00/km — brisk walk

export type DistanceUnit = "km" | "mi";

export type RunnerProfile = {
  paceSecPerKm: number;
  unit: DistanceUnit;
};

export const DEFAULT_RUNNER_PROFILE: RunnerProfile = {
  paceSecPerKm: DEFAULT_PACE_SEC_PER_KM,
  unit: DEFAULT_UNIT,
};

const KM_PER_MI = 1.609344;

export function loadRunnerProfile(): RunnerProfile {
  if (typeof window === "undefined") return DEFAULT_RUNNER_PROFILE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RUNNER_PROFILE;
    const parsed = JSON.parse(raw) as Partial<RunnerProfile>;
    const pace =
      typeof parsed.paceSecPerKm === "number" &&
      Number.isFinite(parsed.paceSecPerKm)
        ? clampPace(parsed.paceSecPerKm)
        : DEFAULT_PACE_SEC_PER_KM;
    const unit: DistanceUnit = parsed.unit === "mi" ? "mi" : "km";
    return { paceSecPerKm: pace, unit };
  } catch {
    return DEFAULT_RUNNER_PROFILE;
  }
}

export function saveRunnerProfile(p: RunnerProfile): void {
  if (typeof window === "undefined") return;
  try {
    const safe: RunnerProfile = {
      paceSecPerKm: clampPace(p.paceSecPerKm),
      unit: p.unit === "mi" ? "mi" : "km",
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    /* ignore quota / private-mode */
  }
}

function clampPace(secPerKm: number): number {
  if (!Number.isFinite(secPerKm)) return DEFAULT_PACE_SEC_PER_KM;
  return Math.max(MIN_PACE_SEC_PER_KM, Math.min(MAX_PACE_SEC_PER_KM, secPerKm));
}

/**
 * React hook. Loads once on mount (localStorage read is synchronous but we
 * keep it in an effect to avoid SSR hydration mismatch when default values
 * differ from persisted ones). Write-through updater keeps localStorage in sync.
 */
export function useRunnerProfile(): [
  RunnerProfile,
  (p: RunnerProfile) => void,
] {
  const [profile, setProfile] = useState<RunnerProfile>(DEFAULT_RUNNER_PROFILE);
  useEffect(() => {
    setProfile(loadRunnerProfile());
  }, []);
  const update = (next: RunnerProfile) => {
    const safe: RunnerProfile = {
      paceSecPerKm: clampPace(next.paceSecPerKm),
      unit: next.unit === "mi" ? "mi" : "km",
    };
    setProfile(safe);
    saveRunnerProfile(safe);
  };
  return [profile, update];
}

/** "11.4 km" or "7.1 mi" (1-decimal) — consistent across Steps 2/4/5. */
export function formatDistance(distanceKm: number, unit: DistanceUnit): string {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return unit === "mi" ? "— mi" : "— km";
  }
  if (unit === "mi") {
    return `${(distanceKm / KM_PER_MI).toFixed(1)} mi`;
  }
  return `${distanceKm.toFixed(1)} km`;
}

/**
 * Short time format tuned for route lengths (minutes → hours). "24 min",
 * "1h 24m", or "2h 05m". Never "90m" or "0h 24m".
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** "6:00 /km" or "9:39 /mi" — canonical display for a runner's pace. */
export function formatPace(paceSecPerKm: number, unit: DistanceUnit): string {
  const secPerUnit = unit === "mi" ? paceSecPerKm * KM_PER_MI : paceSecPerKm;
  const s = Math.max(0, Math.round(secPerUnit));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")} /${unit}`;
}

/** Parse "6:00" / "6:30" / "06:45" — for the profile editor input. */
export function parsePace(text: string, unit: DistanceUnit): number | null {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const mins = parseInt(m[1]!, 10);
  const secs = parseInt(m[2]!, 10);
  if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null;
  if (secs > 59) return null;
  const perUnit = mins * 60 + secs;
  const perKm = unit === "mi" ? perUnit / KM_PER_MI : perUnit;
  return clampPace(perKm);
}

/** Total seconds to run `distanceKm` at the given pace. */
export function estimateSeconds(
  distanceKm: number,
  paceSecPerKm: number,
): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  return distanceKm * paceSecPerKm;
}

/** "11.4 km · 1h 24m" — the canonical one-line stat display. */
export function formatRouteStats(
  distanceKm: number,
  profile: RunnerProfile,
): string {
  const d = formatDistance(distanceKm, profile.unit);
  const t = formatDuration(estimateSeconds(distanceKm, profile.paceSecPerKm));
  return `${d} · ${t}`;
}
