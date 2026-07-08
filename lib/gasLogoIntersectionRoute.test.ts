import assert from "node:assert/strict";
import { gasLogoSparseGrid } from "./gasLogoGridTemplate";
import {
  assertAxisAlignedAnchors,
  decomposeToAxisAnchors,
  mergeCollinearOutline,
} from "./gridRouteUtils";
import { expandGrid, projectGridToLatLngDual } from "./gridRouteProjection";

const center: [number, number] = [40.728, -73.991];
const projected = projectGridToLatLngDual({
  center,
  streetMeters: 88,
  avenueMeters: 275,
  streetBearingDeg: 29,
  grid: gasLogoSparseGrid(),
});
assert.ok(projected.length > 40, "expanded gas grid should have many block steps");

const turns = mergeCollinearOutline(projected);
assert.ok(turns.length >= 10, "should have turn corners");

const axis = decomposeToAxisAnchors(turns);
assert.ok(assertAxisAlignedAnchors(axis), "turn corners decompose to axis-only legs");

const sparse = gasLogoSparseGrid();
const expanded = expandGrid(sparse);
assert.ok(expanded.length > sparse.length, "expandGrid adds block steps");

console.log("gasLogoIntersectionRoute.test.ts ok");
