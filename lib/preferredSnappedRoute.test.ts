import assert from "node:assert/strict";
import { preferredSnappedRouteFitsAnchor } from "./preferredSnappedRoute";
import type { RouteLineString } from "./routeTypes";

const anchor: [number, number][] = [
  [40, -73],
  [40, -72.999],
  [40.001, -72.999],
  [40.001, -73],
];

const nearbyRoute: RouteLineString = {
  coordinates: [
    [40.00003, -73.00002],
    [40.00004, -72.99902],
    [40.00103, -72.99902],
    [40.00104, -73.00001],
  ],
};

assert.equal(
  preferredSnappedRouteFitsAnchor(anchor, nearbyRoute),
  true,
  "nearby snapped route should be reusable",
);

assert.equal(
  preferredSnappedRouteFitsAnchor(
    [
      [40, -73],
      [Number.NaN, -72.999],
      [40.001, -73],
    ],
    nearbyRoute,
  ),
  false,
  "malformed anchor geometry should force a fresh snap",
);

const staleRoute: RouteLineString = {
  coordinates: [
    [40.7, -73.9],
    [40.701, -73.899],
    [40.702, -73.9],
  ],
};

assert.equal(
  preferredSnappedRouteFitsAnchor(anchor, staleRoute),
  false,
  "route from a different placement should force a fresh snap",
);

const impossibleScaleRoute: RouteLineString = {
  coordinates: nearbyRoute.coordinates,
  distanceMeters: 25_000,
};

assert.equal(
  preferredSnappedRouteFitsAnchor(anchor, impossibleScaleRoute),
  false,
  "wildly mismatched route distance should force a fresh snap",
);

console.log("preferredSnappedRoute tests ok");
