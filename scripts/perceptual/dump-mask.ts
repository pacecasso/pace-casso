/** What does the site actually extract from an upload? Dump the mask as PNG. */
import { readFileSync } from "node:fs";
import { loadMask, loadMaskAuto, fillEnclosed } from "../../lib/geoMask";
import sharp from "sharp";

async function main() {
  const img = process.argv[2]!;
  const auto = await loadMaskAuto(readFileSync(img));
  const m = await loadMask(readFileSync(img), "auto");
  if (!m) throw new Error("no mask");
  const filled = fillEnclosed(m.mask, m.w, m.h);
  let ink = 0, inkFilled = 0;
  for (let i = 0; i < m.w * m.h; i++) { if (m.mask[i] === 255) ink++; if (filled[i] === 255) inkFilled++; }
  console.log(`${img}: ${m.w}x${m.h} mode=${auto.mode} ink ${(100 * ink / (m.w * m.h)).toFixed(1)}% -> filled ${(100 * inkFilled / (m.w * m.h)).toFixed(1)}%`);
  const gray = Buffer.alloc(m.w * m.h);
  for (let i = 0; i < m.w * m.h; i++) gray[i] = filled[i] === 255 ? 0 : 255;
  const out = `tmp-perceptual/mask-${img.split(".")[0]}.png`;
  await sharp(gray, { raw: { width: m.w, height: m.h, channels: 1 } }).png().toFile(out);
  console.log("wrote", out);
}
main();
