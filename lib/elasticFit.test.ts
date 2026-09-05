import assert from "node:assert";
import { buildDistanceField, bearingBin, elasticFit, warpPoint, densify, featureWeights, fromXY, toXY, type Graph, type XY } from "./elasticFit";
import type { LatLng } from "./streetGraphTrace";

// synthetic Manhattan-like grid: avenues every 260 m (x), streets every 80 m (y)
function gridGraph(center: LatLng, half: number, ax: number, sy: number): Graph {
  const coord: LatLng[] = [];
  const adj: { to: number; w: number }[][] = [];
  const grid = new Map<string, number[]>();
  const nx = Math.floor((2 * half) / ax) + 1;
  const ny = Math.floor((2 * half) / sy) + 1;
  const id = (i: number, j: number) => j * nx + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p = fromXY([-half + i * ax, -half + j * sy], center);
      coord.push(p);
      adj.push([]);
      const k = `${Math.round(p[0] / 0.003)}:${Math.round(p[1] / 0.003)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(id(i, j));
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (i + 1 < nx) {
        adj[id(i, j)]!.push({ to: id(i + 1, j), w: ax });
        adj[id(i + 1, j)]!.push({ to: id(i, j), w: ax });
      }
      if (j + 1 < ny) {
        adj[id(i, j)]!.push({ to: id(i, j + 1), w: sy });
        adj[id(i, j + 1)]!.push({ to: id(i, j), w: sy });
      }
    }
  }
  return { coord, adj, grid };
}

const center: LatLng = [40.75, -73.98];
// half-extent is a multiple of both pitches so (0,0) is a junction
const g = gridGraph(center, 2080, 260, 80);
const F = buildDistanceField(g, center, 2080, 10, 160);

// field sanity (vertical-street bin): a point on an avenue is ~0 m away,
// a point 130 m east of an avenue is 130 m away even though it sits on a
// cross-street (the bins make the field orientation-aware)
{
  const vert = F.d[bearingBin(Math.PI / 2, F.bins)]!;
  const on = vert[Math.round((0 - F.y0) / F.px) * F.w + Math.round((0 - F.x0) / F.px)]!;
  const mid = vert[Math.round((0 - F.y0) / F.px) * F.w + Math.round((130 - F.x0) / F.px)]!;
  assert(on < 8, `on-avenue distance should be ~0, got ${on}`);
  assert(mid > 115 && mid < 145, `130 m east of an avenue should read ~130 in the vertical bin, got ${mid}`);
}

// a 1000 m square whose vertical edges sit mid-block (x = ±130 → 130 m from avenues)
const square: XY[] = [
  [-370, -500],
  [630, -500],
  [630, 500],
  [-370, 500],
  [-370, -500],
];
const polys = [densify(square, 40)];
const { samples, weights, thetas } = featureWeights(polys);
const res = elasticFit(F, samples, { weights, thetas, levels: [900, 450, 220], iterations: 200 });
assert(res.after < res.before * 0.35, `elastic fit should cut street distance a lot: before ${res.before.toFixed(1)} after ${res.after.toFixed(1)}`);
// vertical edges now lie on avenues (x multiple of 260 within ~15 m)
for (const x of [-370, 630]) {
  const q = warpPoint(res.lattice, [x, 0]);
  const off = Math.abs(((q[0] % 260) + 260) % 260);
  assert(Math.min(off, 260 - off) < 20, `edge at x=${x} should land on an avenue, got x=${q[0].toFixed(0)}`);
}
// proportions survive: width and height change by less than 25 %
const tl = warpPoint(res.lattice, [-370, 500]);
const br = warpPoint(res.lattice, [630, -500]);
const wRatio = (br[0] - tl[0]) / 1000;
const hRatio = (tl[1] - br[1]) / 1000;
assert(wRatio > 0.75 && wRatio < 1.25, `width ratio ${wRatio.toFixed(2)}`);
assert(hRatio > 0.75 && hRatio < 1.25, `height ratio ${hRatio.toFixed(2)}`);
assert(res.maxShift < 400, `max shift should be modest, got ${res.maxShift.toFixed(0)}`);

// round trip of the frame helpers
const p: LatLng = [40.7512, -73.9789];
const back = fromXY(toXY(p, center), center);
assert(Math.abs(back[0] - p[0]) < 1e-9 && Math.abs(back[1] - p[1]) < 1e-9);

console.log(`elasticFit tests passed (before ${res.before.toFixed(1)} m → after ${res.after.toFixed(1)} m, mean shift ${res.meanShift.toFixed(0)} m)`);
