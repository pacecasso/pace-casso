/**
 * Lazy singleton for the Manhattan street-junction lattice. The dataset
 * (~180 KB JSON) and graph build are pulled in via dynamic import so the
 * /create bundle only pays for it when auto-find actually runs in Manhattan.
 */
import {
  buildLatticeGraph,
  type LatticeData,
  type LatticeGraph,
} from "./latticeCompiler";

let cached: Promise<LatticeGraph> | null = null;

export function getManhattanLatticeGraph(): Promise<LatticeGraph> {
  if (!cached) {
    cached = import("./data/manhattan-lattice.json").then((mod) =>
      buildLatticeGraph(mod.default as unknown as LatticeData),
    );
  }
  return cached;
}
