import assert from "node:assert";
import type { LatLng } from "./streetGraphTrace";
import {
  type WowGraph,
  type Pt,
  placeSegments,
  densifyLine,
  chamferDistance,
  cleanAnchors,
  exciseLoops,
  getGiantComponentMask,
  nearestGiantNode,
  shortestGraphPath,
  traceSegmentsOnGraph,
  sweepPlacements,
  chainsKm,
} from "./wowFunnel";

const M_PER_LAT = 111320;

// --- synthetic grid graph: rows x cols intersections, spacing in meters ----
function gridGraph(rows: number, cols: number, spacingM: number, origin: LatLng = [40.73, -73.99]): WowGraph {
  const dLat = spacingM / M_PER_LAT;
  const dLng = spacingM / (M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180));
  const coord: LatLng[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      coord.push([origin[0] + r * dLat, origin[1] + c * dLng]);
    }
  }
  const adj: { to: number; w: number }[][] = coord.map(() => []);
  const link = (a: number, b: number) => {
    adj[a]!.push({ to: b, w: spacingM });
    adj[b]!.push({ to: a, w: spacingM });
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c + 1 < cols) link(i, i + 1);
      if (r + 1 < rows) link(i, i + cols);
    }
  }
  const grid = new Map<string, number[]>();
  const CELL = 0.003;
  for (let i = 0; i < coord.length; i++) {
    const k = `${Math.round(coord[i]![0] / CELL)}:${Math.round(coord[i]![1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  }
  return { coord, adj, grid };
}

// --- placeSegments -----------------------------------------------------------
{
  const square: Pt[][] = [[[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]]];
  const placed = placeSegments(square, [40.73, -73.99], 2000, 0, false);
  const lats = placed[0]!.map((p) => p[0]);
  const spanM = (Math.max(...lats) - Math.min(...lats)) * M_PER_LAT;
  assert.ok(Math.abs(spanM - 2000) < 1, `extent should be 2000m, got ${spanM}`);

  // mirror flips x (longitude) ordering, keeps y
  const asym: Pt[][] = [[[0, 0], [1000, 0], [1000, 300]]];
  const a = placeSegments(asym, [40.73, -73.99], 1000, 0, false)[0]!;
  const b = placeSegments(asym, [40.73, -73.99], 1000, 0, true)[0]!;
  assert.ok(Math.abs(a[0]![1] - -73.99 - (-(b[0]![1] - -73.99))) < 1e-9, "mirror should negate lng offsets");
  assert.ok(Math.abs(a[0]![0] - b[0]![0]) < 1e-12, "mirror should keep lat");
}

// --- densify + chamfer -------------------------------------------------------
{
  const line: LatLng[] = [[40.73, -73.99], [40.739, -73.99]]; // ~1km
  const dense = densifyLine(line, 40);
  assert.ok(dense.length >= 25, `densify at 40m over 1km should give >=25 pts, got ${dense.length}`);
  assert.strictEqual(chamferDistance([dense], [dense]), 0, "identical polylines => chamfer 0");
  const shifted = dense.map(([lat, lng]) => [lat, lng + 0.0012] as LatLng); // ~100m east
  const d = chamferDistance([shifted], [dense]);
  assert.ok(d > 80 && d < 120, `100m shift should chamfer ~100m, got ${d}`);
}

// --- giant component + nearest node -----------------------------------------
{
  const g = gridGraph(5, 5, 100);
  // add an island: two connected nodes far from the grid but in a nearby cell
  const islandA = g.coord.length;
  g.coord.push([40.7301, -73.9885], [40.73015, -73.9885]);
  g.adj.push([{ to: islandA + 1, w: 5 }], [{ to: islandA, w: 5 }]);
  const CELL = 0.003;
  for (const i of [islandA, islandA + 1]) {
    const k = `${Math.round(g.coord[i]![0] / CELL)}:${Math.round(g.coord[i]![1] / CELL)}`;
    if (!g.grid.has(k)) g.grid.set(k, []);
    g.grid.get(k)!.push(i);
  }
  const mask = getGiantComponentMask(g);
  assert.strictEqual(mask[0], 1, "grid nodes are the giant component");
  assert.strictEqual(mask[islandA], 0, "island nodes are excluded");
  // nearest search must skip the island even if it is closer
  const near = nearestGiantNode(g, mask, g.coord[islandA]!);
  assert.ok(near.id !== islandA && near.id !== islandA + 1, "nearest giant node skips islands");
  assert.strictEqual(mask[near.id], 1);
}

// --- shortest path (heap A*) --------------------------------------------------
{
  const g = gridGraph(4, 4, 100);
  const p = shortestGraphPath(g, 0, 15)!; // corner to corner
  assert.ok(p, "path exists");
  assert.strictEqual(p[0], 0);
  assert.strictEqual(p[p.length - 1], 15);
  assert.strictEqual(p.length, 7, `manhattan path 0->15 on 4x4 grid has 7 nodes, got ${p.length}`);
}

// --- exciseLoops ---------------------------------------------------------------
{
  const g = gridGraph(2, 12, 100); // two parallel streets, 100m apart
  const cols = 12;
  // intended contour: straight line along row 0
  const rowLine = densifyLine([g.coord[0]!, g.coord[cols - 1]!], 20);
  // noise spur: mid-walk hop to row 1 and back (200m loop, apex 100m off contour)
  const withSpur = [0, 1, 2, 2 + cols, 2, 3, 4];
  const cleaned = exciseLoops(g.coord, withSpur, rowLine);
  assert.deepStrictEqual(cleaned, [0, 1, 2, 3, 4], "200m off-contour out-and-back excised");

  // intended retrace (a drawn leg): contour INCLUDES the leg geometry, so the
  // tip palindrome sits on the contour and must survive — even though short
  const legShape = densifyLine([g.coord[0]!, g.coord[4]!], 20); // leg drawn along row 0, nodes 4->2->4 retrace tip at 2
  const legPath = [4, 3, 2, 3, 4, 5];
  const keptLeg = exciseLoops(g.coord, legPath, legShape);
  assert.deepStrictEqual(keptLeg, legPath, "on-contour retrace tip must survive (no limb nibbling)");
}

// --- cleanAnchors ---------------------------------------------------------------
{
  const g = gridGraph(4, 4, 100);
  const dense = densifyLine([g.coord[0]!, g.coord[3]!], 20); // along the bottom row
  // anchor 3 rows up (~300m off the contour) must be dropped; endpoints kept
  const anchors = [0, 1, 14, 2, 3];
  const cleaned = cleanAnchors(g.coord, anchors, dense);
  assert.deepStrictEqual(cleaned, [0, 1, 2, 3], "far off-contour anchor dropped");
  const endpointsKept = cleanAnchors(g.coord, [12, 1, 2, 15], dense);
  assert.strictEqual(endpointsKept[0], 12, "first endpoint always kept");
  assert.strictEqual(endpointsKept[endpointsKept.length - 1], 15, "last endpoint always kept");
}

// --- trace + sweep on synthetic city -------------------------------------------
{
  const g = gridGraph(40, 40, 100); // 4km x 4km city
  const mask = getGiantComponentMask(g);
  const square: Pt[][] = [[[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]]];
  const center: LatLng = [
    g.coord[0]![0] + (20 * 100) / M_PER_LAT,
    g.coord[0]![1] + (20 * 100) / (M_PER_LAT * Math.cos((40.73 * Math.PI) / 180)),
  ];
  const t = traceSegmentsOnGraph(g, mask, square, center, 2000, 0, false);
  assert.strictEqual(t.jumps, 0, "no teleports on a connected grid");
  assert.ok(t.maxSnapD < 80, `snaps should be tight on a 100m grid, got ${t.maxSnapD}`);
  const km = chainsKm(t.chains);
  assert.ok(km > 7.5 && km < 8.5, `2km square perimeter ~8km, got ${km}`);
  assert.ok(t.dev < 40, `square on grid should fit tightly, dev=${t.dev}`);

  const candidates = sweepPlacements(g, square, {
    centers: [center],
    extentsM: [2000],
    rotationsDeg: [0],
    mirrors: [false],
    minKm: 7,
    maxKm: 9,
  });
  assert.strictEqual(candidates.length, 1, "one gated candidate for one placement");
  assert.strictEqual(candidates[0]!.km, Number(km.toFixed(2)));

  // km gate rejects
  const rejected = sweepPlacements(g, square, {
    centers: [center],
    extentsM: [2000],
    rotationsDeg: [0],
    mirrors: [false],
    minKm: 10,
    maxKm: 26,
  });
  assert.strictEqual(rejected.length, 0, "km gate rejects an 8km route when min is 10");
}

// --- pen lifts: two strokes stay two chains -------------------------------------
{
  const g = gridGraph(40, 40, 100);
  const mask = getGiantComponentMask(g);
  const center: LatLng = [
    g.coord[0]![0] + (20 * 100) / M_PER_LAT,
    g.coord[0]![1] + (20 * 100) / (M_PER_LAT * Math.cos((40.73 * Math.PI) / 180)),
  ];
  const twoStrokes: Pt[][] = [
    [[0, 0], [1000, 0]],
    [[0, 1000], [1000, 1000]],
  ];
  const t = traceSegmentsOnGraph(g, mask, twoStrokes, center, 2000, 0, false);
  assert.strictEqual(t.chains.length, 2, "each stroke traces to its own chain");
  assert.strictEqual(t.jumps, 0);
  const gapM =
    Math.abs(t.chains[0]![0]![0] - t.chains[1]![0]![0]) * M_PER_LAT;
  assert.ok(gapM > 1500, "strokes remain spatially separate (no connector)");
}

console.log("wowFunnel tests passed");
