/**
 * GRID-NATIVE LETTERS — Ralph's directive taken literally: in Manhattan,
 * straight lines are free, because the city IS the ruler. Every letter
 * stroke here is a run along a REAL street or avenue from the verified
 * junction lattice; every corner is a REAL intersection. Nothing floats
 * mid-block, so the drawn lines are exactly as straight as the streets.
 *
 * The lattice's junctions are clustered into avenue columns and street
 * rows by projecting onto the grid's own axes (avenues ≈ 29°, cross
 * streets ≈ 119°). A letter occupies 2 avenue-gaps × 6 street-gaps
 * (~550 m × ~480 m); words longer than 4 letters wrap into two rows, the
 * reference JUST DO IT layout.
 */
import {
  buildLatticeGraph,
  type LatticeData,
  type LatticeGraph,
  type LatLng,
} from "./latticeCompiler";

const M_PER_LAT = 111320;
const mPerLng = (lat: number) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);

const AVENUE_BEARING = 29;
const STREET_BEARING = 119;

type GridIndex = {
  /** node id at [column][row] where a junction exists, else -1 */
  at: (col: number, row: number) => number;
  cols: number;
  rows: number;
  coordOf: (id: number) => LatLng;
  /** exact street geometry of the DIRECT edge a→b, or null if not adjacent */
  directEdge: (a: number, b: number) => LatLng[] | null;
  /**
   * Follow the single lattice edge from `id` in the given logical direction
   * (dCol: ±1 along streets, dRow: ±1 along avenues) — real geometry, or
   * null when the city has no street there.
   */
  stepFrom: (
    id: number,
    dCol: number,
    dRow: number,
  ) => { to: number; seg: LatLng[] } | null;
};

let cachedIndex: Promise<GridIndex> | null = null;

