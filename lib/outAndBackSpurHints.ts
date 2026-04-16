import { distanceAlongPolylineToPoint } from "./alongPolylineMeters";

/** Max along-route span (B→C) to treat as a short spur (m). */
const MAX_SPUR_ALONG_ROUTE_M = 520;

/** Max sum of Mapbox step distances for cues from B through before C (m). */
const MAX_SPUR_STEP_SUM_M = 380;

export type CueLike = {
  lat: number;
  lng: number;
  instruction: string;
  street: string | null;
  stepDistanceM?: number;
  stepDurationS?: number;
  maneuverType?: string;
  maneuverModifier?: string;
  /** Set by assignAlongRouteMeters; stripped before returning to UI. */
  alongRouteM?: number;
};

function normalizeStreetToken(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/\s*—\s*.+$/, "")
    .trim();
}

function isGenericPathLabel(s: string | null | undefined): boolean {
  if (!s || !s.trim()) return true;
  const t = s.trim().toLowerCase();
  return (
    /^(walkway|footway|footpath|path|pedestrian|sidewalk|crosswalk|crossing|steps|stairs|track|cycleway|bridleway|corridor|platform)$/i.test(
      t,
    ) ||
    /^unnamed$/i.test(t) ||
    t === "walking path"
  );
}

function effectiveStreetKey(c: CueLike): string | null {
  if (c.street && !isGenericPathLabel(c.street)) {
    return normalizeStreetToken(c.street);
  }
  const inst = c.instruction.trim();
  const turnOnto = inst.match(
    /^turn\s+(?:sharp\s+)?(?:left|right)\s+onto\s+(.+?)(?:\.|\s*—|\s*$)/i,
  );
  if (turnOnto) {
    const raw = turnOnto[1].trim();
    if (!isGenericPathLabel(raw)) return normalizeStreetToken(raw);
  }
  const bearOnto = inst.match(
    /^bear\s+(?:left|right)\s+onto\s+(.+?)(?:\.|\s*—|\s*$)/i,
  );
  if (bearOnto) {
    const raw = bearOnto[1].trim();
    if (!isGenericPathLabel(raw)) return normalizeStreetToken(raw);
  }
  const cont = inst.match(/^continue\s+on\s+(.+?)(?:\.|\s*—|\s*$)/i);
  if (cont) {
    const raw = cont[1].trim();
    if (!isGenericPathLabel(raw)) return normalizeStreetToken(raw);
  }
  const walk = inst.match(
    /^walk\s+(?:north|south|east|west|northeast|northwest|southeast|southwest)(?:\s+on\s+)?(.+?)(?:\.|\s*—|\s*$)/i,
  );
  if (walk) {
    const raw = walk[1].trim();
    if (
      !/^the\s+(walkway|footway|path|crosswalk)\b/i.test(raw) &&
      !isGenericPathLabel(raw)
    ) {
      return normalizeStreetToken(raw);
    }
  }
  const head = inst.match(/^head\s+along\s+(.+?)(?:\.|\s*—|\s*$)/i);
  if (head) {
    const raw = head[1].trim();
    if (!isGenericPathLabel(raw)) return normalizeStreetToken(raw);
  }
  return null;
}

function parseTurnOrBearOntoKey(inst: string): string | null {
  const main = inst.replace(/\s*—\s*.+$/s, "").trim();
  const m = main.match(
    /^(turn\s+(?:sharp\s+)?(?:left|right)|bear\s+(?:left|right))\s+onto\s+(.+?)\.?$/i,
  );
  if (!m) return null;
  const raw = m[2].trim();
  if (isGenericPathLabel(raw)) return null;
  return normalizeStreetToken(raw);
}

function titleCaseKey(key: string): string {
  return key
    .split(/\s+/)
    .map((w) => {
      if (!w) return w;
      if (/^\d/.test(w)) return w;
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

function sumStepDistanceForSpur(
  cues: CueLike[],
  bIdx: number,
  cIdx: number,
): number {
  let s = 0;
  for (let i = bIdx; i < cIdx; i++) {
    s += cues[i]?.stepDistanceM ?? 0;
  }
  return s;
}

/**
 * Labels short Main → Cross → … → Main patterns for cue sheets.
 * Expects `alongRouteM` set when `referenceLine` was passed into cue generation.
 */
export function annotateOutAndBackSpurs(cues: CueLike[]): CueLike[] {
  const out = cues.map((c) => ({ ...c }));
  const n = out.length;
  if (n < 3) return out;

  for (let bIdx = 1; bIdx < n - 1; bIdx++) {
    const A = out[bIdx - 1];
    const B = out[bIdx];
    if (!A || !B) continue;

    if (B.instruction.includes("out-and-back")) continue;

    const keyA = effectiveStreetKey(A);
    const keyB = effectiveStreetKey(B);
    if (!keyA || !keyB) continue;
    if (keyB === keyA) continue;

    const ontoB = parseTurnOrBearOntoKey(B.instruction);
    if (!ontoB || ontoB !== keyB) continue;

    for (let cIdx = bIdx + 1; cIdx < n; cIdx++) {
      const C = out[cIdx];
      if (!C) continue;

      const ontoC = parseTurnOrBearOntoKey(C.instruction);
      if (!ontoC || ontoC !== keyA) continue;
      if (effectiveStreetKey(C) !== keyA) continue;

      const alongB = B.alongRouteM;
      const alongC = C.alongRouteM;
      let alongSpan = Infinity;
      if (alongB != null && alongC != null && alongC >= alongB) {
        alongSpan = alongC - alongB;
      }
      const okAlong = alongSpan <= MAX_SPUR_ALONG_ROUTE_M;

      const stepSum = sumStepDistanceForSpur(out, bIdx, cIdx);
      const okStep = stepSum > 0 && stepSum <= MAX_SPUR_STEP_SUM_M;

      if (!okAlong && !okStep) continue;

      const mainDisplay = titleCaseKey(keyA);
      const suffix = ` (short out-and-back, then return to ${mainDisplay})`;
      B.instruction = `${B.instruction.trim().replace(/\.+$/, "")}${suffix}.`;
      break;
    }
  }

  return out;
}

/** Attach cumulative meters along `referenceLine` for spur detection. */
export function assignAlongRouteMeters(
  cues: CueLike[],
  referenceLine: [number, number][],
): void {
  if (referenceLine.length < 2) return;
  for (const c of cues) {
    const p: [number, number] = [c.lat, c.lng];
    c.alongRouteM = distanceAlongPolylineToPoint(referenceLine, p);
  }
}

export function stripAlongRouteMeters<T extends CueLike>(cues: T[]): T[] {
  return cues.map((c) => {
    const { alongRouteM: _drop, ...rest } = c;
    return rest as T;
  });
}
