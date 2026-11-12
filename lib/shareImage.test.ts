import assert from "node:assert";
import { fitRoute } from "./shareImage";

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

console.log("shareImage.test.ts OK");
