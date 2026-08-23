// STUDIO COMMISSION — the patient offline lane: upload image → interpretive
// one-line sketch → blind stage-A gate → full-graph street trace → thin-line
// render → zero-context correct-name gate → Mapbox runnability verify.
//
// Design rules encoded here come from 10 months of measured failures:
//  - The designer NEVER sees the filename (fabricated-text trap, Aug 12).
//  - Nothing is judged by the session that authored it — only fresh
//    zero-context API calls judge, and the gate is CORRECT NAME 3/3,
//    never confidence alone (badgaslogo read "Dog 6" — confidently wrong).
//  - Stage-A first: if the line art doesn't read, streets never will (WOW).
//  - Big canvas, thin render, organic full-graph tracing (July lessons).
//
// Usage: npx tsx scripts/studio-commission.ts <image> <outdir> [rounds]
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { traceShapeOnStreets, type StreetTraceCandidate, type NormalizedPoint } from "../lib/streetGraphTrace";
// Thin CARTO-light renderer (the rendering that matches real Strava art).
import { renderMap } from "./trace-contour";

const require2 = createRequire(path.join(process.cwd(), "package.json"));
const sharp = require2("sharp");

const argsIn = process.argv.slice(2).filter((a) => a !== "--exact");
const EXACT = process.argv.includes("--exact");
const IMG = argsIn[0];
const OUT = argsIn[1] ?? "tmp-studio/run";
const ROUNDS = Number(argsIn[2] ?? 4);
if (!IMG) throw new Error("usage: npx tsx scripts/studio-commission.ts <image> <outdir> [rounds] [--exact]");

let KEY = "";
let MAPBOX = "";

async function loadEnv() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  KEY = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  MAPBOX = env.match(/^NEXT_PUBLIC_MAPBOX_TOKEN=(.+)$/m)?.[1]?.trim() ?? "";
  if (!KEY) throw new Error("ANTHROPIC_API_KEY missing");
  if (!MAPBOX) throw new Error("NEXT_PUBLIC_MAPBOX_TOKEN missing");
}

type Msg = { role: "user" | "assistant"; content: any };
async function claude(model: string, messages: Msg[], maxTokens = 8000, system?: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages, ...(system ? { system } : {}) }),
      });
    } catch {
      // network hiccup (ECONNRESET etc.) — back off and retry, never crash
      await new Promise((r) => setTimeout(r, 8000 * (attempt + 1)));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json: any = await res.json();
    return (json.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
  }
  throw new Error("anthropic: retries exhausted");
}

async function imageBlock(file: string, maxW = 900) {
  const buf = await sharp(file).resize({ width: maxW, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } };
}

// ---------------------------------------------------------------- designer

const DESIGN_SYSTEM = `You are a veteran Strava GPS artist designing a route to be run on Manhattan's real streets. You are given a picture a customer uploaded. Your job is to draw a ONE-LINE interpretive sketch of it — the kind of bold, confident line drawing that, when traced onto city streets and seen at city scale, a stranger instantly names correctly.

Hard-won rules of this medium (violations have all been measured to fail):
1. INTERPRET, don't replicate. Capture the subject's identity with a bold silhouette plus the 2-5 interior strokes that carry identity. Exaggerate identity features (a horn, a spout, a curl) — never shrink them.
2. The drawing becomes a 4-25 km running route spanning roughly 3-8 km of city. One city block is 80-270 m — that is 2-8% of your canvas. THE RESOLUTION LAW: any two strokes that pass within ~8% of the span of each other WILL land on the same street and merge into mush; any feature smaller than ~6% of the span vanishes. So interior details must be FEW (2-3 at most) and HUGE (each 12%+ of the span), with wide empty space between all strokes. When in doubt, delete the detail and let the silhouette carry the identity.
3. ONE continuous polyline (the pen never lifts). To include a detached detail, travel to it by RETRACING already-drawn ink exactly (repeat the same coordinates in reverse), never by cutting a visible chord across empty space.
4. THIN features (thinner than ~6% of the span) must not be drawn as two nearly-touching parallel edges — they collapse. Draw them EITHER as a single centerline stroke retraced exactly, OR widen into a chunky closed ribbon at least 8% of the span wide.
5. Mass reads as art; wireframes read as computer output. Prefer chunky closed shapes. Where the subject has a large solid region whose SHAPE is the identity (a sole, a mane, a panel), you may add 2-4 serpentine back-and-forth passes inside it as texture — straight parallel passes only, each pass at least 8% of the span from the next, entering and exiting through the region's outline. This is how the best real GPS art renders solid mass; use it on at most ONE region.
6. NEVER draw text or letters unless large clear text is the dominant element of the uploaded image itself. Never invent words that are not in the image.
7. Curves are fine (the city has organic streets and diagonals) but keep them large and confident.
7b. ANIMALS: always draw the COMPLETE animal in side profile — full body, legs, tail, posture. A head alone always collapses into "dog/cat/blob" at street scale; a whole standing animal with its defining feature (horn, trunk, hump, long neck) exaggerated is what reads. The classic GPS-art animals are all full-body.
8. Aim for 100-280 points. Density where curvature is high, sparse on straights.

Output STRICT JSON only, no markdown fences:
{"subject": "<2-5 word plain name of what you drew>",
 "altNames": ["<up to 6 other names a stranger might correctly call it>"],
 "notes": "<1-2 sentences: what you kept, dropped, exaggerated and why>",
 "closed": true|false,
 "polyline": [[x,y], ...]}
Coordinates: 0-1 range, y increases DOWNWARD (screen convention). The polyline is drawn in order as one pen stroke.`;

