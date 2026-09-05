/**
 * Rasterize one of the authored vector silhouettes in scripts/trace-contour.ts
 * (unicorn, cat, star, apple, …) to a filled PNG so the painter/inkline rigs
 * can treat it like an upload.  Usage: npx tsx scripts/shape-to-png.ts unicorn [out.png]
 */
import path from "node:path";
import { createRequire } from "node:module";
import { getShape } from "./trace-contour";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const name = process.argv[2] ?? "unicorn";
const out = process.argv[3] ?? path.join("tmp-inkline", "shapes", `${name}.png`);
const shape = getShape(name);
if (!shape) throw new Error(`unknown shape ${name}`);
const pts = shape();
const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
const S = 900, pad = 60;
const span = Math.max(maxX - minX, maxY - minY);
const k = (S - 2 * pad) / span;
const d = pts.map((p, i) => `${i ? "L" : "M"}${(pad + (p[0] - minX) * k).toFixed(1)} ${(S - pad - (p[1] - minY) * k).toFixed(1)}`).join(" ") + " Z";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000" stroke="#000" stroke-width="6" stroke-linejoin="round"/></svg>`;
async function main() {
  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log(out);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
