/**
 * sketchInterpret — pure pieces of the AI "street-ready redraw" step.
 *
 * The model drafts a bold one-line interpretation of an upload as a small
 * JSON program over drawing primitives (line / arc / quadratic bezier),
 * one program per stroke. This module compiles and validates that program
 * into normalized contour points, and scores blind-judge guesses against
 * the intended subject. All vision I/O lives in sketchInterpretServer.ts.
 *
 * Grounded in the July 2026 measurement series (WOW.md): every route that
 * ever blind-read on streets came from a bold, closed, icon-grade line
 * drawing — this is the machinery that turns arbitrary uploads into that
 * class of drawing, subject to blind-judge verification.
 */
import type { NormalizedPoint } from "./streetGraphTrace";

export type Primitive =
  | { type: "line"; points: [number, number][] }
  | { type: "arc"; cx: number; cy: number; r: number; startDeg: number; endDeg: number }
  | { type: "bez"; p0: [number, number]; c: [number, number]; p1: [number, number] };

export type PrimitiveProgram = {
  strokes: { elements: Primitive[] }[];
};

export const MAX_PROGRAM_STROKES = 4;
export const MAX_PROGRAM_ELEMENTS = 48;

type Pt = [number, number]; // shape space, y-UP, 0..1000

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pair(v: unknown): Pt | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const x = num(v[0]);
  const y = num(v[1]);
  return x == null || y == null ? null : [x, y];
}

/** Parse + validate an untrusted primitive program (model output). */
export function parsePrimitiveProgram(raw: unknown): PrimitiveProgram | null {
  if (!raw || typeof raw !== "object") return null;
  const strokesRaw = (raw as { strokes?: unknown }).strokes;
  if (!Array.isArray(strokesRaw) || !strokesRaw.length) return null;
  const strokes: { elements: Primitive[] }[] = [];
  let elementCount = 0;
  for (const s of strokesRaw.slice(0, MAX_PROGRAM_STROKES)) {
    const elsRaw = s && typeof s === "object" ? (s as { elements?: unknown }).elements : null;
    if (!Array.isArray(elsRaw)) continue;
    const elements: Primitive[] = [];
    for (const e of elsRaw) {
      if (elementCount >= MAX_PROGRAM_ELEMENTS) break;
      if (!e || typeof e !== "object") continue;
      const t = (e as { type?: unknown }).type;
      if (t === "line") {
        const ptsRaw = (e as { points?: unknown }).points;
        if (!Array.isArray(ptsRaw)) continue;
        const points = ptsRaw.map(pair).filter((p): p is Pt => p !== null);
        if (points.length >= 2) {
          elements.push({ type: "line", points });
          elementCount++;
        }
      } else if (t === "arc") {
        const cx = num((e as { cx?: unknown }).cx);
        const cy = num((e as { cy?: unknown }).cy);
        const r = num((e as { r?: unknown }).r);
        const startDeg = num((e as { startDeg?: unknown }).startDeg);
        const endDeg = num((e as { endDeg?: unknown }).endDeg);
        if (cx != null && cy != null && r != null && r > 0 && startDeg != null && endDeg != null) {
          elements.push({ type: "arc", cx, cy, r, startDeg, endDeg });
          elementCount++;
        }
      } else if (t === "bez") {
        const p0 = pair((e as { p0?: unknown }).p0);
        const c = pair((e as { c?: unknown }).c);
        const p1 = pair((e as { p1?: unknown }).p1);
        if (p0 && c && p1) {
          elements.push({ type: "bez", p0, c, p1 });
          elementCount++;
        }
      }
    }
    if (elements.length) strokes.push({ elements });
  }
  return strokes.length ? { strokes } : null;
}

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number): Pt[] {
  const n = Math.max(8, Math.min(64, Math.ceil(Math.abs(a1 - a0) / 8)));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

function bezPts(p0: Pt, c: Pt, p1: Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    out.push([
      (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
      (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1],
    ]);
  }
  return out;
}

/** Compile a validated program to y-up 0..1000 polyline strokes. */
export function compilePrimitiveProgram(program: PrimitiveProgram): Pt[][] {
  const strokes: Pt[][] = [];
  for (const stroke of program.strokes) {
    const pts: Pt[] = [];
    for (const e of stroke.elements) {
      const seg =
        e.type === "line" ? e.points :
        e.type === "arc" ? arcPts(e.cx, e.cy, e.r, e.startDeg, e.endDeg) :
        bezPts(e.p0, e.c, e.p1);
      for (const p of seg) {
        const clamped: Pt = [
          Math.max(0, Math.min(1000, p[0])),
          Math.max(0, Math.min(1000, p[1])),
        ];
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(clamped[0] - last[0], clamped[1] - last[1]) > 0.5) {
          pts.push(clamped);
        }
      }
    }
    if (pts.length >= 2) strokes.push(pts);
  }
  return strokes;
}

