import assert from "node:assert";
import {
  buildLatticeGraph,
  compileContourToLattice,
  haversineMeters,
  nearestLatticeNode,
  resamplePathMeters,
  type LatLng,
  type LatticeData,
} from "./latticeCompiler";

/**
 * Synthetic cardinal grid: N x N junctions, `spacing` meters apart, so the
 * compiler can be exercised without the real Manhattan dataset.
 */
function syntheticGrid(n: number, spacingM: number): LatticeData {
  const baseLat = 40.72;
  const baseLng = -73.99;
  const dLat = spacingM / 111320;
  const dLng = spacingM / (111320 * Math.cos((baseLat * Math.PI) / 180));
  const nodes: LatLng[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      nodes.push([baseLat + r * dLat, baseLng + c * dLng]);
    }
  }
  const edges: LatticeData["edges"] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (c + 1 < n) edges.push([i, i + 1, spacingM, []]);
      if (r + 1 < n) edges.push([i, i + n, spacingM, []]);
    }
  }
  return {
    version: 1,
    city: "test",
    bounds: { south: 0, west: -180, north: 90, east: 0 },
    nodes,
    edges,
  };
}

const GRID_N = 14;
const SPACING = 80;
const data = syntheticGrid(GRID_N, SPACING);
const graph = buildLatticeGraph(data);
const at = (r: number, c: number): LatLng => data.nodes[r * GRID_N + c];

// --- nearestLatticeNode ---
{
  const p: LatLng = [at(3, 4)[0] + 0.0001, at(3, 4)[1] + 0.0001]; // ~14 m off
  const found = nearestLatticeNode(graph, p, 60);
  assert.strictEqual(found, 3 * GRID_N + 4, "nearest node should be (3,4)");
  const nowhere = nearestLatticeNode(graph, [41.5, -73.99], 120);
  assert.strictEqual(nowhere, -1, "far point should find nothing");
}

// --- resample keeps endpoints and spacing ---
{
  const line: LatLng[] = [at(0, 0), at(0, 10)]; // 800 m
  const rs = resamplePathMeters(line, 45);
  assert.ok(rs.length >= 16 && rs.length <= 21, `got ${rs.length} samples`);
  assert.deepStrictEqual(rs[0], line[0]);
  const endGap = haversineMeters(rs[rs.length - 1], line[1]);
  assert.ok(endGap < 2, "resample must keep the final point");
}

// --- grid-aligned square compiles nearly losslessly ---
{
  const square: LatLng[] = [at(2, 2), at(2, 9), at(9, 9), at(9, 2), at(2, 2)];
  const result = compileContourToLattice(square, graph);
  assert.ok(result, "square should compile");
  assert.ok(
    result.meanDeviationMeters < 12,
    `square meanDev ${result.meanDeviationMeters.toFixed(1)} m should be tiny`,
  );
  const ratio = result.km / result.inputKm;
  assert.ok(
    ratio > 0.9 && ratio < 1.15,
    `square km ratio ${ratio.toFixed(2)} should be ~1`,
  );
  const first = result.chain[0];
  const last = result.chain[result.chain.length - 1];
  assert.ok(
    haversineMeters(first, last) < 1,
    "closed input must produce a closed chain",
  );
}

// --- diagonal becomes stairsteps that stay within about half a block ---
{
  const diag: LatLng[] = [at(1, 1), at(11, 11)];
  // open two-point path is below the 3-point minimum; add a midpoint
  const mid: LatLng = [
    (diag[0][0] + diag[1][0]) / 2,
    (diag[0][1] + diag[1][1]) / 2,
  ];
  const result = compileContourToLattice([diag[0], mid, diag[1]], graph);
  assert.ok(result, "diagonal should compile");
  assert.ok(
    result.meanDeviationMeters < SPACING * 0.75,
    `diagonal meanDev ${result.meanDeviationMeters.toFixed(1)} m too big`,
  );
  // stairsteps cost sqrt(2) in length vs the diagonal
  const ratio = result.km / result.inputKm;
  assert.ok(
    ratio > 1.15 && ratio < 1.6,
    `diagonal ratio ${ratio.toFixed(2)} should be ~1.41`,
  );
}

// --- placement off the lattice fails cleanly ---
{
  const offGrid: LatLng[] = [
    [41.5, -73.0],
    [41.51, -73.0],
    [41.51, -73.01],
    [41.5, -73.0],
  ];
  assert.strictEqual(
    compileContourToLattice(offGrid, graph),
    null,
    "off-lattice placement must return null",
  );
}

// --- tiny zigzag noise must not produce back-and-forth pin flicker ---
{
  const noisy: LatLng[] = [];
  const y = at(5, 1)[0];
  const x0 = at(5, 1)[1];
  const x1 = at(5, 11)[1];
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // ~12 m of vertical noise on an 800 m straightaway
    const jitter = (i % 2 === 0 ? 1 : -1) * (12 / 111320);
    noisy.push([y + jitter, x0 + (x1 - x0) * t]);
  }
  const result = compileContourToLattice(noisy, graph);
  assert.ok(result, "noisy straight line should compile");
  const ratio = result.km / result.inputKm;
  assert.ok(
    ratio < 1.25,
    `noisy line ratio ${ratio.toFixed(2)} suggests pin flicker`,
  );
}

console.log("latticeCompiler.test.ts OK");
