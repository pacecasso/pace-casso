/**
 * Pure logic for the artist loop — the automated interpret → place → compile
 * → blind-judge pipeline (scripts/artist-loop-poc.ts, commit bc96b3e),
 * extracted so the server-side design path (app/api/artist-loop) and offline
 * scripts share one implementation. Everything here is side-effect free and
 * unit-testable; rendering, Anthropic calls, and the lattice compile live in
 * artistLoopServer.ts.
 *
 * Geometry frame: identical to the hand-built GAS v4 winner — x runs along
 * Manhattan streets (119°), y along avenues (29°), so axis-aligned sketch
 * edges land on single streets after compiling.
 */
import type { LatLng } from "./latticeCompiler";
import type { StreetDesignPoint } from "./streetDesignSketch";

export type Pt = [number, number];

export const STREET_BEARING = 119;
export const AVENUE_BEARING = 29;
const M_PER_LAT = 111320;

function unit(deg: number): { e: number; n: number } {
  const r = (deg * Math.PI) / 180;
  return { e: Math.sin(r), n: Math.cos(r) };
}
const X_AXIS = unit(STREET_BEARING);
const Y_AXIS = unit(AVENUE_BEARING);

export function toLatLngFrom(origin: LatLng, [x, y]: Pt): LatLng {
  const e = x * X_AXIS.e + y * Y_AXIS.e;
  const n = x * X_AXIS.n + y * Y_AXIS.n;
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng];
}

export function toLocalFrom(origin: LatLng, [lat, lng]: LatLng): Pt {
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng;
  const det = X_AXIS.e * Y_AXIS.n - Y_AXIS.e * X_AXIS.n;
  return [(e * Y_AXIS.n - Y_AXIS.e * n) / det, (X_AXIS.e * n - e * X_AXIS.n) / det];
}

/** p25 "stroke" length (spans between >35° turns) in normalized units. */
export function strokeStats(pts: StreetDesignPoint[]): {
  p25: number;
  perimeter: number;
  strokes: number;
} {
  let perimeter = 0;
  const strokes: number[] = [];
  let strokeLen = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]!.x - pts[i - 1]!.x;
    const dy = pts[i]!.y - pts[i - 1]!.y;
    const d = Math.hypot(dx, dy);
    perimeter += d;
    strokeLen += d;
    if (i < pts.length - 1) {
      const dx2 = pts[i + 1]!.x - pts[i]!.x;
      const dy2 = pts[i + 1]!.y - pts[i]!.y;
      const l2 = Math.hypot(dx2, dy2);
      if (d > 1e-9 && l2 > 1e-9) {
        const cos = Math.max(-1, Math.min(1, (dx * dx2 + dy * dy2) / (d * l2)));
        if ((Math.acos(cos) * 180) / Math.PI > 35) {
          if (strokeLen > 0.004) strokes.push(strokeLen);
          strokeLen = 0;
        }
      }
    }
  }
  if (strokeLen > 0.004) strokes.push(strokeLen);
  strokes.sort((a, b) => a - b);
  return {
    p25: strokes.length ? strokes[Math.floor(strokes.length * 0.25)]! : 0,
    perimeter,
    strokes: strokes.length,
  };
}

/**
 * The hand-authored winners (gas-interp-v4) locked every boxy edge exactly
 * onto avenue columns / street rows; that is why their meanDev was ~13 m
 * while free-floating sketches compile at ~35-45 m with chopped legs.
 * Automated version: any maximal run of consecutive points that stays within
 * a tight band in one axis while extending far in the other is "a straight
 * edge the artist meant" — collapse the band to its mean so the edge is
 * perfectly axis-aligned. Curves (both axes moving) are untouched.
 */
