import type { CuratedRun } from "./curatedManhattanRuns";
import {
  VERIFIED_ROUTE_BANK_SUBJECTS,
  type VerifiedRouteBankCityId,
} from "./verifiedRouteBankManifest";
import { VERIFIED_ROUTE_BANK_GALLERY_RUNS } from "./verifiedRouteBankGallery";

/**
 * Refusal offramp: when the placement funnel honestly refuses (nothing
 * cleared the judge's bar), find the closest blind-verified bank route to
 * offer instead of a dead end. Matching is by the bank manifest's feature
 * words against whatever subject text we have (AI-read subject, filename).
 * A match is an OFFER of a same-family verified route, clearly labeled —
 * never a silent substitution for the user's own art.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalize(text: string): string {
  return text
    .replace(/\.[a-z0-9]{1,6}$/i, " ")
    .replace(/[_\-./]+/g, " ")
    .toLowerCase();
}

export function matchVerifiedBankRun(
  subjectTexts: (string | null | undefined)[],
  cityId: VerifiedRouteBankCityId = "manhattan",
): CuratedRun | null {
  const text = subjectTexts
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map(normalize)
    .join(" ");
  if (!text.trim()) return null;

  let best: { run: CuratedRun; hits: number } | null = null;
  for (const subject of VERIFIED_ROUTE_BANK_SUBJECTS) {
    if (subject.cityId !== cityId) continue;
    const hits = subject.features.filter((feature) =>
      new RegExp(`\\b${escapeRegExp(feature.toLowerCase())}\\b`).test(text),
    ).length;
    if (hits === 0) continue;
    const run =
      VERIFIED_ROUTE_BANK_GALLERY_RUNS.find((r) => r.id === subject.id) ??
      VERIFIED_ROUTE_BANK_GALLERY_RUNS.find(
        (r) => r.id === `${subject.id}-${subject.cityId}`,
      );
    if (!run) continue;
    if (!best || hits > best.hits) best = { run, hits };
  }
  return best?.run ?? null;
}