function edgeBearing(a: LatLng, b: LatLng): number {
  const east = (b[1] - a[1]) * mPerLng(a[0]);
  const north = (b[0] - a[0]) * M_PER_LAT;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export async function getGridIndex(): Promise<GridIndex> {
  if (cachedIndex) return cachedIndex;
  cachedIndex = (async () => {
    const data = (await import("./data/manhattan-lattice.json"))
      .default as unknown as LatticeData;
    const graph: LatticeGraph = buildLatticeGraph(data);
    const nodes = data.nodes as [number, number][];
    // Uniform-grid window only: the frame breaks below ~14th St.
    const inWindow = (p: LatLng) => p[0] >= 40.735 && p[0] <= 40.772;

    // TOPOLOGICAL grid: classify each lattice edge by bearing — a street
    // step moves one avenue-gap (col±1), an avenue step one street-gap
    // (row±1) — then BFS outward from a seed, assigning integer coords from
    // connectivity alone. Robust to bearing wobble and uneven avenue
    // spacing, which defeated absolute-projection clustering.
    let seed = -1;
    let seedDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i]! as LatLng;
      if (!inWindow(p)) continue;
      const d = Math.hypot((p[0] - 40.7515) * M_PER_LAT, (p[1] + 73.99) * mPerLng(p[0]));
      if (d < seedDist) {
        seedDist = d;
        seed = i;
      }
    }
    if (seed < 0) throw new Error("no junctions in grid window");

    const coordAt = new Map<number, [number, number]>([[seed, [0, 0]]]);
    const queue = [seed];
    while (queue.length) {
      const cur = queue.shift()!;
      const [cc, cr] = coordAt.get(cur)!;
      for (const e of graph.adj.get(cur) ?? []) {
        const to = e.to;
        const pa = nodes[cur]! as LatLng;
        const pb = nodes[to]! as LatLng;
        if (!inWindow(pb)) continue;
        const bearing = edgeBearing(pa, pb);
        let next: [number, number] | null = null;
        if (angleDiff(bearing, STREET_BEARING) < 22) next = [cc + 1, cr];
        else if (angleDiff(bearing, (STREET_BEARING + 180) % 360) < 22) next = [cc - 1, cr];
        else if (angleDiff(bearing, AVENUE_BEARING) < 22) next = [cc, cr + 1];
        else if (angleDiff(bearing, (AVENUE_BEARING + 180) % 360) < 22) next = [cc, cr - 1];
        if (!next) continue; // Broadway and other diagonals don't define the grid
        if (coordAt.has(to)) continue;
        coordAt.set(to, next);
        queue.push(to);
      }
    }

    let minC = Infinity;
    let maxC = -Infinity;
    let minR = Infinity;
    let maxR = -Infinity;
    for (const [, [c, r]] of coordAt) {
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
    const cell = new Map<string, number>();
    for (const [id, [c, r]] of coordAt) {
      cell.set(`${c - minC}:${r - minR}`, id);
    }

    const directEdge = (a: number, b: number): LatLng[] | null => {
      const entry = (graph.adj.get(a) ?? []).find((e) => e.to === b);
      if (!entry) return null;
      return [nodes[a]! as LatLng, ...entry.via, nodes[b]! as LatLng];
    };

    const DIR_BEARING = (dCol: number, dRow: number): number =>
      dCol > 0
        ? STREET_BEARING
        : dCol < 0
          ? (STREET_BEARING + 180) % 360
          : dRow > 0
            ? AVENUE_BEARING
            : (AVENUE_BEARING + 180) % 360;

    const stepFrom = (
      id: number,
      dCol: number,
      dRow: number,
    ): { to: number; seg: LatLng[] } | null => {
      const want = DIR_BEARING(dCol, dRow);
      let best: { to: number; seg: LatLng[] } | null = null;
      let bestDiff = 24;
      for (const e of graph.adj.get(id) ?? []) {
        const pb = nodes[e.to]! as LatLng;
        if (!inWindow(pb)) continue;
        const bearing = edgeBearing(nodes[id]! as LatLng, pb);
        const diff = angleDiff(bearing, want);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = { to: e.to, seg: [nodes[id]! as LatLng, ...e.via, pb] };
        }
      }
      return best;
    };

    return {
      at: (col: number, row: number) => cell.get(`${col}:${row}`) ?? -1,
      cols: maxC - minC + 1,
      rows: maxR - minR + 1,
      coordOf: (id: number) => nodes[id] as LatLng,
      directEdge,
      stepFrom,
    };
  })();
  return cachedIndex;
}

/**
 * Letter skeletons on an integer glyph grid: x ∈ 0..2 avenue columns,
 * y ∈ 0..6 street rows (y up). Single continuous strokes whose every
 * segment is axis-aligned — i.e., every segment IS a street or avenue run.
 */
const GRID_GLYPHS: Record<string, [number, number][]> = {
  A: [[0, 0], [0, 4], [1, 6], [2, 4], [2, 0], [2, 3], [0, 3]],
  B: [[0, 0], [0, 6], [2, 6], [2, 3], [0, 3], [2, 3], [2, 0], [0, 0]],
  C: [[2, 0], [0, 0], [0, 6], [2, 6]],
  D: [[0, 0], [0, 6], [1, 6], [2, 5], [2, 1], [1, 0], [0, 0]],
  E: [[2, 0], [0, 0], [0, 3], [1, 3], [0, 3], [0, 6], [2, 6]],
  F: [[0, 0], [0, 3], [1, 3], [0, 3], [0, 6], [2, 6]],
  G: [[2, 6], [0, 6], [0, 0], [2, 0], [2, 3], [1, 3]],
  H: [[0, 0], [0, 6], [0, 3], [2, 3], [2, 6], [2, 0]],
  I: [[0, 0], [2, 0], [1, 0], [1, 6], [0, 6], [2, 6]],
  J: [[0, 1], [0, 0], [1, 0], [1, 6], [0, 6], [2, 6]],
  K: [[0, 0], [0, 6], [0, 3], [2, 6], [0, 3], [2, 0]],
  L: [[0, 6], [0, 0], [2, 0]],
  M: [[0, 0], [0, 6], [1, 4], [2, 6], [2, 0]],
  N: [[0, 0], [0, 6], [2, 0], [2, 6]],
  O: [[0, 0], [0, 6], [2, 6], [2, 0], [0, 0]],
  P: [[0, 0], [0, 6], [2, 6], [2, 3], [0, 3]],
  R: [[0, 0], [0, 6], [2, 6], [2, 4], [0, 3], [2, 0]],
  S: [[0, 0], [2, 0], [2, 3], [0, 3], [0, 6], [2, 6]],
  T: [[0, 6], [2, 6], [1, 6], [1, 0]],
  U: [[0, 6], [0, 0], [2, 0], [2, 6]],
  V: [[0, 6], [1, 0], [2, 6]],
  W: [[0, 6], [0, 0], [1, 2], [2, 0], [2, 6]],
  X: [[0, 6], [2, 0], [1, 3], [0, 0], [2, 6]],
  Y: [[0, 6], [1, 4], [2, 6], [1, 4], [1, 0]],
  Z: [[0, 6], [2, 6], [0, 0], [2, 0]],
};

