import sharp from "sharp";
import {
  traceShapeOnStreets,
  type NormalizedPoint,
  type StreetTraceCandidate,
} from "./streetGraphTrace";

const MAX_POINTS = 600;
// Trace cost scales with contour length; photo uploads send up to 600
// points but the street lattice can't render detail finer than ~240 points
// resolve anyway. Downsampling is the difference between 20 s and minutes.
const TRACE_POINTS = 240;
// Hard wall for the whole request: sweeps stop starting after this, so the
// user never waits on a silent function that the platform will kill anyway.
const TIME_BUDGET_MS = 200_000;
const JUDGE_MODEL = "claude-fable-5";

function cleanContour(raw: unknown): NormalizedPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedPoint[] = [];
  for (const p of raw) {
    if (
      p &&
      typeof p === "object" &&
      Number.isFinite((p as { x?: number }).x) &&
      Number.isFinite((p as { y?: number }).y)
    ) {
      out.push({
        x: Math.min(1, Math.max(0, (p as { x: number }).x)),
        y: Math.min(1, Math.max(0, (p as { y: number }).y)),
      });
      if (out.length >= MAX_POINTS) break;
    }
  }
  return out;
}

function downsampleContour(contour: NormalizedPoint[], maxPoints: number): NormalizedPoint[] {
  if (contour.length <= maxPoints) return contour;
  const out: NormalizedPoint[] = [];
  const step = contour.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) {
    out.push(contour[Math.floor(i * step)]!);
  }
  return out;
}

async function callClaude(content: unknown[], maxTokens = 1024): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured on server");
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: JUDGE_MODEL,
          max_tokens: maxTokens,
          messages: [{ role: "user", content }],
        }),
      });
    } catch {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(" ")
      .trim();
  }
  throw new Error("anthropic retries exhausted");
}

