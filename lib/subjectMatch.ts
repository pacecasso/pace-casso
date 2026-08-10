/**
 * Deterministic subject-label matching for the blind acceptance gate.
 *
 * A blind judge names a route with free text ("Lightning bolt", "a dog");
 * the funnel's subject is also free text ("lightning bolt"). This module
 * decides cheaply whether two labels plausibly name the same subject; the
 * caller falls back to a text-model equivalence check only when this says
 * no (synonyms like "cross" vs "plus sign").
 */
const STOPWORDS = new Set([
  "a", "an", "the", "of", "with", "and", "or", "some", "its", "it", "is",
  "shape", "shaped", "outline", "drawing", "sign", "symbol", "icon", "logo",
  "simple", "small", "big", "large", "little",
]);

/** Lowercase, strip punctuation, drop articles/filler, naive singularize. */
export function normalizeSubjectLabel(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/**
 * True when the labels share a content word, or one label's word contains
 * the other's (length >= 4, so "sailboat" matches "boat" but "monkey" does
 * not match "key").
 */
export function subjectLabelsMatchLoose(a: string, b: string): boolean {
  const wa = normalizeSubjectLabel(a);
  const wb = normalizeSubjectLabel(b);
  if (!wa.length || !wb.length) return false;
  for (const x of wa) {
    for (const y of wb) {
      if (x === y) return true;
      if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
    }
  }
  return false;
}
