// Contact sheet of an inkline run: picks ranked by the judge, with scores.
// Usage: node scripts/inkline-sheet.mjs tmp-inkline/<name>
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const sharp = createRequire(import.meta.url)("sharp");

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/inkline-sheet.mjs tmp-inkline/<name>");
const name = path.basename(dir);
const rows = JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8"));
const W = 650, H = 550, CAP = 70, COLS = 3;
const tiles = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const img = await sharp(path.join(dir, `${name}-${r.pick}.png`)).resize(W, H, { fit: "contain", background: "#fff" }).toBuffer();
  const cold = r.judge ? r.judge.cold.map((c) => `${c.guess} ${c.conf}`).join(" / ") : "-";
  const like = r.judge ? r.judge.like.join("/") : "-";
  const cap = Buffer.from(
    `<svg width="${W}" height="${CAP}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>` +
      `<text x="8" y="22" font-family="Arial" font-size="16" font-weight="700" fill="#111">#${i + 1}  pick ${r.pick}  likeness ${like}  ${r.km.toFixed(1)} km  scale ${r.scale} rot ${r.rot}</text>` +
      `<text x="8" y="44" font-family="Arial" font-size="13" fill="#333">${cold.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>` +
      `<text x="8" y="62" font-family="Arial" font-size="12" fill="#666">${(r.judge?.reasons?.[0] ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`,
  );
  const tile = await sharp({ create: { width: W, height: H + CAP, channels: 3, background: "#fff" } })
    .composite([{ input: img, left: 0, top: 0 }, { input: cap, left: 0, top: H }])
    .png()
    .toBuffer();
  tiles.push({ input: tile, left: (i % COLS) * (W + 10), top: Math.floor(i / COLS) * (H + CAP + 10) });
}
const rowsN = Math.ceil(rows.length / COLS);
await sharp({ create: { width: COLS * (W + 10), height: rowsN * (H + CAP + 10), channels: 3, background: "#ddd" } })
  .composite(tiles)
  .png()
  .toFile(path.join(dir, "SHEET.png"));
console.log(path.join(dir, "SHEET.png"));
