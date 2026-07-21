/**
 * Lattice wordmark typesetter: draws words as single-line block letters
 * whose every stroke IS a real Manhattan street — vertical strokes ride
 * avenue lines, horizontal strokes ride cross streets, and every corner
 * is a junction from the named-street lattice. Runnable by construction.
 *
 * This exists because the floating word classes (block wordmarks, the
 * symbol lockup) were removed from the instant flow: their geometry sits
 * mid-block and corridor-snapping it destroys the letterforms. Typesetting
 * directly ON the lattice sidesteps that physics — proven July 21 with a
 * two-row JUST / DO IT at 19 km that 3/3 blind judges read at confidence
 * 7-8 while being 100% street-true.
 *
 * The grid bearings are orthogonal (avenues ~28.4°, streets ~118.4°), so
 * a rotated (x = along streets, y = along avenues) basis turns the lattice
 * into near-vertical avenue lines and near-horizontal street lines that
 * 1-D histogram-peak clustering recovers. Broadway's diagonal scatters
 * nodes at every x, which is why peak detection is used instead of gap
 * clustering (gaps chain-merge neighbouring avenues).
 */
import type { LatLng, LatticeGraph } from "./latticeCompiler";

const M_PER_LAT = 111320;
const mPerLng = (lat: number) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);
const ORIGIN: LatLng = [40.75, -73.985];
const rad = (d: number) => (d * Math.PI) / 180;

const meters = (a: LatLng, b: LatLng) =>
  Math.hypot((b[0] - a[0]) * M_PER_LAT, (b[1] - a[1]) * mPerLng(a[0]));

type Basis = { AX: { e: number; n: number }; AY: { e: number; n: number } };

function makeBasis(aveBearingDeg: number): Basis {
  return {
    AX: { e: Math.sin(rad(aveBearingDeg + 90)), n: Math.cos(rad(aveBearingDeg + 90)) },
    AY: { e: Math.sin(rad(aveBearingDeg)), n: Math.cos(rad(aveBearingDeg)) },
  };
}

function toXY(b: Basis, p: LatLng): { x: number; y: number } {
  const e = (p[1] - ORIGIN[1]) * mPerLng(ORIGIN[0]);
  const n = (p[0] - ORIGIN[0]) * M_PER_LAT;
  return { x: e * b.AX.e + n * b.AX.n, y: e * b.AY.e + n * b.AY.n };
}

/** Mean avenue bearing measured from the lattice's own avenue-class edges. */
function measureAvenueBearing(g: LatticeGraph): number {
  let sumSin = 0;
  let sumCos = 0;
  for (const [from, entries] of g.adj) {
    for (const e of entries) {
      if (e.to <= from) continue;
      const A = g.nodes[from]!;
      const B = g.nodes[e.to]!;
      const de = (B[1] - A[1]) * mPerLng(A[0]);
      const dn = (B[0] - A[0]) * M_PER_LAT;
      let brg = (Math.atan2(de, dn) * 180) / Math.PI;
      if (brg < 0) brg += 180;
      if (Math.abs(brg - 29) > 12) continue;
      const r2 = rad(brg * 2);
      sumSin += Math.sin(r2);
      sumCos += Math.cos(r2);
    }
  }
  if (sumSin === 0 && sumCos === 0) return 29;
  let mean = (Math.atan2(sumSin, sumCos) * 90) / Math.PI;
  if (mean < 0) mean += 180;
  return mean;
}

/** Histogram peak detection for grid line positions. */
function clusterLines(values: number[], binM: number, minCount: number): number[] {
  const bins = new Map<number, number[]>();
  for (const v of values) {
    const k = Math.round(v / binM);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k)!.push(v);
  }
  const count = (k: number) => bins.get(k)?.length ?? 0;
  const lines: number[] = [];
  const keys = [...bins.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    if (count(k) < minCount) continue;
    if (count(k - 1) > count(k) || count(k + 1) >= count(k)) continue;
    const vals = [...(bins.get(k - 1) ?? []), ...(bins.get(k) ?? []), ...(bins.get(k + 1) ?? [])];
    const center = vals.reduce((s, v) => s + v, 0) / vals.length;
    if (lines.length && center - lines[lines.length - 1]! < binM * 2.5) continue;
    lines.push(center);
  }
  return lines;
}