/**
 * Convert compiled strokes to the app's normalized contour format
 * (y-down, 0..1, one flat array). Each stroke is densified to short
 * segments so downstream connector detection (which keys on segment
 * length vs the median) recognizes the jumps BETWEEN strokes as pen
 * lifts instead of merging everything into one stroke.
 */
export function strokesToContour(strokes: Pt[][], maxPoints = 550): NormalizedPoint[] {
  const densified: Pt[][] = strokes.map((seg) => {
    const out: Pt[] = [];
    for (let i = 0; i < seg.length; i++) {
      const a = seg[i]!;
      out.push(a);
      const b = seg[i + 1];
      if (!b) continue;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(d / 12));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  });
  let total = densified.reduce((n, s) => n + s.length, 0);
  // Even-stride decimation per stroke when over budget.
  const out: NormalizedPoint[] = [];
  for (const seg of densified) {
    const keep = total > maxPoints ? Math.max(2, Math.floor((seg.length * maxPoints) / total)) : seg.length;
    const stride = seg.length / keep;
    for (let i = 0; i < keep; i++) {
      const p = seg[Math.min(seg.length - 1, Math.floor(i * stride))]!;
      out.push({ x: p[0] / 1000, y: 1 - p[1] / 1000 });
    }
  }
  return out;
}

/**
 * Simulate street quantization: snap a drawing to a Manhattan-pitch lattice
 * (~250 m avenue x ~80 m street blocks at a 3.5 km canvas) with L-shaped
 * connections. The July SURVIVABILITY series showed lattice renders predict
 * street recognizability far better than clean renders — judging THIS
 * version during drafting closes the paper-passes/streets-fail gap.
 */
export function snapStrokesToLattice(
  strokes: Pt[][],
  extentM = 3500,
  pitchXM = 250,
  pitchYM = 80,
): Pt[][] {
  const all = strokes.flat();
  if (!all.length) return [];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  const mPerUnit = extentM / span;
  const px = pitchXM / mPerUnit; // lattice pitch in shape units
  const py = pitchYM / mPerUnit;
  return strokes.map((seg) => {
    // densify then snap each sample; join with horizontal-first L corners
    const dense: Pt[] = [];
    for (let i = 0; i < seg.length; i++) {
      const a = seg[i]!;
      dense.push(a);
      const b = seg[i + 1];
      if (!b) continue;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil((d * mPerUnit) / 40));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    const snapped: Pt[] = [];
    for (const [x, y] of dense) {
      const p: Pt = [Math.round((x - minX) / px) * px + minX, Math.round((y - minY) / py) * py + minY];
      const last = snapped[snapped.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) snapped.push(p);
    }
    const out: Pt[] = [];
    for (const p of snapped) {
      const last = out[out.length - 1];
      if (last && last[0] !== p[0] && last[1] !== p[1]) out.push([p[0], last[1]]);
      out.push(p);
    }
    return out.length >= 2 ? out : snapped;
  }).filter((s) => s.length >= 2);
}

const STOP_WORDS = new Set([
  "the", "and", "with", "person", "figure", "shape", "logo", "line", "drawing",
  "image", "picture", "icon", "symbol", "simple", "abstract", "outline",
  // Accessory verbs from composite subjects ("a person WEARING headphones").
  // July 28: a draft judged as "person wearing hat" false-passed the subject
  // "a person wearing headphones" because "wearing" counted as a match.
  // Pose verbs (running, walking) stay matchable — "a running person" vs
  // judge's "running person" is a real hit.
  "wearing", "holding", "carrying", "using", "riding",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => (w.endsWith("s") ? w.slice(0, -1) : w));
}

/**
 * Does a blind judge's guess match the intended subject? Token overlap on
 * meaningful words, singular/plural-insensitive. "person" and other filler
 * words don't count — the July data shows judges emit them for tangles.
 */
export function guessMatchesSubject(subject: string, guess: string): boolean {
  const s = new Set(tokens(subject));
  if (!s.size) return false;
  for (const g of tokens(guess)) {
    if (s.has(g)) return true;
  }
  return false;
}
