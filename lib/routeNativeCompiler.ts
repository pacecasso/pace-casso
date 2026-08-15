import { haversineMeters } from "./haversine";

export type RouteNativeCandidateInput = {
  designIntent?: string;
  kind?: string;
  routeMode?: string;
  km?: number;
  anchors?: [number, number][];
};

export type RouteNativeSubjectProfile = {
  features: string[];
  complexity: "simple" | "standard" | "detailed";
  preferredMinKm: number;
  preferredMaxKm: number;
  maxKm: number;
  minDirectGridPoints: number;
};

export type RouteNativeContinuityStats = {
  pointCount: number;
  maxHopMeters: number;
  p95HopMeters: number;
  longHopCount: number;
};

export type RouteNativeCandidateScore = {
  score: number;
  semanticCoverage: number;
  distanceScore: number;
  continuityScore: number;
  detailScore: number;
  routeNativeBonus: number;
  artifactPenalty: number;
  runnableDirectGrid: boolean;
  reason: string;
};

const STOP_WORDS = new Set([
  "and",
  "art",
  "bold",
  "clean",
  "draft",
  "feature",
  "features",
  "gps",
  "icon",
  "line",
  "logo",
  "mark",
  "outline",
  "route",
  "street",
  "stroke",
  "symbol",
  "the",
  "with",
]);

