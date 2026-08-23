// Put every promising historical gas route through TODAY'S gates:
// thin-line render → cold-name (3 samples) + likeness-to-upload (3 samples).
// Usage: npx tsx scripts/judge-gas-archive.ts
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { renderMap } from "./trace-contour";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const OUT = "tmp-studio/gas-archive";
let KEY = "";

// Pass GPX files as CLI args, else the default set.
const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "tmp-gas-interp-v5/GAS-V5.gpx",
      "tmp-interp-designs/gas-v7/GAS-V7.gpx",
      "tmp-nyc-three-logos/gas-RUNNABLE.gpx",
      "tmp-logo-proof/gas-brooklyn-curated/gas-v11-centered-neck-s0-l145.gpx",
      "tmp-logo-proof/gas-brooklyn-curated/gas-v11-centered-neck-s-20-l175.gpx",
    ];

const GAS_NAMES = ["gas", "pump", "fuel", "refuel", "nozzle", "petrol", "gasoline"];
const gasNamed = (g: string) => GAS_NAMES.some((n) => g.toLowerCase().includes(n));

async function api(content: any[], maxTokens = 1024): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-fable-5", max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  const json: any = await res.json();
  return (json.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
}

async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  KEY = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  await fs.mkdir(OUT, { recursive: true });
  const upload = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp("gas.png").resize({ width: 700 }).flatten({ background: "#fff" }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };

  for (const file of CANDIDATES) {
    let gpx: string;
    try {
      gpx = await fs.readFile(file, "utf8");
    } catch {
      console.log(`${file}: MISSING`);
      continue;
    }
    const coords: [number, number][] = [...gpx.matchAll(/lat="([-0-9.]+)" lon="([-0-9.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    if (coords.length < 10) {
      console.log(`${file}: no coords`);
      continue;
    }
    const name = path.basename(file, ".gpx");
    const png = path.join(OUT, `${name}.png`);
    await renderMap(coords as any, [], png, 1200, 1000);
    const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(png).resize({ width: 1100 }).jpeg({ quality: 85 }).toBuffer()).toString("base64") } };
    const colds: string[] = [];
    let named = 0;
    for (let i = 0; i < 3; i++) {
      const t = await api([img, { type: "text", text: 'The orange line is a GPS route someone recorded while running - they were trying to "draw" a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words>\nCONFIDENCE: <0-10>' }]);
      const guess = (t.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE)/i)?.[1] ?? "").trim();
      const conf = t.match(/CONFIDENCE:\s*(\d+)/i)?.[1] ?? "0";
      colds.push(`"${guess}" ${conf}`);
      if (gasNamed(guess)) named++;
    }
    const likes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await api([upload, img, { type: "text", text: "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as a thin orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1, to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color; the badge circle is background, judge the figures. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>" }], 512);
      likes.push(t.match(/SCORE:\s*(\d+)/i)?.[1] ?? "0");
    }
    const km = coords.slice(1).reduce((a, p, i) => {
      const R = 6371000, dLat = ((p[0] - coords[i][0]) * Math.PI) / 180, dLng = ((p[1] - coords[i][1]) * Math.PI) / 180;
      const la = (coords[i][0] * Math.PI) / 180, lb = (p[0] * Math.PI) / 180;
      return a + 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2));
    }, 0) / 1000;
    console.log(`${name}: ${km.toFixed(1)} km | cold ${colds.join(" | ")} → ${named}/3 named | likeness ${likes.join("/")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
