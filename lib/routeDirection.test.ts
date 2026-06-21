import assert from "node:assert/strict";
import {
  reverseRouteDirection,
  rotateClosedRouteStart,
  type RouteLegOverride,
} from "./routeDirection";

const waypoints: [number, number][] = [
  [40, -73],
  [40.001, -73.001],
  [40.002, -73.002],
];

const legOverrides: (RouteLegOverride | null)[] = [
  {
    coords: [
      [40, -73],
      [40.0005, -73.0005],
      [40.001, -73.001],
    ],
    isSpur: false,
  },
  {
    coords: [
      [40.001, -73.001],
      [40.0015, -73.0015],
      [40.002, -73.002],
    ],
    isSpur: true,
  },
];

{
  const reversed = reverseRouteDirection(waypoints, legOverrides);
  assert.deepEqual(reversed.waypoints, [...waypoints].reverse());
  assert.deepEqual(reversed.legOverrides[0]?.coords, [
    [40.002, -73.002],
    [40.0015, -73.0015],
    [40.001, -73.001],
  ]);
  assert.equal(reversed.legOverrides[0]?.isSpur, true);
  assert.deepEqual(reversed.legOverrides[1]?.coords, [
    [40.001, -73.001],
    [40.0005, -73.0005],
    [40, -73],
  ]);
  assert.equal(reversed.legOverrides[1]?.isSpur, false);
}

{
  const rotated = rotateClosedRouteStart(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    2,
  );
  assert.deepEqual(rotated, [
    [1, 1],
    [0, 1],
    [0, 0],
    [1, 0],
  ]);
}

{
  const closed: [number, number][] = [
    [40, -73],
    [40, -72.999],
    [40.001, -72.999],
    [40.001, -73],
    [40, -73],
  ];
  const rotated = rotateClosedRouteStart(closed, 2);
  assert.deepEqual(rotated, [
    [40.001, -72.999],
    [40.001, -73],
    [40, -73],
    [40, -72.999],
    [40.001, -72.999],
  ]);
  assert.deepEqual(rotated[0], rotated[rotated.length - 1]);
  assert.equal(rotated.length, closed.length);
}

{
  const nearlyClosed: [number, number][] = [
    [40, -73],
    [40, -72.999],
    [40.001, -72.999],
    [40.00002, -73.00002],
  ];
  const rotated = rotateClosedRouteStart(nearlyClosed, 2);
  assert.deepEqual(rotated[0], rotated[rotated.length - 1]);
  assert.equal(rotated.length, nearlyClosed.length + 1);
  assert.deepEqual(rotated.slice(0, -1), [
    [40.001, -72.999],
    [40.00002, -73.00002],
    [40, -73],
    [40, -72.999],
  ]);
}

console.log("routeDirection tests ok");
