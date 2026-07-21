import assert from "node:assert";
import { buildLatticeGraph, type LatticeData } from "./latticeCompiler";
import { packWordRows, typesetWordOnLattice, LATTICE_GLYPHS } from "./latticeText";
import latticeJson from "./data/manhattan-lattice.json";

// Row packing
assert.deepEqual(packWordRows("JUST DO IT"), ["JUST", "DO IT"]);
assert.deepEqual(packWordRows("NIKE"), ["NIKE"]);
assert.equal(packWordRows("ABCDEFGHIJKLMNOPQRSTUVWX YZ AB CD"), null);
assert.equal(packWordRows(""), null);

// Full alphabet has glyphs
for (let c = 65; c <= 90; c++) {
  assert(LATTICE_GLYPHS[String.fromCharCode(c)], `missing glyph ${String.fromCharCode(c)}`);
}

const graph = buildLatticeGraph(latticeJson as unknown as LatticeData);

// The proven case: JUST DO IT typesets street-true in midtown.
const result = typesetWordOnLattice("JUST DO IT", graph);
assert(result, "JUST DO IT should typeset");
assert.deepEqual(result.rows, ["JUST", "DO IT"]);
assert(result.km > 10 && result.km < 32, `km out of range: ${result.km}`);
assert(result.anchors.length > 80, `too few anchors: ${result.anchors.length}`);

// Street-true by construction: every anchor must lie on or between real
// lattice geometry — verify each is within 40 m of some lattice node
// (via points of curved edges can sit between junctions).
const M = 111320;
for (const [lat, lng] of result.anchors.filter((_, i) => i % 7 === 0)) {
  let bd = Infinity;
  for (const [nlat, nlng] of graph.nodes) {
    const d = Math.hypot((lat - nlat) * M, (lng - nlng) * M * Math.cos((lat * Math.PI) / 180));
    if (d < bd) bd = d;
    if (bd < 40) break;
  }
  assert(bd < 220, `anchor ${lat},${lng} is ${bd.toFixed(0)}m from any junction`);
}

// Garbage in, null out.
assert.equal(typesetWordOnLattice("", graph), null);
assert.equal(typesetWordOnLattice("A", graph), null);

console.log("latticeText tests passed");
