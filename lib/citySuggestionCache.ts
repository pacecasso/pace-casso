/**
 * Per-browser cache of Claude's shape suggestions for each city. A single
 * Sonnet call costs ~$0.01 — cheap, but we don't need to pay it on every
 * city switch. Cache for 24 hours.
 */

export type CitySuggestion = {
  title: string;
  description: string;
  difficulty: "simple" | "medium" | "elaborate";
  iconic: boolean;
};

type CachedEntry = {
  suggestions: CitySuggestion[];
  savedAt: string;
};

const STORAGE_KEY = "pacecasso-city-suggestions-v1";
const TTL_MS = 24 * 60 * 60 * 1000;

function loadAll(): Record<string, CachedEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, CachedEntry>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

function saveAll(all: Record<string, CachedEntry>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* quota / private mode */
  }
}

function isValid(entry: CachedEntry): boolean {
  if (!entry || !Array.isArray(entry.suggestions)) return false;
  if (!entry.savedAt) return false;
  const age = Date.now() - new Date(entry.savedAt).getTime();
  return age >= 0 && age <= TTL_MS;
}

export function loadCachedSuggestions(
  cityId: string,
): CitySuggestion[] | null {
  const all = loadAll();
  const entry = all[cityId];
  if (!entry || !isValid(entry)) return null;
  return entry.suggestions;
}

export function saveCachedSuggestions(
  cityId: string,
  suggestions: CitySuggestion[],
): void {
  const all = loadAll();
  all[cityId] = {
    suggestions,
    savedAt: new Date().toISOString(),
  };
  saveAll(all);
}