/**
 * Glyphs on a unit box: x fractions map to avenue lines ({0,1} = edges,
 * 0.5 = an interior line), y fractions map to street lines. Each glyph is
 * one continuous pen-down polyline; retraces are fine (the runner just
 * runs the block twice). A point's optional third element marks the leg
 * INTO it as diagonal — the corridor A* staircases those along real
 * streets instead of demanding a straight run.
 *
 * Start/end corners are chosen so inter-letter connectors ride the cap or
 * base rails and never weld a spurious stem onto a glyph (the S->"9"
 * failure class from the floating-wordmark era).
 */
type GlyphPt = [number, number] | [number, number, 1];
export const LATTICE_GLYPHS: Record<string, { w: 0 | 1 | 2; path: GlyphPt[] }> = {
  A: { w: 1, path: [[0, 0], [0, 0.7], [0.5, 1, 1], [1, 0.7, 1], [1, 0], [1, 0.5], [0, 0.5]] },
  B: { w: 1, path: [[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5], [1, 0.5], [1, 0], [0, 0]] },
  C: { w: 1, path: [[1, 0], [0, 0], [0, 1], [1, 1]] },
  D: { w: 1, path: [[0, 0], [0, 1], [0.7, 1], [1, 0.72, 1], [1, 0.28], [0.7, 0, 1], [0, 0]] },
  E: { w: 1, path: [[1, 1], [0, 1], [0, 0.5], [0.8, 0.5], [0, 0.5, 1], [0, 0], [1, 0]] },
  F: { w: 1, path: [[1, 1], [0, 1], [0, 0.5], [0.8, 0.5], [0, 0.5, 1], [0, 0]] },
  G: { w: 1, path: [[1, 1], [0, 1], [0, 0], [1, 0], [1, 0.45], [0.5, 0.45]] },
  H: { w: 1, path: [[0, 1], [0, 0], [0, 0.5], [1, 0.5], [1, 1], [1, 0]] },
  I: { w: 0, path: [[0, 0], [0, 1], [0, 0]] },
  J: { w: 1, path: [[0, 0.35], [0, 0], [1, 0], [1, 1], [0, 1]] },
  K: { w: 1, path: [[0, 1], [0, 0], [0, 0.5], [1, 1, 1], [0, 0.5, 1], [1, 0, 1]] },
  L: { w: 1, path: [[0, 1], [0, 0], [1, 0]] },
  M: { w: 1, path: [[0, 0], [0, 1], [0.5, 0.55, 1], [1, 1, 1], [1, 0]] },
  N: { w: 1, path: [[0, 0], [0, 1], [1, 0, 1], [1, 1]] },
  O: { w: 1, path: [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]] },
  P: { w: 1, path: [[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5]] },
  Q: { w: 1, path: [[1, 0], [0, 0], [0, 1], [1, 1], [1, 0], [0.55, 0.45, 1]] },
  R: { w: 1, path: [[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5], [1, 0, 1]] },
  S: { w: 1, path: [[1, 1], [0, 1], [0, 0.5], [1, 0.5], [1, 0], [0, 0]] },
  T: { w: 2, path: [[0.5, 0], [0.5, 1], [0, 1], [1, 1]] },
  U: { w: 1, path: [[0, 1], [0, 0], [1, 0], [1, 1]] },
  V: { w: 1, path: [[0, 1], [0.5, 0, 1], [1, 1, 1]] },
  W: { w: 1, path: [[0, 1], [0.25, 0, 1], [0.5, 0.55, 1], [0.75, 0, 1], [1, 1, 1]] },
  X: { w: 1, path: [[0, 1], [1, 0, 1], [0.5, 0.5, 1], [0, 0, 1], [1, 1, 1]] },
  Y: { w: 2, path: [[0.5, 0], [0.5, 0.5], [0, 1, 1], [0.5, 0.5, 1], [1, 1, 1]] },
  Z: { w: 1, path: [[0, 1], [1, 1], [0, 0, 1], [1, 0]] },
};

