import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = process.cwd();
const outDir = path.join(root, "tmp-sneaker-ink-preserved", new Date().toISOString().replace(/[:.]/g, "-"));
const idx = (x, y, w) => y * w + x;

function routePixel(r, g, b) {
  return r >= 138 && g >= 78 && g <= 190 && b >= 55 && b <= 178 && r - g >= 18 && g - b >= 4 && r - b >= 36;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const source = path.join(root, "sneaker.jpg");
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (y > 190 && routePixel(data[i], data[i + 1], data[i + 2])) mask[idx(x, y, info.width)] = 1;
    }
  }

  const routeOnly = Buffer.alloc(info.width * info.height * 4, 255);
  const cleanMap = Buffer.from(data);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const p = idx(x, y, info.width);
      const j = p * 4;
      if (mask[p]) {
        routeOnly[j] = 190; routeOnly[j + 1] = 96; routeOnly[j + 2] = 47; routeOnly[j + 3] = 255;
        cleanMap[j] = 194; cleanMap[j + 1] = 100; cleanMap[j + 2] = 52; cleanMap[j + 3] = 255;
      } else if (y >= 198 && y <= 456) {
        routeOnly[j] = 238; routeOnly[j + 1] = 242; routeOnly[j + 2] = 243; routeOnly[j + 3] = 255;
      }
    }
  }

  await sharp(routeOnly, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: 0, top: 198, width: info.width, height: 258 })
    .resize({ width: 900 })
    .png()
    .toFile(path.join(outDir, "route-ink-only.png"));

  await sharp(cleanMap, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(path.join(outDir, "activity-ink-preserved.png"));

  await sharp(cleanMap, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: 0, top: 198, width: info.width, height: 258 })
    .resize({ width: 900 })
    .png()
    .toFile(path.join(outDir, "map-ink-preserved.png"));

  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({
    note: "Preserves the source screenshot route ink mask; this is a visual pipeline test, not a generated runnable GPX.",
    files: ["route-ink-only.png", "map-ink-preserved.png", "activity-ink-preserved.png"],
  }, null, 2));
  console.log(path.relative(root, outDir));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