export function axisAlign(local: Pt[]): Pt[] {
  const out: Pt[] = local.map((p) => [p[0], p[1]]);
  const BAND = 90; // max wobble across the edge, meters
  const SPAN = 250; // min edge length along the edge, meters
  for (const axis of [0, 1] as const) {
    const other = axis === 0 ? 1 : 0;
    let start = 0;
    while (start < out.length - 1) {
      let lo = out[start]![axis];
      let hi = lo;
      let end = start;
      while (end + 1 < out.length) {
        const v = out[end + 1]![axis];
        if (Math.max(hi, v) - Math.min(lo, v) > BAND) break;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        end++;
      }
      if (end > start) {
        const span = Math.abs(out[end]![other] - out[start]![other]);
        if (span >= SPAN) {
          let mean = 0;
          for (let k = start; k <= end; k++) mean += out[k]![axis];
          mean /= end - start + 1;
          for (let k = start; k <= end; k++) out[k]![axis] = mean;
        }
      }
      start = Math.max(end, start + 1);
    }
  }
  return out;
}

/**
 * Normalized 0..1 sketch (y down) → grid-frame meters (y up, north along
 * avenues), scaled by the rule learned from the hand-built winners: complex
 * subjects are drawn as HUGE as the uniform-grid window allows (reference
 * GPS art spans whole neighborhoods; that size is what lets identity
 * features survive block-level quantization). Caps: ≤2.45 km wide (10th Ave
 * → 1st Ave), ≤3.3 km tall (the uniform grid window), route ≤32 km. Simple
 * closed shapes may stay modest. Floor: at least a 4 km route and never a
 * sub-kilometre drawing.
 */
export function toMeters(pts: StreetDesignPoint[]): {
  local: Pt[];
  widthM: number;
  heightM: number;
  routeKm: number;
} {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(1e-6, maxX - minX);
  const h = Math.max(1e-6, maxY - minY);
  const { p25, perimeter, strokes } = strokeStats(pts);

  const caps = Math.min(2450 / w, 3300 / h, 32000 / Math.max(perimeter, 1e-6));
  let mpu = caps;
  if (strokes < 6) {
    // simple closed shapes: big enough to read, no need to eat the island
    if (p25 > 0) mpu = Math.min(Math.max(170 / p25, 1200 / Math.max(w, h)), caps);
  }
  const floor = Math.max(4000 / Math.max(perimeter, 1e-6), 900 / Math.max(w, h));
  mpu = Math.max(Math.min(mpu, caps), Math.min(floor, caps));

  const local: Pt[] = pts.map((p) => [
    (p.x - minX) * mpu,
    (maxY - p.y) * mpu, // flip: image y-down → grid y-up
  ]);
  return {
    local: axisAlign(local),
    widthM: w * mpu,
    heightM: h * mpu,
    routeKm: (perimeter * mpu) / 1000,
  };
}

/**
 * Street simulator: what block quantization does to a drawing, without
 * paying for a real compile. Snap every vertex to the Manhattan lattice
 * spacing (274 m avenue columns × 80 m street rows in the grid frame).
 * A composition that dies here will die on real streets.
 */
export function simulateStreets(local: Pt[]): Pt[] {
  const AVE = 274;
  const ST = 80;
  // resample at ~40 m so long diagonals staircase like real compiled legs
  const dense: Pt[] = [];
  for (let i = 0; i < local.length; i++) {
    const a = local[i]!;
    if (i === 0) {
      dense.push(a);
      continue;
    }
    const p = local[i - 1]!;
    const d = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const steps = Math.max(1, Math.round(d / 40));
    for (let s = 1; s <= steps; s++) {
      dense.push([p[0] + ((a[0] - p[0]) * s) / steps, p[1] + ((a[1] - p[1]) * s) / steps]);
    }
  }
  const out: Pt[] = [];
  for (const [x, y] of dense) {
    const q: Pt = [Math.round(x / AVE) * AVE, Math.round(y / ST) * ST];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== q[0] || prev[1] !== q[1]) out.push(q);
  }
  return out;
}

/**
 * Placement window: the uniform Manhattan grid only — ~15th St to ~57th St,
 * 10th Ave to 2nd Ave. Below 14th the colonial/Village grids rotate away
 * from the 119°/29° frame and compiled edges dissolve into wobble.
 */