type Pen = "draw" | "move" | "diag";
type Placed = { x: number; y: number; pen: Pen };

function nearestLine(lines: number[], target: number): number {
  let best = lines[0]!;
  for (const l of lines) if (Math.abs(l - target) < Math.abs(best - target)) best = l;
  return best;
}

function lineBetween(lines: number[], lo: number, hi: number, target: number): number | null {
  const inside = lines.filter((l) => l > lo + 1 && l < hi - 1);
  if (!inside.length) return null;
  let best = inside[0]!;
  for (const l of inside) if (Math.abs(l - target) < Math.abs(best - target)) best = l;
  return best;
}

function typesetRow(
  word: string,
  aveLines: number[],
  streetLines: number[],
  xStart: number,
  yBase: number,
  heightM: number,
  letterWidthM: number,
): { pts: Placed[]; xEnd: number } {
  const base = nearestLine(streetLines, yBase);
  const cap = nearestLine(streetLines, yBase + heightM);
  const pts: Placed[] = [];
  let cursor = xStart;
  for (const ch of word) {
    if (ch === " ") {
      cursor += letterWidthM * 0.8;
      continue;
    }
    const g = LATTICE_GLYPHS[ch];
    if (!g) throw new Error(`no glyph ${ch}`);
    const idealW = letterWidthM * (g.w === 2 ? 1.6 : Math.max(g.w, 0.001));
    // Strictly monotonic line selection: nearest-line can step BACK onto
    // the previous letter; widths are clamped so 155 m east-side spacing
    // and 278 m west-side spacing both yield letter-shaped letters.
    const leftCands = aveLines.filter((l) => l >= cursor - 30);
    if (!leftCands.length) throw new Error("row ran out of avenues");
    const left = leftCands[0]!;
    const rightCands = aveLines.filter(
      (l) => l >= left + Math.max(200, idealW * 0.7) && l <= left + idealW * 1.35,
    );
    if (g.w > 0 && !rightCands.length) throw new Error("no right edge line");
    const right =
      g.w === 0
        ? left
        : rightCands.reduce((a, b) =>
            Math.abs(b - left - idealW) < Math.abs(a - left - idealW) ? b : a,
          );
    const hasDiag = g.path.some((p) => p.length === 3);
    const mid = g.w === 2 && !hasDiag ? lineBetween(aveLines, left, right, (left + right) / 2) : null;
    if (g.w === 2 && !hasDiag && mid == null) throw new Error("no mid line for stem");
    const xOf = (f: number, diagLeg: boolean) =>
      diagLeg || (f !== 0 && f !== 0.5 && f !== 1)
        ? left + f * (right - left)
        : f === 0
          ? left
          : f === 1
            ? right
            : mid ?? left + 0.5 * (right - left);
    const yOf = (f: number, diagLeg: boolean) =>
      diagLeg
        ? base + (cap - base) * f
        : f === 0
          ? base
          : f === 1
            ? cap
            : nearestLine(streetLines, base + (cap - base) * f);
    g.path.forEach((p, i) => {
      const diagLeg = p.length === 3;
      pts.push({
        x: xOf(p[0], diagLeg),
        y: yOf(p[1], diagLeg),
        pen: i === 0 ? "move" : diagLeg ? "diag" : "draw",
      });
    });
    cursor = (g.w === 0 ? left : right) + 120;
  }
  return { pts, xEnd: cursor };
}