/** Render a route chain as a thin orange line on plain white, for judging. */
async function renderChainPng(chain: [number, number][]): Promise<Buffer> {
  const lats = chain.map((p) => p[0]);
  const lngs = chain.map((p) => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const mLng = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const spanLat = Math.max(1e-6, maxLat - minLat);
  const spanLng = Math.max(1e-6, (maxLng - minLng) * mLng);
  const span = Math.max(spanLat, spanLng);
  const SIZE = 1000, PAD = 60;
  const sc = (SIZE - 2 * PAD) / span;
  const pts = chain
    .map(([lat, lng]) => {
      const x = PAD + ((lng - minLng) * mLng - (spanLng - span) / 2) * sc;
      const y = PAD + (maxLat - lat - (spanLat - span) / 2) * sc;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="100%" height="100%" fill="white"/><polyline points="${pts}" fill="none" stroke="#fc5200" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

function pngBlock(buf: Buffer) {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") },
  };
}

async function nameSubject(imageBase64: string): Promise<{ subject: string; alts: string[] } | null> {
  try {
    const media = imageBase64.startsWith("data:")
      ? imageBase64.slice(5, imageBase64.indexOf(";"))
      : "image/png";
    const data = imageBase64.includes(",") ? imageBase64.slice(imageBase64.indexOf(",") + 1) : imageBase64;
    const t = await callClaude([
      { type: "image", source: { type: "base64", media_type: media, data } },
      {
        type: "text",
        text:
          'Name what this picture depicts, plus up to 5 other names a stranger might correctly call it. Reply STRICT JSON only: {"subject":"<1-4 words>","alts":["..."]}',
      },
    ]);
    const parsed = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)) as {
      subject?: string;
      alts?: string[];
    };
    if (!parsed.subject) return null;
    return { subject: parsed.subject, alts: Array.isArray(parsed.alts) ? parsed.alts.slice(0, 6) : [] };
  } catch {
    return null;
  }
}

async function sameSubject(subject: string, alts: string[], guess: string): Promise<boolean> {
  const g = guess.toLowerCase().trim();
  if (g.length < 3 || g.includes("nothing")) return false;
  const names = [subject, ...alts].map((n) => n.toLowerCase());
  if (names.some((n) => g.includes(n) || n.includes(g))) return true;
  try {
    const t = await callClaude(
      [
        {
          type: "text",
          text: `Someone drew "${subject}". A stranger guessed the drawing shows "${guess}". Is the guess essentially correct (same subject or an acceptable name for it)? Acceptable synonyms: ${alts.join(", ") || "none"}. Reply only YES or NO.`,
        },
      ],
      16,
    );
    return t.toUpperCase().includes("YES");
  } catch {
    return false;
  }
}

export type StudioResult = {
  ok: boolean;
  verified?: boolean;
  reason?: string;
  subject?: string;
  chain?: [number, number][];
  km?: number;
  visualScore?: number;
  verdicts?: { guess: string; confidence: number }[];
};

export async function runStudio(
  body: { contour?: unknown; subject?: unknown; imageBase64?: unknown },
  onProgress: (detail: string) => void,
): Promise<StudioResult> {
  const started = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - started);

  const contour = downsampleContour(cleanContour(body.contour), TRACE_POINTS);
  if (contour.length < 8) return { ok: false, reason: "contour-too-short" };

  let subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : null;
  let alts: string[] = [];
  if (!subject && typeof body.imageBase64 === "string" && body.imageBase64.length > 100) {
    onProgress("Studio lane: naming your subject…");
    const named = await nameSubject(body.imageBase64);
    if (named) {
      subject = named.subject;
      alts = named.alts;
    }
  }

  // dual-cadence sweep, sequential so progress flows between them and the
  // time budget can stop the second one.
  const sweeps: StreetTraceCandidate[] = [];
  const cadences: [number, string][] = [
    [120, "Studio lane: tracing your shape on real streets (fine cadence)…"],
    [380, "Studio lane: tracing again with long deliberate strokes…"],
  ];
  for (const [anchorM, label] of cadences) {
    if (timeLeft() < 30_000) break;
    onProgress(label);
    // let the progress line flush before the CPU-bound sweep
    await new Promise((r) => setTimeout(r, 10));
    try {
      const found = await traceShapeOnStreets(contour, {
        topK: 3,
        anchorM,
        placementsPerScale: 2,
        // hero scales only: below ~1300 m half-size, features collapse into
        // the lattice and nothing has ever passed the correct-name gate.
        scales: [1300, 1800, 2400, 3200],
      });
      sweeps.push(...found);
    } catch {
      /* a failed sweep just contributes nothing */
    }
  }
  const candidates = sweeps
    .sort((a, b) => b.visualScore - a.visualScore || b.visualCleanliness - a.visualCleanliness)
    .slice(0, 3);
  if (!candidates.length) return { ok: false, reason: "no-placement" };

  if (!subject) {
    const best = candidates[0]!;
    return {
      ok: true,
      verified: false,
      reason: "no-subject",
      chain: best.chain as [number, number][],
      km: best.km,
      visualScore: best.visualScore,
    };
  }

  // judge the top two candidates: 2 zero-context samples each; verified
  // requires both samples naming the subject correctly.
  const judgeable = candidates.slice(0, 2);
  for (let c = 0; c < judgeable.length; c++) {
    if (timeLeft() < 20_000) break;
    const cand = judgeable[c]!;
    onProgress(`Studio lane: showing route ${c + 1} of ${judgeable.length} to blind judges…`);
    let png: Buffer;
    try {
      png = await renderChainPng(cand.chain as [number, number][]);
    } catch {
      continue;
    }
    const verdicts: { guess: string; confidence: number }[] = [];
    let correct = 0;
    for (let i = 0; i < 2; i++) {
      let guess = "";
      let confidence = 0;
      try {
        const t = await callClaude([
          pngBlock(png),
          {
            type: "text",
            text:
              'The orange line is a GPS route someone recorded while running - they were trying to "draw" a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words, or "nothing recognizable">\nCONFIDENCE: <0-10>',
          },
        ]);
        guess = (t.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE)/i)?.[1] ?? "").trim();
        confidence = Number(t.match(/CONFIDENCE:\s*(\d+)/i)?.[1] ?? 0);
      } catch {
        /* judged as failure */
      }
      verdicts.push({ guess: guess || "no response", confidence });
      if (guess && (await sameSubject(subject, alts, guess))) correct++;
    }
    if (correct === 2) {
      return {
        ok: true,
        verified: true,
        subject,
        chain: cand.chain as [number, number][],
        km: cand.km,
        visualScore: cand.visualScore,
        verdicts,
      };
    }
  }
  const best = candidates[0]!;
  return {
    ok: true,
    verified: false,
    reason: "not-recognized",
    subject,
    chain: best.chain as [number, number][],
    km: best.km,
    visualScore: best.visualScore,
  };
}

