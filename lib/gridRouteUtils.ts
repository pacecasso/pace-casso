import { haversineMeters } from "./haversine";
import type { LatLng } from "./routeLegByLeg";

const EPS = 1e-5;

function legAxis(a: LatLng, b: LatLng): "lat" | "lng" | "diag" {
  const dLat = Math.abs(a[0] - b[0]);
  const dLng = Math.abs(a[1] - b[1]);
  if (dLat < EPS && dLng > EPS) return "lng";
  if (dLng < EPS && dLat > EPS) return "lat";
  return "diag";
}

export function mergeCollinearOutline(pts: LatLng[]): LatLng[] {
  if (pts.length < 3) return pts.slice();
  const closed =
    haversineMeters(pts[0]!, pts[pts.length - 1]!) < 3 ? pts.slice(0, -1) : pts.slice();
  if (closed.length < 3) return pts;

  const out: LatLng[] = [closed[0]!];
  for (let i = 1; i < closed.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = closed[i]!;
    const next = closed[(i + 1) % closed.length]!;
    const ab = legAxis(prev, cur);
    const bc = legAxis(cur, next);
    if (ab === "diag" || bc === "diag" || ab !== bc) {
      out.push(cur);
      continue;
    }
    const sameDir =
      ab === "lat"
        ? Math.sign(cur[0] - prev[0]) === Math.sign(next[0] - cur[0])
        : Math.sign(cur[1] - prev[1]) === Math.sign(next[1] - cur[1]);
    if (!sameDir) out.push(cur);
  }
  if (haversineMeters(pts[0]!, pts[pts.length - 1]!) < 3) {
    out.push(closed[0]!);
  }
  return out;
}

export function decomposeToAxisAnchors(anchors: LatLng[]): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    if (i === 0) {
      out.push(a);
      continue;
    }
    const prev = out[out.length - 1]!;
    const dLat = Math.abs(a[0] - prev[0]);
    const dLng = Math.abs(a[1] - prev[1]);
    if (dLat > 1e-6 && dLng > 1e-6) {
      const cornerA: LatLng = [a[0], prev[1]];
      const cornerB: LatLng = [prev[0], a[1]];
      const hopA = haversineMeters(prev, cornerA) + haversineMeters(cornerA, a);
      const hopB = haversineMeters(prev, cornerB) + haversineMeters(cornerB, a);
      out.push(hopA <= hopB ? cornerA : cornerB);
    }
    out.push(a);
  }
  return out;
}

export function assertAxisAlignedAnchors(anchors: LatLng[]): boolean {
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    const dLat = Math.abs(a[0] - b[0]);
    const dLng = Math.abs(a[1] - b[1]);
    if (dLat > 1e-5 && dLng > 1e-5) return false;
  }
  return true;
}

export function removeAdjacentBacktracks(coords: LatLng[], epsM = 12): LatLng[] {
  if (coords.length < 3) return coords;
  const out: LatLng[] = [coords[0]!];
  for (let i = 1; i < coords.length; i++) {
    const cur = coords[i]!;
    const prev = out[out.length - 1]!;
    if (out.length >= 2) {
      const prev2 = out[out.length - 2]!;
      const legIn = haversineMeters(prev2, prev);
      const legBack = haversineMeters(prev, cur);
      const legSkip = haversineMeters(prev2, cur);
      if (
        legIn > 8 &&
        legBack > 8 &&
        legSkip < epsM &&
        Math.abs(legIn + legBack - legSkip) < epsM * 2
      ) {
        out.pop();
        continue;
      }
    }
    if (haversineMeters(prev, cur) < 2) continue;
    out.push(cur);
  }
  return out;
}