type Design = { subject: string; altNames: string[]; notes: string; closed: boolean; polyline: [number, number][] };

function parseDesign(text: string): Design {
  const raw = text.replace(/^```(json)?/m, "").replace(/```\s*$/m, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const d = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(d.polyline) || d.polyline.length < 20) throw new Error("polyline too short");
  return d;
}

type Feedback = { text: string; imagePath?: string };

async function designSketch(imgFile: string, feedback: Feedback[]): Promise<Design> {
  const content: any[] = [await imageBlock(imgFile)];
  let ask = "Here is the customer's uploaded picture. Design the one-line GPS-art sketch per your rules.";
  if (feedback.length) {
    ask += "\n\nPrevious attempts FAILED their blind test. A zero-context stranger looked at the result and guessed wrong. Feedback history (fix the root cause, redesign boldly, do not repeat a failed composition):\n" + feedback.map((f, i) => `${i + 1}. ${f.text}`).join("\n");
    // Show the most recent street results — the designer must SEE what the
    // city did to the composition, not just read the wrong guesses.
    const withImages = feedback.filter((f) => f.imagePath).slice(-2);
    for (const f of withImages) {
      content.push({ type: "text", text: `Street result of a failed attempt (study exactly which features merged or vanished, and redesign so they cannot):` });
      content.push(await imageBlock(f.imagePath!, 1100));
    }
  }
  content.push({ type: "text", text: ask });
  const text = await claude("claude-fable-5", [{ role: "user", content }], 16000, DESIGN_SYSTEM);
  return parseDesign(text);
}

// ------------------------------------------------------------ line render

async function renderSketchPng(polyline: [number, number][], closed: boolean, file: string, size = 1000) {
  const xs = polyline.map((p) => p[0]);
  const ys = polyline.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 60;
  const s = (size - 2 * pad) / span;
  const pts = polyline.map(([x, y]) => `${(pad + (x - minX) * s).toFixed(1)},${(pad + (y - minY) * s).toFixed(1)}`).join(" ");
  const el = closed ? `<polygon points="${pts}" ` : `<polyline points="${pts}" `;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="white"/>${el}fill="none" stroke="black" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

// ---------------------------------------------------------------- judging

// Crop a map render to the orange route's bounding box (same framing the
// standalone blind-squint judge uses). A keeper must read in BOTH framings —
// the giraffe that read 8/8/7 full-frame read "reindeer" cropped.
async function cropToRoutePng(file: string, outFile: string): Promise<string | null> {
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const { data, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let minX = width, minY = height, maxX = 0, maxY = 0, found = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 150 && r - g > 55 && r - b > 45) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found++;
      }
    }
  }
  if (found < 30) return null;
  const padX = Math.round((maxX - minX) * 0.08) + 20;
  const padY = Math.round((maxY - minY) * 0.08) + 20;
  const left = Math.max(0, minX - padX), top = Math.max(0, minY - padY);
  const w = Math.min(width - left, maxX - minX + 2 * padX);
  const h = Math.min(height - top, maxY - minY + 2 * padY);
  await sharp(file).extract({ left, top, width: w, height: h }).resize({ width: 1000, withoutEnlargement: true }).png().toFile(outFile);
  return outFile;
}

type Verdict = { guess: string; confidence: number };

