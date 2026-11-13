import assert from "node:assert";
import { fitRoute, mapView } from "./shareImage";

const box = { x: 100, y: 200, w: 400, h: 400 };
// 0.01 px: the "equator" routes sit a fraction of a degree north, where cos is not quite 1
const near = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);

// a tall route on the equator: fills the height, centred across, north at the top
const tall = fitRoute([[0, 0], [0.2, 0], [0.2, 0.1], [0, 0.1]], box);
near(tall[0][1], 600, "south at the bottom");
near(tall[1][1], 200, "north at the top");
near(tall[0][0], 200, "centred: 100 px spare each side");
near(tall[2][0], 400, "east to the right");

// a wide one fills the width instead
const wide = fitRoute([[0, 0], [0.1, 0.4]], box);
near(wide[0][0], 100, "west at the left");
near(wide[1][0], 500, "east at the right");
near(wide[0][1] - wide[1][1], 100, "height keeps the same scale");
near((wide[0][1] + wide[1][1]) / 2, 400, "centred down the box");

// at New York's latitude a degree of longitude is shorter: a square in degrees is drawn tall
const ny = fitRoute([[40.7, -74], [40.8, -73.9]], box);
near(ny[0][1] - ny[1][1], 400, "fills the height");
near(ny[1][0] - ny[0][0], 400 * Math.cos((40.75 * Math.PI) / 180), "narrowed by the latitude");

// every point stays inside the box
for (const [x, y] of [...tall, ...wide, ...ny]) {
  assert.ok(x >= 100 - 1e-6 && x <= 500 + 1e-6 && y >= 200 - 1e-6 && y <= 600 + 1e-6);
}

// nothing to draw, and a single point, do not throw or give NaN
assert.deepStrictEqual(fitRoute([], box), []);
const one = fitRoute([[40.7, -74]], box);
assert.ok(one.length === 1 && one[0].every(Number.isFinite));

// the street map behind a route: a run of about 4 x 7 km in Brooklyn
const area = { x: 56, y: 346, w: 1088, h: 724 };
const run: [number, number][] = [[40.70, -73.96], [40.64, -73.96], [40.64, -73.92], [40.70, -73.92]];
const view = mapView(run, area, 60);
for (const [x, y] of view.line) {
  assert.ok(x >= area.x + 60 - 0.01 && x <= area.x + area.w - 60 + 0.01, "route inside the padding, across");
  assert.ok(y >= area.y + 60 - 0.01 && y <= area.y + area.h - 60 + 0.01, "and down");
}
near(view.line[0][1], area.y + 60, "the taller side fills the box: north at the top padding");
near((view.line[0][0] + view.line[2][0]) / 2, area.x + area.w / 2, "centred across");
assert.ok(view.line[2][0] > view.line[0][0], "east to the right");
assert.ok(view.tiles.length > 0 && view.tiles.length <= 80, `a sensible number of tiles: ${view.tiles.length}`);
const z = view.tiles[0].z;
assert.ok(view.tiles.every((t) => t.z === z && t.size > 128 - 0.01 && t.size <= 256 + 0.01), "tiles drawn at 50-100% of their size");
// the tiles cover every corner of the box
for (const [px, py] of [[area.x, area.y], [area.x + area.w - 1, area.y], [area.x, area.y + area.h - 1], [area.x + area.w - 1, area.y + area.h - 1]]) {
  assert.ok(view.tiles.some((t) => px >= t.left && px < t.left + t.size && py >= t.top && py < t.top + t.size), `covered at ${px},${py}`);
}
// the tile under the first point of the route is the one a map would fetch for it
const n = 2 ** z;
const want = [Math.floor(((-73.96 + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan((40.70 * Math.PI) / 180)) / Math.PI) / 2) * n)];
const under = view.tiles.find((t) => view.line[0][0] >= t.left && view.line[0][0] < t.left + t.size && view.line[0][1] >= t.top && view.line[0][1] < t.top + t.size);
assert.deepStrictEqual([under?.x, under?.y], want, "standard tile numbering");
// a tiny route does not ask for tiles past the deepest zoom, and nothing gives nothing
assert.ok(mapView([[40.7, -73.96], [40.7001, -73.9601]], area, 60).tiles.every((t) => t.z === 17));
assert.deepStrictEqual(mapView([], area, 60), { line: [], tiles: [] });

console.log("shareImage.test.ts OK");