function distToSegXY(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * bx + (p.y - a.y) * by) / (bx * bx + by * by || 1)));
  return Math.hypot(p.x - a.x - t * bx, p.y - a.y - t * by);
}

function corridorAStar(
  g: LatticeGraph,
  xy: { x: number; y: number }[],
  na: number,
  nb: number,
  lambda: number,
  corridorM: number,
): number[] | null {
  const A = xy[na]!;
  const B = xy[nb]!;
  const open = new Map<number, number>([[na, 0]]);
  const gScore = new Map<number, number>([[na, 0]]);
  const came = new Map<number, number>();
  const done = new Set<number>();
  let guard = 0;
  while (open.size && guard++ < 40000) {
    let cur = -1;
    let cf = Infinity;
    for (const [n, f] of open) if (f < cf) { cf = f; cur = n; }
    if (cur === nb) {
      const ids = [cur];
      let c = cur;
      while (came.has(c)) { c = came.get(c)!; ids.push(c); }
      return ids.reverse();
    }
    open.delete(cur);
    done.add(cur);
    for (const e of g.adj.get(cur) ?? []) {
      if (done.has(e.to)) continue;
      const P = xy[e.to]!;
      const dc = distToSegXY(P, A, B);
      if (dc > corridorM) continue;
      const tentative = gScore.get(cur)! + e.len + lambda * dc;
      if (tentative < (gScore.get(e.to) ?? Infinity)) {
        came.set(e.to, cur);
        gScore.set(e.to, tentative);
        open.set(e.to, tentative + Math.hypot(P.x - B.x, P.y - B.y));
      }
    }
  }
  return null;
}

export type LatticeWordmarkResult = {
  /** Full coordinate chain — every vertex a lattice junction or curved-edge via point. */
  anchors: [number, number][];
  km: number;
  /** Total corner snap error across all pins, meters (quality signal). */
  pinErrM: number;
  rows: string[];
};

/** Pack words into ≤maxRows rows of ≤maxRowLetters letters. */
export function packWordRows(word: string, maxRowLetters = 5, maxRows = 3): string[] | null {
  const words = word.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const rows: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.replace(/ /g, "").length <= maxRowLetters) {
      cur = candidate;
    } else {
      if (cur) rows.push(cur);
      cur = w;
    }
  }
  if (cur) rows.push(cur);
  if (rows.length > maxRows) return null;
  if (rows.some((r) => r.replace(/ /g, "").length > maxRowLetters + 1)) return null;
  return rows;
}

/**
 * Typeset a word (or short phrase) onto the Manhattan lattice. Returns the
 * best placement found, or null when no window of the grid can hold the
 * text with every stroke street-true.
 */
