/**
 * Generate a /api/vision-design response payload (production shape) using the
 * exact production prompt — for the autofind harness's --vision stub.
 * Run: npx tsx scripts/gen-draft-payload.ts gas.png 6 tmp-autofind-harness/drafts-new.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { buildInterpretationPrompt } from "../lib/interpretationPrompt";

async function main() {
  const image = process.argv[2] ?? "gas.png";
  const draftCount = Number(process.argv[3] ?? 6);
  const outFile = process.argv[4] ?? "tmp-autofind-harness/drafts-new.json";
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const key = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim();
  if (!key) throw new Error("no ANTHROPIC_API_KEY in .env.local");
  const client = new Anthropic({ apiKey: key });
  const data = (await fs.readFile(image)).toString("base64");
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data } },
          { type: "text", text: buildInterpretationPrompt("Manhattan", draftCount) },
        ],
      },
    ],
  });
  const text = message.content.find((b) => b.type === "text");
  const raw = text && text.type === "text" ? text.text.trim() : "";
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  await fs.writeFile(outFile, JSON.stringify(parsed, null, 2), "utf8");
  const drafts = Array.isArray(parsed.drafts) ? parsed.drafts : [];
  console.log(
    `saved ${outFile}: ${drafts.length} drafts, points: ${drafts.map((d: { points?: unknown[] }) => d.points?.length).join(",")}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