function singularize(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensFor(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .map((token) => singularize(token.trim()))
    .filter((token) => token && !STOP_WORDS.has(token));
}

function featureKey(feature: string): string | null {
  const tokens = tokensFor(feature);
  if (tokens.length === 0) return null;
  return tokens.slice(0, 3).join(" ");
}

function tokenSetFor(text: string): Set<string> {
  const raw = tokensFor(text);
  const expanded = raw.flatMap((token) => {
    const out = [token];
    if (token === "trainer") out.push("shoe", "sneaker");
    if (token === "lace") out.push("laces");
    if (token === "human") out.push("person", "figure");
    if (token === "torso") out.push("body");
    if (token === "fuel") out.push("gas", "pump");
    if (token === "nozzle") out.push("hose");
    if (token === "tip") out.push("toe", "point");
    return out;
  });
  return new Set(expanded);
}

function featureMatches(feature: string, textTokens: Set<string>): boolean {
  const tokens = tokensFor(feature);
  if (tokens.length === 0) return false;
  const matched = tokens.filter((token) => textTokens.has(token)).length;
  if (tokens.length === 1) return matched === 1;
  return matched / tokens.length >= 0.5;
}

export function routeNativeFeatureCoverage(
  text: string | undefined,
  features: string[],
): number {
  const normalizedFeatures = features
    .map(featureKey)
    .filter((feature): feature is string => feature != null);
  if (normalizedFeatures.length === 0) return 100;
  const textTokens = tokenSetFor(text ?? "");
  const matched = normalizedFeatures.filter((feature) =>
    featureMatches(feature, textTokens),
  ).length;
  return Math.round((matched / normalizedFeatures.length) * 100);
}

function hasAnyFeature(features: string[], pattern: RegExp): boolean {
  return features.some((feature) => pattern.test(feature));
}

export function buildRouteNativeSubjectProfile(
  features: string[],
): RouteNativeSubjectProfile {
  const normalized = features
    .map(featureKey)
    .filter((feature): feature is string => feature != null);
  const joined = normalized.join(" ");
  const detailedSubject =
    normalized.length >= 5 ||
    /\b(sneaker|shoe|lace|sole|toe|heel|gas|pump|hose|person|figure|face|head|body)\b/.test(joined);
  const simpleSubject =
    normalized.length <= 2 &&
    hasAnyFeature(normalized, /\b(heart|star|bolt|arrow|diamond|circle|square)\b/);
  const complexity = detailedSubject ? "detailed" : simpleSubject ? "simple" : "standard";
  if (complexity === "detailed") {
    return {
      features: normalized,
      complexity,
      preferredMinKm: 12,
      preferredMaxKm: 32,
      maxKm: 35,
      minDirectGridPoints: 220,
    };
  }
  if (complexity === "simple") {
    return {
      features: normalized,
      complexity,
      preferredMinKm: 4,
      preferredMaxKm: 16,
      maxKm: 24,
      minDirectGridPoints: 24,
    };
  }
  return {
    features: normalized,
    complexity,
    preferredMinKm: 7,
    preferredMaxKm: 24,
    maxKm: 30,
    minDirectGridPoints: 80,
  };
}

export function routeNativeContinuityStats(
  anchors: [number, number][] | undefined,
): RouteNativeContinuityStats {
  if (!anchors || anchors.length < 2) {
    return { pointCount: anchors?.length ?? 0, maxHopMeters: Infinity, p95HopMeters: Infinity, longHopCount: 0 };
  }
  const hops: number[] = [];
  for (let i = 1; i < anchors.length; i++) {
    hops.push(haversineMeters(anchors[i - 1]!, anchors[i]!));
  }
  const sorted = hops.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? Infinity;
  return {
    pointCount: anchors.length,
    maxHopMeters: sorted[sorted.length - 1] ?? Infinity,
    p95HopMeters: p95,
    longHopCount: hops.filter((hop) => hop > 220).length,
  };
}

function distanceScore(km: number | undefined, profile: RouteNativeSubjectProfile): number {
  if (km == null || !Number.isFinite(km) || km <= 0) return 50;
  if (km > profile.maxKm) return Math.max(0, 45 - (km - profile.maxKm) * 8);
  if (km >= profile.preferredMinKm && km <= profile.preferredMaxKm) return 100;
  if (km < profile.preferredMinKm) {
    return Math.max(0, 100 - (profile.preferredMinKm - km) * 9);
  }
  return Math.max(45, 100 - (km - profile.preferredMaxKm) * 4);
}

function continuityScore(stats: RouteNativeContinuityStats): number {
  if (stats.pointCount < 2 || !Number.isFinite(stats.maxHopMeters)) return 0;
  let score = 100;
  if (stats.maxHopMeters > 180) score -= Math.min(45, (stats.maxHopMeters - 180) * 0.35);
  if (stats.p95HopMeters > 85) score -= Math.min(25, (stats.p95HopMeters - 85) * 0.45);
  score -= Math.min(30, stats.longHopCount * 6);
  return Math.max(0, Math.round(score));
}

function detailScore(
  candidate: RouteNativeCandidateInput,
  profile: RouteNativeSubjectProfile,
): number {
  const count = candidate.anchors?.length ?? 0;
  if (candidate.routeMode !== "direct-grid") {
    return profile.complexity === "detailed" ? 68 : 78;
  }
  if (count >= profile.minDirectGridPoints) return 100;
  if (profile.minDirectGridPoints <= 24) return Math.min(100, (count / profile.minDirectGridPoints) * 100);
  return Math.max(0, Math.round((count / profile.minDirectGridPoints) * 85));
}

function routeNativeBonus(candidate: RouteNativeCandidateInput): number {
  const text = normalizeText(candidate.designIntent ?? "");
  let bonus = 0;
  if (candidate.kind === "street-design" || candidate.kind === "street-wordmark") bonus += 20;
  if (candidate.routeMode === "direct-grid") bonus += 30;
  if (/\b(verified|curated|tuned|runnable|gpx|street polyline|real street|real pavement)\b/.test(text)) {
    bonus += 30;
  }
  if (/\b(semantic|representative|inspired|interpretation)\b/.test(text)) bonus += 8;
  return Math.min(100, bonus);
}

function artifactPenalty(candidate: RouteNativeCandidateInput): number {
  const text = normalizeText(candidate.designIntent ?? "");
  let penalty = 0;
  if (/\b(generic|grid etched|scribble|noisy|mush|weak|fallback)\b/.test(text)) penalty += 18;
  const stats = routeNativeContinuityStats(candidate.anchors);
  if (stats.pointCount > 0 && stats.pointCount < 8) penalty += 22;
  if (stats.longHopCount > 0) penalty += Math.min(25, stats.longHopCount * 5);
  return Math.min(60, penalty);
}

export function isRunnableRouteNativeCandidate(
  candidate: RouteNativeCandidateInput,
  features: string[] = [],
): boolean {
  if (candidate.routeMode !== "direct-grid") return false;
  const profile = buildRouteNativeSubjectProfile(features);
  const stats = routeNativeContinuityStats(candidate.anchors);
  if ((candidate.km ?? 0) <= 0 || (candidate.km ?? 0) > profile.maxKm) return false;
  if (stats.pointCount < profile.minDirectGridPoints) return false;
  if (stats.maxHopMeters > 300 || stats.longHopCount > 2) return false;
  return true;
}

export function scoreRouteNativeCandidate(
  candidate: RouteNativeCandidateInput,
  features: string[],
): RouteNativeCandidateScore {
  const profile = buildRouteNativeSubjectProfile(features);
  const semanticCoverage = routeNativeFeatureCoverage(candidate.designIntent, profile.features);
  const dist = distanceScore(candidate.km, profile);
  const stats = routeNativeContinuityStats(candidate.anchors);
  const continuity = continuityScore(stats);
  const detail = detailScore(candidate, profile);
  const nativeBonus = routeNativeBonus(candidate);
  const penalty = artifactPenalty(candidate);
  const score = Math.round(
    semanticCoverage * 0.34 +
      dist * 0.2 +
      continuity * 0.18 +
      detail * 0.18 +
      nativeBonus * 0.1 -
      penalty,
  );
  const clamped = Math.max(0, Math.min(100, score));
  const runnableDirectGrid = isRunnableRouteNativeCandidate(candidate, profile.features);
  return {
    score: clamped,
    semanticCoverage,
    distanceScore: Math.round(dist),
    continuityScore: continuity,
    detailScore: Math.round(detail),
    routeNativeBonus: nativeBonus,
    artifactPenalty: penalty,
    runnableDirectGrid,
    reason: `route-native ${clamped}/100: ${semanticCoverage}% cue coverage, ${Math.round(candidate.km ?? 0)} km, ${stats.pointCount} pts, max hop ${Number.isFinite(stats.maxHopMeters) ? Math.round(stats.maxHopMeters) : "?"} m`,
  };
}

export function orderRouteNativeCandidates<T extends RouteNativeCandidateInput>(
  candidates: T[],
  features: string[],
): T[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreRouteNativeCandidate(candidate, features).score,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ candidate }) => candidate);
}