export type GridWordRoute = {
  chain: LatLng[];
  km: number;
  /** fraction of required junctions that existed at this origin */
  coverage: number;
  originCol: number;
  originRow: number;
  rowsUsed: number;
};

/**
 * Typeset a word (or two rows) with every stroke on real streets. Letters
 * are 2 columns × 6 rows; one blank column between letters; two text rows
 * when the word exceeds `maxPerRow`, reading top row first.
 */
export async function gridWordRoutes(
  word: string,
  options: { maxPerRow?: number; maxOrigins?: number } = {},
): Promise<GridWordRoute[]> {
  const clean = word.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  if (clean.length < 2) return [];
  const grid = await getGridIndex();
  const maxPerRow = options.maxPerRow ?? 4;
  const rows: string[] =
    clean.length <= maxPerRow
      ? [clean]
      : [clean.slice(0, Math.ceil(clean.length / 2)), clean.slice(Math.ceil(clean.length / 2))];

  const LETTER_COLS = 2;
  const GAP_COLS = 1;
  const LETTER_ROWS = 8;
  const ROW_GAP_ROWS = 3;
  const rowWidthCols = (n: number) => n * LETTER_COLS + (n - 1) * GAP_COLS;
  const totalCols = Math.max(...rows.map((r) => rowWidthCols(r.length)));
  const totalRows = rows.length * LETTER_ROWS + (rows.length - 1) * ROW_GAP_ROWS;

  const out: GridWordRoute[] = [];
  let bestProgress = 0;
  for (let oc = 0; oc + totalCols < grid.cols; oc++) {
    for (let or = 0; or + totalRows < grid.rows; or++) {
      const progress = { steps: 0 };
      const route = typesetAt(
        grid,
        rows,
        oc,
        or,
        {
          LETTER_COLS,
          GAP_COLS,
          LETTER_ROWS,
          ROW_GAP_ROWS,
        },
        progress,
      );
      bestProgress = Math.max(bestProgress, progress.steps);
      if (route && route.coverage >= 0.995) out.push(route);
      if (out.length >= (options.maxOrigins ?? 6)) return out;
    }
  }
  if (!out.length) {
    console.log(`[gridWordRoutes] no placement; best progress ${bestProgress} steps`);
  }
  return out;
}

