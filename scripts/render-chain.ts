/** Render a chain returned by the live API, to see what the user would get. */
import fs from "node:fs/promises";
import path from "node:path";
import type { LatLng } from "../lib/streetGraphTrace";
import { paleRender, sideBySide } from "./finisher-shared";

async function main(): Promise<void> {
  const [chainFile, img, outDir] = process.argv.slice(2);
  const chain = JSON.parse(await fs.readFile(chainFile!, "utf8")) as LatLng[];
  await fs.mkdir(outDir!, { recursive: true });
  const png = path.join(outDir!, "best.png");
  await paleRender(chain, png);
  await sideBySide(img!, png, path.join(outDir!, "compare.png"));
  console.log(`${chain.length} points -> ${path.join(outDir!, "compare.png")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