async function blindJudgeImage(file: string, kind: "line drawing" | "gps route", samples = 3): Promise<Verdict[]> {
  const prompt =
    kind === "line drawing"
      ? 'This is a one-line drawing. What does it depict? Reply exactly:\nGUESS: <1-4 words, or "nothing recognizable">\nCONFIDENCE: <0-10>'
      : 'The orange line is a GPS route someone recorded while running — they were trying to "draw" a recognizable picture or object with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words, or "nothing recognizable">\nCONFIDENCE: <0-10>';
  const img = await imageBlock(file, 1100);
  const out: Verdict[] = [];
  for (let i = 0; i < samples; i++) {
    let guess = "";
    let confidence = 0;
    for (let attempt = 0; attempt < 2 && !guess; attempt++) {
      const text = await claude("claude-fable-5", [{ role: "user", content: [img, { type: "text", text: prompt }] }], 1024);
      guess = (text.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE)/i)?.[1] ?? text.slice(0, 60)).trim();
      confidence = Number(text.match(/CONFIDENCE:\s*(\d+)/i)?.[1] ?? 0);
    }
    out.push({ guess: guess || "no response", confidence });
  }
  return out;
}

async function sameSubject(subject: string, altNames: string[], guess: string): Promise<boolean> {
  const g = guess.toLowerCase().trim();
  // An empty or trivial guess can never count as correct — "".includes()
  // is true for everything and once produced a false 3/3 keeper.
  if (g.length < 3 || g.includes("nothing")) return false;
  const names = [subject, ...altNames].map((n) => n.toLowerCase());
  if (names.some((n) => g.includes(n) || n.includes(g))) return true;
  const text = await claude(
    "claude-fable-5",
    [{ role: "user", content: `Someone drew "${subject}". A stranger guessed the drawing shows "${guess}". Is the stranger's guess essentially correct (same subject or an acceptable name for it)? Acceptable synonyms: ${altNames.join(", ") || "none"}. Reply only YES or NO.` }],
    10,
  );
  return text.toUpperCase().includes("YES");
}

// ------------------------------------------------------ exact-mark lane