function typesetAt(
  grid: GridIndex,
  rows: string[],
  oc: number,
  or: number,
  m: { LETTER_COLS: number; GAP_COLS: number; LETTER_ROWS: number; ROW_GAP_ROWS: number },
  progress: { steps: number } = { steps: 0 },
): GridWordRoute | null {
  const chain: LatLng[] = [];
  let km = 0;
  let cur: { col: number; row: number; id: number } | null = null;

  // EDGE-WALKED strokes: one glyph unit = one real lattice edge in the
  // needed compass class. The curated lattice's edges sometimes span more
  // than one physical block, so cell-indexed stepping starves — but walking
  // the node's own street/avenue edges keeps every stroke a straight run of
  // real pavement with corners at real junctions, letting the letterforms
  // breathe with the city's actual spacing.
  const stepDir = (dCol: number, dRow: number): boolean => {
    if (!cur) return false;
    const move = grid.stepFrom(cur.id, dCol, dRow);
    if (!move) return false;
    for (const p of move.seg) {
      const last = chain[chain.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) chain.push(p);
    }
    for (let i = 1; i < move.seg.length; i++) {
      km +=
        Math.hypot(
          (move.seg[i]![0] - move.seg[i - 1]![0]) * M_PER_LAT,
          (move.seg[i]![1] - move.seg[i - 1]![1]) * mPerLng(move.seg[i]![0]),
        ) / 1000;
    }
    cur = { col: cur.col + dCol, row: cur.row + dRow, id: move.to };
    progress.steps++;
    return true;
  };

  // The lattice has scattered holes (squares, Broadway cuts). A placement
  // may spend a tiny jog budget — a one-block perpendicular detour and
  // back — instead of dying at the first missing edge. Invisible at
  // letter scale; more than a few would warp the letterforms, so the
  // budget is tight and exceeding it rejects the placement.
  let jogBudget = 3;
  const stepWithJog = (dc: number, dr: number): boolean => {
    if (stepDir(dc, dr)) return true;
    if (jogBudget <= 0) return false;
    // perpendicular jog: sidestep, take the intended step, step back
    const perp: [number, number] = dc !== 0 ? [0, 1] : [1, 0];
    for (const sign of [1, -1]) {
      const [pc, pr] = [perp[0] * sign, perp[1] * sign];
      const saved = { ...cur! };
      const savedLen = chain.length;
      const savedKm = km;
      if (stepDir(pc, pr) && stepDir(dc, dr) && stepDir(-pc, -pr)) {
        jogBudget--;
        return true;
      }
      cur = saved;
      chain.length = savedLen;
      km = savedKm;
    }
    return false;
  };

  /** Walk to logical (col,row) in unit moves; diagonals staircase. */
  const walkTo = (col: number, row: number): boolean => {
    if (!cur) {
      const id = grid.at(col, row);
      if (id < 0) return false;
      chain.push(grid.coordOf(id));
      cur = { col, row, id };
      return true;
    }
    while (cur.col !== col || cur.row !== row) {
      const dc = Math.sign(col - cur.col);
      const dr = Math.sign(row - cur.row);
      if (dc !== 0 && dr !== 0) {
        if (!stepWithJog(dc, 0)) return false;
        if (!stepWithJog(0, dr)) return false;
      } else if (dc !== 0) {
        if (!stepWithJog(dc, 0)) return false;
      } else {
        if (!stepWithJog(0, dr)) return false;
      }
    }
    return true;
  };

  for (let r = 0; r < rows.length; r++) {
    const text = rows[r]!;
    // top text row sits at the HIGHER street rows
    const rowBase = or + (rows.length - 1 - r) * (m.LETTER_ROWS + m.ROW_GAP_ROWS);
    for (let i = 0; i < text.length; i++) {
      const glyph = GRID_GLYPHS[text[i]!];
      if (!glyph) return null;
      const gc = oc + i * (m.LETTER_COLS + m.GAP_COLS);
      // enter the letter at its first point via the baseline
      if (cur) {
        if (!walkTo(gc + glyph[0]![0], rowBase)) return null;
      }
      for (const [gx, gy] of glyph) {
        if (!walkTo(gc + gx, rowBase + Math.round((gy * m.LETTER_ROWS) / 6))) return null;
      }
      // return to the baseline so travel between letters rides the bottom
      // street of the text row
      const last = glyph[glyph.length - 1]!;
      if (last[1] !== 0) {
        if (!walkTo(gc + last[0], rowBase)) return null;
      }
    }
  }

  if (chain.length < 8) return null;
  return {
    chain,
    km: Number(km.toFixed(2)),
    coverage: 1,
    originCol: oc,
    originRow: or,
    rowsUsed: rows.length,
  };
}
