/**
 * STROKE EDITING — the step between the automatic draft and the export.
 *
 * The two routes Ralph has approved (gas, Sep 8; unicorn, Sep 12) were each an
 * automatic draft plus three or four stroke edits: drop a stroke, add a couple
 * ("make a window in the middle of the gas tank", "the gas line could go up to
 * the guy and connect to his headphone"). Cold judges scored those routes 0/3,
 * so the draft did not become objectively recognisable - a person made it
 * recognisable in four moves. That step has only ever existed as an offline
 * script driven by hand-written JSON (scripts/finisher-edit.ts).
 *
 * This is the same operation set, pure and testable, for the site to use.
 * Edits are expressed in the drawing's unit space (x,y in [-1,1], y up, before
 * the seat rotation), so they survive re-routing and re-seating.
 */
import type { Stroke, UnitPt } from "./strokePainter";

export type StrokeEdit =
  | { op: "drop"; index: number }
  | { op: "add"; stroke: Stroke }
  | { op: "replace"; index: number; stroke: Stroke }
  /** cut a closed ring open at the two vertices nearest these points */
  | { op: "cut"; index: number; at: [UnitPt, UnitPt] }
  /** draw order; entries are indices into the current stroke list */
  | { op: "sequence"; order: number[] };

const clonePts = (pts: UnitPt[]): UnitPt[] => pts.map((p) => [p[0], p[1]] as UnitPt);
export const cloneStroke = (s: Stroke): Stroke => ({ ...s, pts: clonePts(s.pts) });
export const cloneStrokeList = (s: Stroke[]): Stroke[] => s.map(cloneStroke);

/** index of the vertex nearest a point */
export function nearestVertex(pts: UnitPt[], at: UnitPt): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i]![0] - at[0], pts[i]![1] - at[1]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Cut a closed ring at two vertices, giving the two arcs between them as open
 * strokes. An open stroke is cut into the two pieces either side of the first
 * point; the second is ignored. Returns the pieces in place of the original.
 */
export function cutStroke(stroke: Stroke, at: [UnitPt, UnitPt]): Stroke[] {
  const pts = stroke.closed && stroke.pts.length > 1 &&
    stroke.pts[0]![0] === stroke.pts[stroke.pts.length - 1]![0] &&
    stroke.pts[0]![1] === stroke.pts[stroke.pts.length - 1]![1]
    ? stroke.pts.slice(0, -1)
    : stroke.pts.slice();
  const n = pts.length;
  if (n < 4) return [cloneStroke(stroke)];

  if (!stroke.closed) {
    const i = nearestVertex(pts, at[0]);
    if (i <= 0 || i >= n - 1) return [cloneStroke(stroke)];
    return [
      { ...stroke, closed: false, pts: clonePts(pts.slice(0, i + 1)) },
      { ...stroke, closed: false, pts: clonePts(pts.slice(i)) },
    ];
  }

  let a = nearestVertex(pts, at[0]);
  let b = nearestVertex(pts, at[1]);
  if (a === b) return [cloneStroke(stroke)];
  if (a > b) [a, b] = [b, a];
  const arc1 = pts.slice(a, b + 1);
  const arc2 = [...pts.slice(b), ...pts.slice(0, a + 1)];
  const out: Stroke[] = [];
  // a cut that leaves a stub of one or two points is not an arc worth drawing
  if (arc1.length >= 3) out.push({ ...stroke, closed: false, pts: clonePts(arc1) });
  if (arc2.length >= 3) out.push({ ...stroke, closed: false, pts: clonePts(arc2) });
  return out.length ? out : [cloneStroke(stroke)];
}

/**
 * Apply edits in order. Indices always refer to the stroke list AS IT IS when
 * that edit runs, so a UI that sends one edit per user action stays correct
 * without re-indexing anything.
 */
export function applyStrokeEdits(strokes: Stroke[], edits: StrokeEdit[]): Stroke[] {
  let out = cloneStrokeList(strokes);
  for (const e of edits) {
    switch (e.op) {
      case "drop": {
        if (e.index >= 0 && e.index < out.length) out.splice(e.index, 1);
        break;
      }
      case "add": {
        if (e.stroke.pts.length >= 2) out.push(cloneStroke(e.stroke));
        break;
      }
      case "replace": {
        if (e.index >= 0 && e.index < out.length && e.stroke.pts.length >= 2) {
          out[e.index] = cloneStroke(e.stroke);
        }
        break;
      }
      case "cut": {
        if (e.index >= 0 && e.index < out.length) {
          out.splice(e.index, 1, ...cutStroke(out[e.index]!, e.at));
        }
        break;
      }
      case "sequence": {
        const seen = new Set<number>();
        const next: Stroke[] = [];
        for (const i of e.order) {
          if (i >= 0 && i < out.length && !seen.has(i)) {
            seen.add(i);
            next.push(out[i]!);
          }
        }
        // anything the order forgot keeps its place at the end, never dropped
        for (let i = 0; i < out.length; i++) if (!seen.has(i)) next.push(out[i]!);
        out = next;
        break;
      }
    }
  }
  return out;
}

/** total length of a stroke in unit space */
export function strokeLength(s: Stroke): number {
  let n = 0;
  for (let i = 1; i < s.pts.length; i++) n += Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]);
  if (s.closed && s.pts.length > 1) {
    n += Math.hypot(s.pts[0]![0] - s.pts[s.pts.length - 1]![0], s.pts[0]![1] - s.pts[s.pts.length - 1]![1]);
  }
  return n;
}

/**
 * Drop strokes too short to survive routing. A stroke shorter than roughly one
 * block becomes a nub or a self-crossing scribble once it is snapped to
 * streets, so a user's stray tap should not reach the router.
 */
export function dropTinyStrokes(strokes: Stroke[], scaleM: number, minMetres: number): Stroke[] {
  return strokes.filter((s) => strokeLength(s) * scaleM >= minMetres);
}

/** a freehand path in canvas pixels -> a stroke in the drawing's unit space */
export function strokeFromCanvasPath(
  path: [number, number][],
  box: number,
  opts: { closed?: boolean; kind?: Stroke["kind"]; group?: number } = {},
): Stroke {
  const pts: UnitPt[] = path.map(([x, y]) => [(x / box) * 2 - 1, 1 - (y / box) * 2] as UnitPt);
  /**
   * Drop points closer together than the streets can tell apart. Blocks run
   * 80 m and up and the router hugs within 90 m, so at a typical half-size of
   * 1500 m anything under ~18 m (0.012 unit) is below the grid's resolution -
   * it is finger jitter, and keeping it only slows the router down.
   */
  const MIN_STEP_U = 0.012;
  const thinned: UnitPt[] = [];
  for (const p of pts) {
    const last = thinned[thinned.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > MIN_STEP_U) thinned.push(p);
  }
  const closed = Boolean(opts.closed);
  if (closed && thinned.length > 2) thinned.push([thinned[0]![0], thinned[0]![1]]);
  return {
    kind: opts.kind ?? "thin",
    closed,
    pts: thinned,
    ...(opts.group !== undefined ? { group: opts.group } : {}),
  };
}