export function typesetWordOnLattice(
  word: string,
  g: LatticeGraph,
): LatticeWordmarkResult | null {
  const clean = word
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.replace(/ /g, "").length < 2) return null;
  const rows = packWordRows(clean);
  if (!rows) return null;

  const basis = makeBasis(measureAvenueBearing(g));
  const xy = g.nodes.map((n) => toXY(basis, n));

  // Grid lines inside the uniform midtown window. The east cap at x=1100
  // (1st Avenue) matters: lines further east exist only at lower latitudes
  // and rows that reach them die on missing junctions.
  const windowIdx: number[] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    const ll = g.nodes[i]!;
    if (ll[0] > 40.736 && ll[0] < 40.768 && Math.abs(xy[i]!.x) < 2500) windowIdx.push(i);
  }
  const aveLines = clusterLines(windowIdx.map((i) => xy[i]!.x), 25, 12).filter((l) => l < 1100);
  const streetLines = clusterLines(windowIdx.map((i) => xy[i]!.y), 20, 8);
  if (aveLines.length < 6 || streetLines.length < 12) return null;

  const nearestNode = (x: number, y: number, maxM: number): number => {
    let best = -1;
    let bd = maxM;
    // Whole graph, not just the clustering window — corners near the
    // window's edge legitimately pin to junctions outside it, and the
    // squint-test-passing placement depends on those.
    for (let i = 0; i < xy.length; i++) {
      const d = Math.hypot(xy[i]!.x - x, xy[i]!.y - y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  const H = 560;
  const LW = 280;
  const ROWGAP = 260;
  let best: LatticeWordmarkResult | null = null;
  let bestErr = Infinity;

  for (let x0 = -1700; x0 <= -300; x0 += 100) {
    for (let yTop = -100; yTop <= 1300; yTop += 80) {
      try {
        const placedRows = rows.map((rowWord, r) =>
          typesetRow(rowWord, aveLines, streetLines, x0 + r * 60, yTop - (r + 1) * H - r * ROWGAP, H, LW),
        );
        const edgeX = Math.max(...placedRows.map((r) => r.xEnd)) + 140;
        const seq: Placed[] = [];
        placedRows.forEach((row, r) => {
          if (r > 0) {
            seq.push({ x: edgeX, y: seq[seq.length - 1]!.y, pen: "move" });
            seq.push({ x: edgeX, y: row.pts[0]!.y, pen: "move" });
          }
          seq.push(...row.pts);
        });
        const pins: { n: number; pen: Pen }[] = [];
        let err = 0;
        for (const p of seq) {
          const n = nearestNode(p.x, p.y, 78);
          if (n < 0) throw new Error("no junction near corner");
          err += Math.hypot(xy[n]!.x - p.x, xy[n]!.y - p.y);
          if (!pins.length || pins[pins.length - 1]!.n !== n) pins.push({ n, pen: p.pen });
        }
        const chain: LatLng[] = [];
        for (let i = 1; i < pins.length; i++) {
          const pen = pins[i]!.pen;
          let leg = corridorAStar(
            g, xy, pins[i - 1]!.n, pins[i]!.n,
            pen === "diag" ? 7 : 10,
            pen === "draw" ? 55 : pen === "diag" ? 95 : 130,
          );
          if (!leg && pen !== "draw") leg = corridorAStar(g, xy, pins[i - 1]!.n, pins[i]!.n, 3, 300);
          if (!leg) throw new Error("no street path for stroke");
          if (pen !== "move") {
            const A = xy[pins[i - 1]!.n]!;
            const B = xy[pins[i]!.n]!;
            const chord = Math.hypot(A.x - B.x, A.y - B.y);
            let plen = 0;
            for (let k = 1; k < leg.length; k++) plen += meters(g.nodes[leg[k - 1]!]!, g.nodes[leg[k]!]!);
            const cap = pen === "draw" ? chord * 1.35 + 40 : chord * 1.75 + 70;
            if (plen > cap) throw new Error("stroke detours");
          }
          for (let k = 0; k < leg.length; k++) {
            const node = g.nodes[leg[k]!]!;
            if (k > 0) {
              const entry = (g.adj.get(leg[k - 1]!) ?? []).find((e) => e.to === leg[k]);
              for (const v of entry?.via ?? []) chain.push(v);
            }
            const last = chain[chain.length - 1];
            if (!last || last[0] !== node[0] || last[1] !== node[1]) chain.push(node);
          }
        }
        let km = 0;
        for (let i = 1; i < chain.length; i++) km += meters(chain[i - 1]!, chain[i]!) / 1000;
        // Full sweep, global best by corner accuracy: clean placements are
        // rare (a handful per sweep) and the pinErr-best one is the one
        // that passed the blind squint test — early exit trades that away.
        if (err < bestErr) {
          bestErr = err;
          best = {
            anchors: chain.map((c) => [c[0], c[1]] as [number, number]),
            km,
            pinErrM: err,
            rows,
          };
        }
      } catch {
        // placement failed; try the next window
      }
    }
  }
  return best;
}