// Production-faithful ingest: threshold the upload into the same 300x300
// mask Step 1 builds, run the real extractor, use the contour VERBATIM.
// For abstract brand marks whose identity is exact proportion (a cold judge
// names the real Strava upload 9/9/9 but calls any redrawn chevron sketch
// "lightning bolt"), interpretation destroys identity — fidelity keeps it.
async function exactContourFromImage(imgFile: string): Promise<NormalizedPoint[]> {
  const { extractNormalizedContourFromLineMask } = await import("../lib/extractNormalizedContourFromLineMask");
  const BOX = 300;
  const { data, info } = await sharp(imgFile)
    .flatten({ background: "#ffffff" })
    .resize(BOX, BOX, { fit: "contain", background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(BOX * BOX);
  const lums = new Float32Array(BOX * BOX);
  for (let i = 0; i < BOX * BOX; i++) {
    const r = data[i * info.channels], g = data[i * info.channels + 1], b = data[i * info.channels + 2];
    lums[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  // Adaptive threshold: a colored badge background (the gas logo's yellow
  // disc, lum ~190) floods a fixed cut and the "mark" becomes a circle.
  // Lower the cut until ink is a plausible figure fraction of the canvas.
  let cut = 210;
  for (const candidateCut of [210, 175, 140, 105]) {
    let ink = 0;
    for (let i = 0; i < lums.length; i++) if (lums[i] < candidateCut) ink++;
    cut = candidateCut;
    if (ink / lums.length <= 0.4) break;
  }
  if (cut !== 210) console.log(`exact: adaptive ink threshold ${cut} (a bright background region flooded the default)`);
  for (let i = 0; i < BOX * BOX; i++) mask[i] = lums[i] < cut ? 255 : 0;
  // Sub-legible components (wordmarks, fine print) die at street scale and
  // poison the whole trace (CHANEL letters → 0 routable candidates). Drop
  // any component whose bbox is small in BOTH dimensions relative to the
  // total ink extent; keep the dominant mark.
  const labels = new Int32Array(BOX * BOX);
  let nextLabel = 0;
  const stack: number[] = [];
  const comps: { label: number; minX: number; maxX: number; minY: number; maxY: number; count: number }[] = [];
  for (let i = 0; i < BOX * BOX; i++) {
    if (mask[i] !== 255 || labels[i] !== 0) continue;
    nextLabel++;
    const comp = { label: nextLabel, minX: BOX, maxX: 0, minY: BOX, maxY: 0, count: 0 };
    stack.push(i);
    labels[i] = nextLabel;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % BOX, y = (p / BOX) | 0;
      comp.count++;
      if (x < comp.minX) comp.minX = x;
      if (x > comp.maxX) comp.maxX = x;
      if (y < comp.minY) comp.minY = y;
      if (y > comp.maxY) comp.maxY = y;
      for (const q of [p - 1, p + 1, p - BOX, p + BOX]) {
        if (q < 0 || q >= BOX * BOX) continue;
        if (Math.abs((q % BOX) - x) > 1) continue;
        if (mask[q] === 255 && labels[q] === 0) {
          labels[q] = nextLabel;
          stack.push(q);
        }
      }
    }
    comps.push(comp);
  }
  let inkMinX = BOX, inkMaxX = 0, inkMinY = BOX, inkMaxY = 0;
  for (const c of comps) {
    inkMinX = Math.min(inkMinX, c.minX); inkMaxX = Math.max(inkMaxX, c.maxX);
    inkMinY = Math.min(inkMinY, c.minY); inkMaxY = Math.max(inkMaxY, c.maxY);
  }
  const extent = Math.max(inkMaxX - inkMinX, inkMaxY - inkMinY) || 1;
  const dropped: number[] = [];
  for (const c of comps) {
    const w = c.maxX - c.minX, h = c.maxY - c.minY;
    if (w < extent * 0.12 && h < extent * 0.12) {
      dropped.push(c.label);
      for (let i = 0; i < BOX * BOX; i++) if (labels[i] === c.label) mask[i] = 0;
    }
  }
  if (dropped.length) console.log(`exact: dropped ${dropped.length} sub-legible component(s) (each <12% of the mark's extent — below street resolution)`);
  const contour = extractNormalizedContourFromLineMask(mask, 0.22, BOX, BOX, { source: "silhouette-outline" });
  if (!contour || contour.length < 20) throw new Error("contour extraction failed");
  // Structural pass (codex's artSpec): drop secondary strokes far below the
  // mark's height — wordmark glyph rows under a dominant symbol. A 13%-tall
  // CHANEL letter row made every placement unroutable and would be
  // illegible anyway; the symbol is what survives street scale.
  const { buildArtSpec } = await import("../lib/artSpec");
  const spec = buildArtSpec(contour);
  const totalH = spec.bbox.maxY - spec.bbox.minY || 1;
  if (process.env.STUDIO_DEBUG_SPEC === "1") {
    console.log(`spec: ${spec.strokes.length} strokes, composition=${spec.composition}, totalH=${totalH.toFixed(3)}`);
    for (const s of spec.strokes) console.log(`  h=${(s.bbox.maxY - s.bbox.minY).toFixed(3)} w=${(s.bbox.maxX - s.bbox.minX).toFixed(3)} len=${s.pathLength.toFixed(2)} pts=${s.points.length} closed=${s.isClosed} sal=${s.visualSalience.toFixed(2)}`);
  }
  // A wordmark row — whether it extracts as one band, six letters, or a
  // shredded pile of fragments — is a CLUSTER of many strokes sharing one
  // shallow horizontal band. The nike swoosh centerline alone traces at
  // coverage 1.000; with the text fragments left in, zero placements
  // survive. Drop shallow bands of ≥4 strokes; also drop tiny specks.
  const bands: { minY: number; maxY: number; members: typeof spec.strokes }[] = [];
  for (const s of spec.strokes) {
    const cy = (s.bbox.minY + s.bbox.maxY) / 2;
    let band = bands.find((b) => cy >= b.minY - 0.03 && cy <= b.maxY + 0.03);
    if (!band) {
      band = { minY: s.bbox.minY, maxY: s.bbox.maxY, members: [] };
      bands.push(band);
    }
    band.minY = Math.min(band.minY, s.bbox.minY);
    band.maxY = Math.max(band.maxY, s.bbox.maxY);
    band.members.push(s);
  }
  const dropSet = new Set<string>();
  for (const b of bands) {
    const bandInk = b.members.reduce((a, s) => a + s.pathLength, 0);
    if (b.members.length >= 4 && b.maxY - b.minY < 0.35 * totalH && bandInk < 0.5 * spec.artworkPathLength) {
      for (const s of b.members) dropSet.add(s.id);
    }
  }
  for (const s of spec.strokes) {
    const h = s.bbox.maxY - s.bbox.minY, w = s.bbox.maxX - s.bbox.minX;
    if (Math.max(h, w) < 0.08 * totalH) dropSet.add(s.id); // specks
    // A text row extracted as ONE stroke: shallow band whose ink length far
    // exceeds its width (nike "JUST DO IT": 4.7x; a swoosh/chevron: 1-2.5x).
    if (h < 0.35 * totalH && s.pathLength > 3 * w) dropSet.add(s.id);
  }
  const kept = spec.strokes.filter((s) => !dropSet.has(s.id));
  // Guard: never drop the mark itself — the kept set must contain a stroke
  // whose SPAN is close to the largest. (Ink and salience guards both fail
  // here: a wordmark can out-ink the symbol it accompanies.)
  const span = (s: (typeof spec.strokes)[number]) => Math.max(s.bbox.maxX - s.bbox.minX, s.bbox.maxY - s.bbox.minY);
  const maxSpan = Math.max(...spec.strokes.map(span));
  const keptStrokes = kept.length && kept.length < spec.strokes.length && kept.some((s) => span(s) >= 0.5 * maxSpan) ? kept : spec.strokes;
  if (keptStrokes !== spec.strokes) {
    console.log(`exact: dropped ${spec.strokes.length - kept.length} stroke(s) — wordmark bands / specks below street resolution; kept the dominant symbol`);
  }
  // Thin closed ribbons (a swoosh: two long parallel curved edges) are
  // untraceable as outlines — the edges land on the same street. Collapse
  // them to a single centerline stroke (July finding: single-stroke
  // treatment is how thin marks survive).
  const processed = keptStrokes.map((s) => {
    const span = Math.max(s.bbox.maxX - s.bbox.minX, s.bbox.maxY - s.bbox.minY) || 1;
    const meanWidth = s.pathLength > 0 ? (2 * Math.abs(s.approximateArea)) / s.pathLength : span;
    if (!s.isClosed || meanWidth > span * 0.16 || s.points.length < 8) return s.points;
    // Split the ring at its two mutually-farthest points, average the halves.
    const pts = s.points;
    let ai = 0, bi = 0, best = -1;
    for (let i = 0; i < pts.length; i += 2) {
      for (let j = i + 1; j < pts.length; j += 2) {
        const dd = (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2;
        if (dd > best) { best = dd; ai = i; bi = j; }
      }
    }
    const sideA = pts.slice(ai, bi + 1);
    const sideB = [...pts.slice(bi), ...pts.slice(0, ai + 1)].reverse();
    const N = 48;
    const resample = (line: typeof pts) => {
      const lens = [0];
      for (let i = 1; i < line.length; i++) lens.push(lens[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y));
      const total = lens[lens.length - 1] || 1;
      const out = [];
      for (let k = 0; k < N; k++) {
        const t = (k / (N - 1)) * total;
        let i = 1;
        while (i < lens.length - 1 && lens[i] < t) i++;
        const f = (t - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
        out.push({ x: line[i - 1].x + (line[i].x - line[i - 1].x) * f, y: line[i - 1].y + (line[i].y - line[i - 1].y) * f });
      }
      return out;
    };
    const A = resample(sideA), B = resample(sideB);
    console.log(`exact: collapsed a thin closed ribbon (mean width ${(100 * meanWidth / span).toFixed(1)}% of span) to a single centerline stroke`);
    return A.map((p, i) => ({ x: (p.x + B[i].x) / 2, y: (p.y + B[i].y) / 2 }));
  });
  return processed.flat();
}

// Comparative likeness: the judge sees the upload AND the candidate render.
// Only valid after calibration shows wrong pairs score low.
async function likenessScore(uploadFile: string, renderFile: string, renderKind: string, samples = 3): Promise<number[]> {
  const a = await imageBlock(uploadFile, 700);
  const b = await imageBlock(renderFile, 1100);
  const prompt = `Image 1 is a picture a customer uploaded. Image 2 is ${renderKind}. Score how clearly Image 2 depicts the SAME subject or mark as Image 1, to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>`;
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const text = await claude("claude-fable-5", [{ role: "user", content: [a, b, { type: "text", text: prompt }] }], 512);
    out.push(Number(text.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
  }
  return out;
}

// ------------------------------------------------------------- mapbox gate

async function mapboxVerify(chain: [number, number][]): Promise<{ ok: boolean; walkKm: number; chainKm: number; failedLegs: number }> {
  // Walk the chain through real Mapbox walking directions in ≤24-waypoint
  // legs; a route is runnable only if every leg routes and total walking
  // distance stays within 12% of the chain.
  const R = 6371000;
  const dist = (a: [number, number], b: [number, number]) => {
    const dLat = ((b[0] - a[0]) * Math.PI) / 180;
    const dLng = ((b[1] - a[1]) * Math.PI) / 180;
    const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  let chainM = 0;
  for (let i = 1; i < chain.length; i++) chainM += dist(chain[i - 1], chain[i]);
  // Downsample to waypoints ~180 m apart so requests stay within limits but
  // Mapbox cannot shortcut a whole feature.
  const way: [number, number][] = [chain[0]];
  let acc = 0;
  for (let i = 1; i < chain.length; i++) {
    acc += dist(chain[i - 1], chain[i]);
    if (acc >= 180 || i === chain.length - 1) {
      way.push(chain[i]);
      acc = 0;
    }
  }
  let walkM = 0;
  let failedLegs = 0;
  for (let i = 0; i < way.length - 1; i += 23) {
    const seg = way.slice(i, Math.min(way.length, i + 24));
    if (seg.length < 2) break;
    const coords = seg.map(([lat, lng]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
    const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coords}?geometries=geojson&overview=false&access_token=${MAPBOX}`;
    const res = await fetch(url);
    if (!res.ok) {
      failedLegs++;
      continue;
    }
    const json: any = await res.json();
    if (json.code !== "Ok" || !json.routes?.[0]) {
      failedLegs++;
      continue;
    }
    walkM += json.routes[0].distance;
    await new Promise((r) => setTimeout(r, 350));
  }
  const walkKm = walkM / 1000;
  const chainKm = chainM / 1000;
  const ok = failedLegs === 0 && walkKm > 0 && Math.abs(walkKm - chainKm) / chainKm < 0.12;
  return { ok, walkKm, chainKm, failedLegs };
}

function writeGpx(chain: [number, number][], name: string): string {
  const pts = chain.map(([lat, lng]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${name}</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`;
}

// ------------------------------------------------------------------ main

async function main() {
  await loadEnv();
  await fs.mkdir(OUT, { recursive: true });
  const log: string[] = [];
  const say = (s: string) => {
    console.log(s);
    log.push(s);
  };
  const feedback: Feedback[] = [];
  const keepers: any[] = [];

  if (EXACT) {
    // Single-pass fidelity lane: the contour IS the upload's geometry.
    const dir = path.join(OUT, "exact");
    await fs.mkdir(dir, { recursive: true });
    const contour = await exactContourFromImage(IMG);
    await fs.writeFile(path.join(dir, "contour.json"), JSON.stringify(contour));
    const sketchPng = path.join(dir, "sketch.png");
    await renderSketchPng(contour.map((p) => [p.x, p.y] as [number, number]), false, sketchPng);
    const coldUpload = await blindJudgeImage(IMG, "line drawing");
    say(`upload cold-named as: ${coldUpload.map((v) => `"${v.guess}" ${v.confidence}`).join(" | ")}`);
    const stageA = await likenessScore(IMG, sketchPng, "a black-and-white line drawing extracted from the upload");
    say(`stage-A likeness: ${stageA.join("/")}`);
    if (Math.min(...stageA) < 7) {
      say(`extraction lost the mark — stopping honestly.`);
    } else {
      const t0 = Date.now();
      // Orientation IS identity for a brand mark — a sideways chevron pair
      // scored vis=86 (fidelity to the placed target) yet likeness 1/1/1.
      // Sweep only near-upright placements. anchorM 80: marks live or die on
      // exact proportions and inner notches, so anchor finely.
      const candidates = await traceShapeOnStreets(contour, {
        topK: 4, anchorM: 80, closeLoop: false,
        scales: [1600, 2000, 2600, 3200, 4000], placementsPerScale: 4,
        rots: [0, 12, -12],
      });
      say(`trace: ${candidates.length} candidates in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      for (let c = 0; c < Math.min(5, candidates.length); c++) {
        const cand = candidates[c];
        const mapPng = path.join(dir, `route-${c}.png`);
        await renderMap(cand.chain as any, [], mapPng, 1200, 1000);
        const scores = await likenessScore(IMG, mapPng, "a GPS running route drawn as a thin orange line on a city street map");
        const cold = await blindJudgeImage(mapPng, "gps route");
        say(`route-${c}: ${cand.km.toFixed(1)} km vis=${cand.visualScore.toFixed(0)} likeness=${scores.join("/")} cold=${cold.map((v) => `"${v.guess}" ${v.confidence}`).join(" | ")}`);
        if (Math.min(...scores) >= 7) {
          const mv = await mapboxVerify(cand.chain as [number, number][]);
          say(`  mapbox: ok=${mv.ok} walk=${mv.walkKm.toFixed(1)}km chain=${mv.chainKm.toFixed(1)}km failedLegs=${mv.failedLegs}`);
          if (mv.ok) {
            const gpx = path.join(dir, `route-${c}.gpx`);
            await fs.writeFile(gpx, writeGpx(cand.chain as [number, number][], "exact mark"));
            keepers.push({ mode: "exact", candidate: c, km: cand.km, walkKm: mv.walkKm, likeness: scores, cold, png: mapPng, gpx });
            say(`  KEEPER saved: ${gpx}`);
            break;
          }
        }
      }
    }
    await fs.writeFile(path.join(OUT, "keepers.json"), JSON.stringify(keepers, null, 2));
    await fs.writeFile(path.join(OUT, "log.txt"), log.join("\n"));
    say(`\nDONE — ${keepers.length} keeper(s). Output: ${OUT}`);
    return;
  }

  for (let round = 1; round <= ROUNDS; round++) {
    const dir = path.join(OUT, `round-${round}`);
    await fs.mkdir(dir, { recursive: true });
    say(`\n=== ROUND ${round}`);

    // 1. design
    let design: Design;
    try {
      design = await designSketch(IMG, feedback);
    } catch (e: any) {
      say(`design parse failed: ${e.message}; retrying once`);
      design = await designSketch(IMG, feedback);
    }
    await fs.writeFile(path.join(dir, "design.json"), JSON.stringify(design, null, 2));
    say(`design: "${design.subject}" (${design.polyline.length} pts, closed=${design.closed}) — ${design.notes}`);

    // 2. stage-A blind gate on the sketch itself
    const sketchPng = path.join(dir, "sketch.png");
    await renderSketchPng(design.polyline, design.closed, sketchPng);
    const stageA = await blindJudgeImage(sketchPng, "line drawing");
    let stageACorrect = 0;
    for (const v of stageA) if (await sameSubject(design.subject, design.altNames, v.guess)) stageACorrect++;
    say(`stage-A: ${stageA.map((v) => `"${v.guess}" ${v.confidence}`).join(" | ")} → ${stageACorrect}/3 correct`);
    if (stageACorrect < 3) {
      feedback.push({ text: `Sketch itself misread as: ${stageA.map((v) => v.guess).join(", ")} (intended "${design.subject}"). The line art must be unmistakable before streets.` });
      continue;
    }

    // 3+4. trace on real streets, judge candidates against the great-bar.
    const contour: NormalizedPoint[] = design.polyline.map(([x, y]) => ({ x, y }));
    const d = design;

    type Pass = {
      keeper?: any;
      bestWeak?: { mapPng: string; confs: number[] };
      firstFail?: { mapPng: string; guesses: string[] };
      traced: number;
    };
    const traceAndJudge = async (label: string, opts: { scales: number[]; placementsPerScale: number; judgeTop: number }): Promise<Pass> => {
      const t0 = Date.now();
      // Trace at a fine AND a deliberate anchor cadence. Sparse anchors (380 m)
      // measured +4-5 cleanliness/economy at equal blind legibility — long
      // straight runs instead of ladder hops — but fine detail needs 120 m.
      // Let the visual scorer pick per placement.
      const perAnchor = await Promise.all([120, 380].map((anchorM) =>
        traceShapeOnStreets(contour, {
          topK: 4,
          anchorM,
          closeLoop: d.closed,
          scales: opts.scales,
          placementsPerScale: opts.placementsPerScale,
        }),
      ));
      const candidates: StreetTraceCandidate[] = perAnchor
        .flat()
        .sort((a, b) => b.visualScore - a.visualScore || b.visualCleanliness - a.visualCleanliness);
      say(`trace(${label}): ${candidates.length} candidates in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      const pass: Pass = { traced: candidates.length };
      for (let c = 0; c < Math.min(opts.judgeTop, candidates.length); c++) {
        const cand = candidates[c];
        const mapPng = path.join(dir, `${label}${c}.png`);
        await renderMap(cand.chain as any, [], mapPng, 1200, 1000);
        const verdicts = await blindJudgeImage(mapPng, "gps route");
        let correct = 0;
        for (const v of verdicts) if (await sameSubject(d.subject, d.altNames, v.guess)) correct++;
        const confs = verdicts.map((v) => v.confidence);
        const minConf = Math.min(...confs);
        const avgConf = confs.reduce((a, b) => a + b, 0) / confs.length;
        say(`${label}${c}: ${cand.km.toFixed(1)} km vis=${cand.visualScore.toFixed(0)} → ${verdicts.map((v) => `"${v.guess}" ${v.confidence}`).join(" | ")} → ${correct}/3 (min ${minConf}, avg ${avgConf.toFixed(1)})`);
        // "Great" bar, not merely recognizable: named right by all three AND
        // obvious at a glance (heart keeper = 9/9/9; that is the level).
        if (correct === 3 && minConf >= 6 && avgConf >= 7) {
          // Dual-framing gate: must ALSO read when cropped to the route.
          const croppedPng = await cropToRoutePng(mapPng, mapPng.replace(/\.png$/, "-crop.png"));
          if (croppedPng) {
            const cropVerdicts = await blindJudgeImage(croppedPng, "gps route");
            let cropCorrect = 0;
            for (const v of cropVerdicts) if (await sameSubject(d.subject, d.altNames, v.guess)) cropCorrect++;
            say(`  crop-check: ${cropVerdicts.map((v) => `"${v.guess}" ${v.confidence}`).join(" | ")} → ${cropCorrect}/3`);
            if (cropCorrect < 3) {
              if (!pass.bestWeak) pass.bestWeak = { mapPng, confs };
              continue;
            }
          }
          const mv = await mapboxVerify(cand.chain as [number, number][]);
          say(`  mapbox: ok=${mv.ok} walk=${mv.walkKm.toFixed(1)}km chain=${mv.chainKm.toFixed(1)}km failedLegs=${mv.failedLegs}`);
          if (mv.ok) {
            const gpx = path.join(dir, `${label}${c}.gpx`);
            await fs.writeFile(gpx, writeGpx(cand.chain as [number, number][], d.subject));
            pass.keeper = {
              round, candidate: c, subject: d.subject, km: cand.km, walkKm: mv.walkKm,
              visualScore: cand.visualScore, verdicts, png: mapPng, gpx, sketch: sketchPng,
              center: cand.center, scaleM: cand.scaleM, rotDeg: cand.rotDeg, notes: d.notes,
            };
            say(`  KEEPER saved: ${gpx}`);
            return pass;
          }
        } else if (correct === 3 && !pass.bestWeak) {
          pass.bestWeak = { mapPng, confs };
        } else if (!pass.firstFail) {
          pass.firstFail = { mapPng, guesses: verdicts.map((v) => v.guess) };
        }
      }
      return pass;
    };

    const first = await traceAndJudge("route-", { scales: [1300, 1800, 2400, 3200, 4000], placementsPerScale: 3, judgeTop: 3 });
    let final = first;
    if (!first.keeper && first.traced === 0) {
      feedback.push({ text: `No street placement survived the runnability gates for this composition — likely too much fine parallel detail. Simplify strokes, bolder masses.` });
      continue;
    }
    if (!first.keeper && first.bestWeak) {
      // The DESIGN is proven (named correctly, just weakly). Placement, not
      // the sketch, is the variable now — search much wider before ever
      // redesigning. This is where earlier rounds were wasted.
      say(`design reads correctly — widening placement search instead of redesigning`);
      final = await traceAndJudge("wide-", { scales: [1600, 2000, 2600, 3200, 4000], placementsPerScale: 7, judgeTop: 6 });
      if (!final.bestWeak) final.bestWeak = first.bestWeak;
    }
    if (final.keeper) {
      keepers.push(final.keeper);
      break;
    }
    if (final.bestWeak) {
      feedback.push({
        text: `On streets the route WAS read correctly as "${d.subject}" but only weakly (confidences ${final.bestWeak.confs.join("/")}; the bar is all ≥6 with average ≥7), even after a wide placement search. The composition must be OBVIOUS at a glance: bolder masses, cleaner separation, stronger identity features.`,
        imagePath: final.bestWeak.mapPng,
      });
    } else if (final.firstFail ?? first.firstFail) {
      const ff = (final.firstFail ?? first.firstFail)!;
      feedback.push({
        text: `On streets the best route was read as: ${ff.guesses.join(", ")} (intended "${d.subject}"). Exaggerate what distinguishes the subject from those wrong guesses; drop whatever caused them.`,
        imagePath: ff.mapPng,
      });
    }
  }

  await fs.writeFile(path.join(OUT, "keepers.json"), JSON.stringify(keepers, null, 2));
  await fs.writeFile(path.join(OUT, "log.txt"), log.join("\n"));
  say(`\nDONE — ${keepers.length} keeper(s). Output: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
