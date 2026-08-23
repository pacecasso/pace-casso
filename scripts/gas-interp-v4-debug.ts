/** Dump compiled-chain coords in the head region to find spur pins. */
import fs from "node:fs/promises";

const M_PER_LAT = 111320;
const origin = [40.744061, -74.006811];
const X = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };

function toLocal(p: [number, number]): [number, number] {
  const mLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  const n = (p[0] - origin[0]) * M_PER_LAT;
  const e = (p[1] - origin[1]) * mLng;
  const det = X.e * Y.n - Y.e * X.n;
  return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det];
}

async function main() {
  const gpx = await fs.readFile("tmp-gas-interp-v4/GAS-V4.gpx", "utf8");
  const pts = [...gpx.matchAll(/lat="([\d.-]+)" lon="([\d.-]+)"/g)].map(
    (m) => [Number(m[1]), Number(m[2])] as [number, number],
  );
  console.log("total points:", pts.length);
  const local = pts.map(toLocal);
  let prev = "";
  for (let i = 0; i < local.length; i++) {
    const [x, y] = local[i];
    if (y > 1900 && y < 2900 && x > 1700) {
      const s = `${x.toFixed(0)},${y.toFixed(0)}`;
      if (s !== prev) console.log(i, s);
      prev = s;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
