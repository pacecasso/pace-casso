/**
 * Offline validation of the production vision-design interpretation path:
 * gas.png -> buildInterpretationPrompt (the exact prompt the API route uses)
 * -> Claude -> sketch gate -> lattice compile -> rendered sheet.
 *
 * Run: npx tsx scripts/validate-vision-design.ts [imagePath] [draftCount]
 * Requires ANTHROPIC_API_KEY in .env.local. Costs a few cents per run.
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { buildInterpretationPrompt } from "../lib/interpretationPrompt";
import { reviewStreetDesignSketch } from "../lib/streetDesignSketch";
import {
  buildLatticeGraph,
  compileContourToLattice,
  type LatLng,
  type LatticeData,
} from "../lib/latticeCompiler";

const IMAGE = process.argv[2] ?? "gas.png";
const DRAFTS = Number(process.argv[3] ?? 4);
const OUT = path.join(process.cwd(), "tmp-vision-validate");

// Same Manhattan frame as scripts/interp-designs.ts
const origin: LatLng = [40.744061, -74.006811]; // 10th Ave & 17th St
const X = { e: Math.sin((119 * Math.PI) / 180), n: Math.cos((119 * Math.PI) / 180) };
const Y = { e: Math.sin((29 * Math.PI) / 180), n: Math.cos((29 * Math.PI) / 180) };
const M_PER_LAT = 111320;

function toLatLng([x, y]: [number, number]): LatLng {
  const e = x * X.e + y * Y.e;
  const n = x * X.n + y * Y.n;
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  return [origin[0] + n / M_PER_LAT, origin[1] + e / mPerLng];
}
function toLocal([lat, lng]: LatLng): [number, number] {
  const mPerLng = M_PER_LAT * Math.cos((origin[0] * Math.PI) / 180);
  const n = (lat - origin[0]) * M_PER_LAT;
  const e = (lng - origin[1]) * mPerLng;
  const det = X.e * Y.n - Y.e * X.n;
  return [(e * Y.n - Y.e * n) / det, (X.e * n - e * X.n) / det];
}

type Pt = { x: number; y: number };
type Draft = { label: string; description: string; visualFeatures?: string[]; points: Pt[] };

function sketchSvg(points: Pt[], w = 620): string {
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(p.x * w).toFixed(1)} ${(p.y * w).toFixed(1)}`)
    .join(" ");
  return `<svg width="${w}" height="${w}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${w}" fill="white"/><path d="${d}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

async function readEnvKey(): Promise<string> {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const m = env.match(/^ANTHROPIC_API_KEY=(.+)$/m);
  if (!m) throw new Error("ANTHROPIC_API_KEY not found in .env.local");
  return m[1].trim();
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const client = new Anthropic({ apiKey: await readEnvKey() });
  const imgBuf = await fs.readFile(path.join(process.cwd(), IMAGE));
  const mediaType = IMAGE.endsWith(".webp") ? "image/webp" : "image/png";

  console.log(`asking for ${DRAFTS} drafts of ${IMAGE} with the production prompt...`);
  const message = await client.messages.create({
    model: "claude-sonnet-4-6", // same model as the route
    max_tokens: 16000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imgBuf.toString("base64") },
          },
          { type: "text", text: buildInterpretationPrompt("Manhattan", DRAFTS) },
        ],
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
    drafts?: Draft[];
    points?: Pt[];
    label?: string;
  };
  const drafts: Draft[] = parsed.drafts?.length
    ? parsed.drafts
    : [{ label: parsed.label ?? "sketch", description: "", points: parsed.points ?? [] }];
  console.log(`got ${drafts.length} drafts`);

  const latticeData = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "lib", "data", "manhattan-lattice.json"), "utf8"),
  ) as LatticeData;
  const graph = buildLatticeGraph(latticeData);

  const cell = 620;
  const composites: sharp.OverlayOptions[] = [];
  const label = (t: string) =>
    Buffer.from(
      `<svg width="${cell * 2}" height="40"><text x="10" y="28" font-family="Arial" font-size="20" font-weight="700" fill="#111">${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`,
    );

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const review = reviewStreetDesignSketch(d.points);
    console.log(
      `draft ${i + 1} "${d.label}": ${d.points.length} pts, gate ${review.pass ? "PASS" : "FAIL"} (${review.score})`,
      review.reasons.join("; ") || "clean",
      `features=${review.metrics.directionChanges}`,
    );

    // sketch panel
    const sk = await sharp(Buffer.from(sketchSvg(d.points, cell))).png().toBuffer();

    // compile at legibility scale: figure height 2800 m, width by aspect
    const xs = d.points.map((p) => p.x);
    const ys = d.points.map((p) => p.y);
    const spanX = Math.max(...xs) - Math.min(...xs) || 1;
    const spanY = Math.max(...ys) - Math.min(...ys) || 1;
    const H = 2800;
    const W = Math.min(3000, (spanX / spanY) * H);
    const placed = d.points.map(
      (p) =>
        toLatLng([
          ((p.x - Math.min(...xs)) / spanX) * W,
          320 + (1 - (p.y - Math.min(...ys)) / spanY) * H,
        ]),
    );
    const result = compileContourToLattice(placed, graph, {
      sampleMeters: 38,
      pinRadiusMeters: 150,
    });

    let compiled: Buffer;
    if (result) {
      const local = result.chain.map(toLocal);
      const minX = Math.min(...local.map((p) => p[0])) - 150;
      const maxX = Math.max(...local.map((p) => p[0])) + 150;
      const minY = Math.min(...local.map((p) => p[1])) - 150;
      const maxY = Math.max(...local.map((p) => p[1])) + 150;
      const s = cell / (maxX - minX);
      const h = Math.round((maxY - minY) * s);
      const dPath = local
        .map(
          (p, j) =>
            `${j === 0 ? "M" : "L"} ${((p[0] - minX) * s).toFixed(1)} ${((maxY - p[1]) * s).toFixed(1)}`,
        )
        .join(" ");
      compiled = await sharp(
        Buffer.from(
          `<svg width="${cell}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${cell}" height="${h}" fill="white"/><path d="${dPath}" fill="none" stroke="#111" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        ),
      )
        .resize(cell, cell, { fit: "contain", background: "#fff" })
        .png()
        .toBuffer();
      console.log(`  compiled: ${result.km.toFixed(1)} km, meanDev ${result.meanDeviationMeters.toFixed(0)} m`);
    } else {
      compiled = await sharp(
        Buffer.from(
          `<svg width="${cell}" height="${cell}"><rect width="${cell}" height="${cell}" fill="#fee"/><text x="30" y="60" font-size="24">compile failed</text></svg>`,
        ),
      )
        .png()
        .toBuffer();
      console.log("  compiled: FAILED");
    }

    const top = 50 + i * (cell + 60);
    composites.push(
      { input: sk, left: 10, top },
      { input: compiled, left: cell + 20, top },
      {
        input: label(
          `draft ${i + 1}: ${d.label} — ${d.points.length} pts, gate ${review.pass ? "pass" : "FAIL"} ${review.score}${result ? `, ${result.km.toFixed(1)} km` : ", compile failed"}`,
        ),
        left: 10,
        top: top - 40,
      },
    );
  }

  await sharp({
    create: {
      width: cell * 2 + 30,
      height: 50 + drafts.length * (cell + 60),
      channels: 4,
      background: "#fff",
    },
  })
    .composite(composites)
    .png()
    .toFile(path.join(OUT, "SHEET.png"));
  await fs.writeFile(path.join(OUT, "drafts.json"), JSON.stringify(drafts, null, 2), "utf8");
  console.log("wrote", path.join(OUT, "SHEET.png"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
