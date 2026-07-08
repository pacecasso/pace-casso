import type { GridPoint } from "./gridRouteProjection";

/**
 * Etch-a-sketch GAS mark: pump (left) | hose loop | headphone person (right).
 * Integer grid corners only — expandGrid walks one block per step.
 */
export function gasLogoSparseGrid(): GridPoint[] {
  return [
    // pump body + display window
    [-4, -3],
    [-4, 4],
    [-1, 4],
    [-1, 2],
    [-3, 2],
    [-3, 3],
    [-2, 3],
    [-2, 2],
    [-1, 2],
    [-1, -3],
    [-4, -3],
    // hose
    [-1, 0],
    [0, 0],
    [0, -2],
    [1, -2],
    [1, 1],
    [2, 1],
    // person — headphones + head
    [3, 4],
    [4, 5],
    [5, 4],
    [5, 2],
    [4, 3],
    [3, 2],
    [4, 2],
    // torso + legs
    [4, 2],
    [4, -1],
    [3, -4],
    [4, -1],
    [5, -4],
    // raised arm + nozzle
    [4, 1],
    [5, 3],
  ];
}

export const MANHATTAN_STREET_BEARING_DEG = 29;