export const CANDIDATE_CENTERS: { name: string; center: LatLng }[] = [
  { name: "grid-sw", center: [40.744, -73.997] },
  { name: "grid-s", center: [40.746, -73.99] },
  { name: "grid-se", center: [40.744, -73.983] },
  { name: "grid-c", center: [40.751, -73.99] },
  { name: "grid-cw", center: [40.752, -73.996] },
  { name: "grid-ce", center: [40.75, -73.982] },
  { name: "grid-n", center: [40.757, -73.986] },
  { name: "grid-nw", center: [40.759, -73.992] },
];

/** SVG of local-frame polylines (white background, y flipped back to screen). */
export function localSvg(
  paths: { pts: Pt[]; color: string; width: number }[],
  w = 900,
): string {
  const all = paths.flatMap((p) => p.pts);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs) - 150;
  const maxX = Math.max(...xs) + 150;
  const minY = Math.min(...ys) - 150;
  const maxY = Math.max(...ys) + 150;
  const scale = w / (maxX - minX);
  const h = Math.round((maxY - minY) * scale);
  const px = ([x, y]: Pt) =>
    `${((x - minX) * scale).toFixed(1)} ${((maxY - y) * scale).toFixed(1)}`;
  const body = paths
    .map(
      (p) =>
        `<path d="${p.pts.map((q, i) => `${i === 0 ? "M" : "L"} ${px(q)}`).join(" ")}" ` +
        `fill="none" stroke="${p.color}" stroke-width="${p.width}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join("\n");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="white"/>${body}</svg>`;
}

/**
 * Tolerant JSON extraction for designer responses: strips markdown fences,
 * and repairs truncated output by cutting back to the last complete `}` and
 * closing whatever brackets remain open.
 */
export function parseJsonLoose(text: string): unknown {
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  if (start < 0) throw new Error("no JSON object in response");
  const end = stripped.lastIndexOf("}");
  if (end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      /* fall through to truncation repair */
    }
  }
  let body = stripped.slice(start);
  const lastObj = body.lastIndexOf("}");
  if (lastObj < 0) throw new Error("unrepairable JSON in response");
  body = body.slice(0, lastObj + 1);
  let depthCurly = 0;
  let depthSquare = 0;
  for (const ch of body) {
    if (ch === "{") depthCurly++;
    else if (ch === "}") depthCurly--;
    else if (ch === "[") depthSquare++;
    else if (ch === "]") depthSquare--;
  }
  body += "]".repeat(Math.max(0, depthSquare)) + "}".repeat(Math.max(0, depthCurly));
  return JSON.parse(body);
}

/** Generic words that appear in guesses about anything — matching on them
 *  would let "dog head" count as recognition of "head with headphones". */
const GENERIC_TOKENS = new Set([
  "head", "face", "animal", "figure", "shape", "object", "thing",
  "drawing", "picture", "outline", "body", "man", "woman",
]);

function normGuess(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter((w) => !GENERIC_TOKENS.has(w));
}

export function guessMatches(guess: string, acceptable: string[]): boolean {
  const g = normGuess(guess);
  if (!g.length || guess.toLowerCase().includes("nothing recognizable")) return false;
  for (const a of acceptable) {
    const at = normGuess(a);
    if (!at.length) continue;
    if (at.some((t) => g.includes(t)) || g.some((t) => at.includes(t))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared client/server result types for the /api/artist-loop design path
// ---------------------------------------------------------------------------
export type ArtistLoopProgress = {
  stage:
    | "designing"
    | "sketch-judge"
    | "sim-judge"
    | "compiling"
    | "street-judge"
    | "round-done";
  detail: string;
  round: number;
};

export type ArtistLoopRouteResult = {
  label: string;
  description: string;
  acceptableGuesses: string[];
  /** Designer sketch, normalized 0..1 (image frame) — becomes the app contour. */
  sketchPoints: StreetDesignPoint[];
  /** Placed intended sketch in lat/lng — becomes anchorLatLngs (the green art line). */
  sketchLatLngs: LatLng[];
  /** Compiled street route on real junctions — becomes preferredSnappedRoute. */
  chain: LatLng[];
  distanceMeters: number;
  center: LatLng;
  meanDeviationMeters: number;
  /** Blind-judge outcome for the winning round (0-3 strangers recognized it). */
  recognizedCount: number;
  medianConfidence: number;
  guesses: string[];
  roundsRun: number;
};
