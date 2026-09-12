// logo | route side by side for a human eye: npx tsx scripts/compare-png.ts <image> <render.png> <out.png>
import { sideBySide } from "./finisher-shared";
const [img, render, out] = process.argv.slice(2);
if (!img || !render || !out) { console.log("usage: compare-png <image> <render.png> <out.png>"); process.exit(1); }
sideBySide(img, render, out).then(() => console.log(`wrote ${out}`));
