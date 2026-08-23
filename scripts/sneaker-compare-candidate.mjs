import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = process.cwd();
const candidate = process.argv[2];
if (!candidate) {
  console.error("Usage: node scripts/sneaker-compare-candidate.mjs <candidate-png>");
  process.exit(1);
}

const out = candidate.replace(/\.png$/i, "-comparison.png");
const ref = await sharp(path.join(root, "sneaker.jpg"))
  .resize(560, 560, { fit: "contain", background: "#ffffff" })
  .png()
  .toBuffer();
const cand = await sharp(path.join(root, candidate))
  .resize(720, 560, { fit: "contain", background: "#ffffff" })
  .png()
  .toBuffer();
const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1360" height="660">
  <rect width="100%" height="100%" fill="#f8f5ef"/>
  <text x="40" y="46" font-family="Arial" font-size="24" font-weight="700" fill="#111">source sample</text>
  <text x="640" y="46" font-family="Arial" font-size="24" font-weight="700" fill="#111">generated real-street candidate</text>
</svg>`);
await sharp(label)
  .composite([
    { input: ref, left: 40, top: 70 },
    { input: cand, left: 620, top: 70 },
  ])
  .png()
  .toFile(path.join(root, out));
console.log(out);
