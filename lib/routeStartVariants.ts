import { haversineMeters } from "./haversine";

type Waypoint = [number, number];

const CLOSED_GAP_M = 90;
const CLOSED_GAP_RATIO = 0.08;

function pathLengthMeters(coords: Waypoint[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1]!, coords[i]!);
  }
  return total;
}

function dedupeConsecutive(coords: Waypoint[], epsM = 0.5): Waypoint[] {
  const out: Waypoint[] = [];
  for (const p of coords) {
    const last = out[out.length - 1];
    if (!last || haversineMeters(last, p) > epsM) out.push(p);
  }
  return out;
}

function withoutClosingDuplicate(coords: Waypoint[]): Waypoint[] {
  if (coords.length < 2) return coords.slice();
  const out = dedupeConsecutive(coords);
  if (out.length >= 2 && haversineMeters(out[0]!, out[out.length - 1]!) <= CLOSED_GAP_M) {
    return out.slice(0, -1);
  }
  return out;
}

export function isClosedLoopCandidate(coords: Waypoint[]): boolean {
  if (coords.length < 4) return false;
  const gap = haversineMeters(coords[0]!, coords[coords.length - 1]!);
  if (gap <= CLOSED_GAP_M) return true;
  const len = pathLengthMeters(coords);
  return len > 0 && gap / len <= CLOSED_GAP_RATIO;
}

export function buildClosedLoopStartVariants(
  coords: Waypoint[],
  count: number,
): Waypoint[][] {
  const requested = Math.max(1, Math.floor(count));
  if (!isClosedLoopCandidate(coords) || requested <= 1) return [coords.slice()];

  const ring = withoutClosingDuplicate(coords);
  if (ring.length < 4) return [coords.slice()];

  const includeReverseDirection = requested >= 4;
  const forwardCount = includeReverseDirection
    ? Math.max(1, Math.ceil(requested / 2))
    : requested;
  const reverseCount = includeReverseDirection
    ? Math.max(1, requested - forwardCount)
    : 0;

  const startsForCount = (n: number): number[] => {
    const starts = new Set<number>([0]);
    for (let i = 1; i < n; i++) {
      starts.add(Math.floor((ring.length * i) / n));
    }
    return [...starts];
  };

  const rotate = (source: Waypoint[], start: number): Waypoint[] => {
    const first = source[start]!;
    return [...source.slice(start), ...source.slice(0, start), first];
  };

  const variants: Waypoint[][] = [];
  for (const start of startsForCount(forwardCount)) {
    variants.push(rotate(ring, start));
  }

  if (reverseCount > 0) {
    const reversedRing = [ring[0]!, ...ring.slice(1).reverse()];
    for (const start of startsForCount(reverseCount)) {
      variants.push(rotate(reversedRing, start));
    }
  }

  return variants.slice(0, requested);
}

function reversedVariantIsMeaningful(a: Waypoint[], b: Waypoint[]): boolean {
  if (a.length !== b.length || a.length < 2) return true;
  return (
    haversineMeters(a[0]!, b[0]!) > 0.5 ||
    haversineMeters(a[a.length - 1]!, b[b.length - 1]!) > 0.5
  );
}

export function buildRouteStartVariants(
  coords: Waypoint[],
  count: number,
): Waypoint[][] {
  const requested = Math.max(1, Math.floor(count));
  if (isClosedLoopCandidate(coords)) {
    return buildClosedLoopStartVariants(coords, requested);
  }
  const base = coords.slice();
  if (requested <= 1 || base.length < 3) return [base];
  const reversed = [...base].reverse();
  return reversedVariantIsMeaningful(base, reversed) ? [base, reversed] : [base];
}
