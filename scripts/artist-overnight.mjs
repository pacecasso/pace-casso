/**
 * Overnight artist harness — wide search + surgical hill-climbing, with a
 * hard taste gate. Ralph only ever sees candidates the informed critic
 * scores >= 6/10 (his calibration point: today's rejects scored 2-4 by both
 * him and the critic).
 *
 * Per subject:
 *   Phase A (WIDE): 10 independent street-DSL compositions, each steered by
 *     a different strategy hint. Route + score each. Top 3 become "bones".
 *   Phase B (SURGICAL): for each bone, up to 10 rounds of EDIT OPERATIONS
 *     only (replace/insert/delete waypoint ranges, max 5 ops/round) —
 *     hill-climbing: keep an edit only if the score improves. This is the
 *     mechanism behind every hand-made winner (GAS v1→v5): iterate on one
 *     composition, never redraw from scratch.
 *   Gate: candidates with mean informed score >= 6 get Mapbox-verified and
 *     copied to tmp-artist-city/OVERNIGHT/passing/ + a contact sheet.
 *
 * Run: node scripts/artist-overnight.mjs [image1 image2 ...]
 *   (default subjects: gas.png sneaker.jpg unicorn.jpg witch.jpg)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { loadNetwork, haversine } from "./gas-spike-lattice.mjs";
const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");

/** Args: "file.png=what the user says it is" (subject after = is used verbatim,
 *  the way a real user would name their upload; bare filenames fall back to
 *  auto-pinning). */
const argFiles = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const RAW_SUBJECTS = argFiles.length
  ? argFiles
  : ["gas.png=a gas pump", "sneaker.jpg=a sneaker", "unicorn.jpg=a unicorn", "witch.jpg=a witch on a broomstick"];
const SUBJECTS = RAW_SUBJECTS.map((s) => {
  const eq = s.indexOf("=");
  return eq > 0 ? { file: s.slice(0, eq), subject: s.slice(eq + 1).trim() } : { file: s, subject: null };
});
const DESIGNER_MODEL = "claude-fable-5";
const JUDGE_MODEL = "claude-opus-4-8";
const WIDE_N = 10;
const BONES = 3;
const EDIT_ROUNDS = 10;
const PASS_SCORE = 6;
const ROOT = path.join(process.cwd(), "tmp-artist-city", "OVERNIGHT");

async function readEnv(name) {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) throw new Error(`${name} not found in .env.local`);
  return m[1].trim();
}

// ---------------------------------------------------------------- anthropic
let anthropicKey = "";
async function callClaude(model, content, maxTokens, thinking = false) {
  let useThinking = thinking;
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content }] };
    if (useThinking) body.thinking = { type: "adaptive" };
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const wait = 6000 * (attempt + 1);
      console.log(`  api network error (${err.message}), retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 400 && useThinking) {
      useThinking = false;
      continue;
    }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const wait = 6000 * (attempt + 1);
      console.log(`  api ${res.status}, retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const text = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(" ")
      .trim();
    if (text) return text;
    throw new Error(`empty response (stop=${json.stop_reason})`);
  }
  throw new Error("Anthropic API kept failing");
}

function parseJsonLoose(text) {
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  if (start < 0) throw new Error("no JSON object");
  const end = stripped.lastIndexOf("}");
  if (end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch { /* repair */ }
  }
  let body = stripped.slice(start);
  const last = body.lastIndexOf("]");
  if (last < 0) throw new Error("unrepairable JSON");
  body = body.slice(0, last + 1);
  let dc = 0, ds = 0;
  for (const ch of body) {
    if (ch === "{") dc++;
    else if (ch === "}") dc--;
    else if (ch === "[") ds++;
    else if (ch === "]") ds--;
  }
  body += "]".repeat(Math.max(0, ds)) + "}".repeat(Math.max(0, dc));
  return JSON.parse(body);
}

// ---------------------------------------------------------------- DSL
const STRATEGY_HINTS = [
  "SILHOUETTE ONLY: one bold closed outline, zero interior detail. The outline alone must carry the subject.",
  "CONTAINER + CONTENT: a giant simple container outline with the subject's key detail drawn inside it.",
  "TEXTURE-HEAVY: bold outline plus dense parallel-street texture (stripes/laces/fur) — one stroke per street, comb style.",
  "HORIZONTAL COMPOSITION: subject lying/moving east-west across the island's width.",
  "VERTICAL COMPOSITION: subject standing tall, north-south, 4+ km of height.",
  "DOWNTOWN ORGANIC: build the whole subject from the irregular streets below Houston — crooked fabric as organic line.",
  "GRID ICONIC: pure Midtown/Chelsea rectangles — the subject as a bold pictogram of clean boxes.",
  "EXTREME CLOSE-UP: draw only the subject's most iconic PART (the head, the hose+nozzle, one shoe) as large as possible.",
  "PROFILE VIEW: strict side profile, facing west, feet/base on a single straight street as a ground line.",
  "MINIMAL 20: at most 20 waypoints. Nothing that is not essential.",
];

const DSL_RULES = `THE MEDIUM: your design is ONE ordered list of real Manhattan intersections, each a pair of street names: ["Orchard Street","Broome Street"]. Consecutive waypoints connect along real streets (shared street name = clean corridor leg; no shared name = shortest walking path, which WILL be drawn as visible ink — so consecutive waypoints must share a street except when deliberately retracing existing ink). Retracing streets you already drew is the correct way to travel between features.

HARD DRAWING RULES (violations ruined earlier attempts):
- CLOSURE: every box/loop must return to its starting corner BEFORE the line moves on. An open rectangle reads as a digit ("4", "7", "P"), not an object.
- NO STRAY TAILS: never end a stroke in open space; end on existing ink or close the loop.
- THE DOG ATTRACTOR: a lumpy mass with 2-4 short strokes poking down reads as "a dog". Check the silhouette.
- SCALE IS COURAGE: the masters' pieces span 15-25 km. Identity features get whole neighborhoods.
- LES FINE GRID (Orchard/Ludlow/Essex/Norfolk/Suffolk/Clinton x Hester/Grand/Broome/Delancey/Rivington/Stanton) for small features; Chelsea/Midtown numbered grid for big boxes; crooked downtown streets for organic curves.
- Use exact official names: "West 23rd Street", "East 4th Street", "10th Avenue", "Avenue B", "Bowery", "Broadway".
- 20-160 waypoints, route 8-26 km, Manhattan only.`;

const DESIGN_JSON = `Return ONLY JSON:
{
  "label": "short subject name",
  "concept": "2-3 sentences",
  "acceptableGuesses": ["4-8 words a stranger might say that count as recognition"],
  "waypoints": [["10th Avenue","West 26th Street"], ...]
}`;

function cleanDesign(raw, fallbackLabel) {
  const j = raw ?? {};
  if (!Array.isArray(j.waypoints)) return null;
  const wps = [];
  for (const w of j.waypoints) {
    if (Array.isArray(w) && typeof w[0] === "string" && typeof w[1] === "string") {
      wps.push([w[0].trim(), w[1].trim()]);
    }
  }
  if (wps.length < 8) return null;
  return {
    label: typeof j.label === "string" ? j.label : fallbackLabel,
    concept: typeof j.concept === "string" ? j.concept : "",
    acceptableGuesses: Array.isArray(j.acceptableGuesses)
      ? j.acceptableGuesses.filter((g) => typeof g === "string")
      : [],
    waypoints: wps,
  };
}

// ---------------------------------------------------------------- routing
function routeWaypoints(net, waypoints) {
  const { nodes, intersectionOf, corridorPath, walkPath } = net;
  const unresolved = [];
  const ids = waypoints.map(([a, b]) => {
    const id = intersectionOf(a, b) ?? intersectionOf(b, a);
    if (!id) unresolved.push(`${a} & ${b}`);
    return id;
  });
  const coords = [];
  const problems = [];
  const pathLen = (p) => {
    let m = 0;
    for (let k = 1; k < p.length; k++) m += haversine(nodes.get(p[k - 1]), nodes.get(p[k]));
    return m;
  };
  let prevIdx = -1;
  for (let i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    if (prevIdx < 0) {
      prevIdx = i;
      coords.push(nodes.get(ids[i]));
      continue;
    }
    const from = ids[prevIdx];
    const to = ids[i];
    const [a0, b0] = waypoints[prevIdx];
    const [a1, b1] = waypoints[i];
    prevIdx = i;
    if (from === to) continue;
    const shared = a0 === a1 || a0 === b1 ? a0 : b0 === a1 || b0 === b1 ? b0 : null;
    let p = null;
    if (shared) p = corridorPath(shared, from, to);
    const chord = haversine(nodes.get(from), nodes.get(to));
    if (!p || pathLen(p) > chord * 1.3) {
      const w = walkPath(from, to);
      if (w && (!p || pathLen(w) < pathLen(p))) p = w;
    }
    if (!p) {
      problems.push(`unroutable: ${a0} & ${b0} -> ${a1} & ${b1}`);
      continue;
    }
    const m = pathLen(p);
    if (m / Math.max(chord, 1) > 1.6 && m - chord > 150) {
      problems.push(`big detour: ${a0} & ${b0} -> ${a1} & ${b1}`);
    }
    const pts = p.map((id) => nodes.get(id));
    coords.push(...(coords.length ? pts.slice(1) : pts));
  }
  let km = 0;
  for (let i = 1; i < coords.length; i++) km += haversine(coords[i - 1], coords[i]) / 1000;
  return { coords, km, problems, unresolved };
}

// ---------------------------------------------------------------- render + judges
const TILE = 256;
const lonToX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
const tileCache = new Map();

async function renderStrava(chain, file, w = 1500, h = 1500) {
  let zoom = 13;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z));
    const ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.82 && Math.max(...ys) - Math.min(...ys) <= h * 0.82) {
      zoom = z;
      break;
    }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom));
  const ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2;
  const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      const key = `${zoom}/${tx}/${ty}`;
      let buf = tileCache.get(key);
      if (!buf) {
        try {
          const res = await fetch(`https://tile.openstreetmap.org/${key}.png`, {
            headers: { "User-Agent": "pace-casso route preview (dev)" },
          });
          if (!res.ok) continue;
          buf = Buffer.from(await res.arrayBuffer());
          tileCache.set(key, buf);
        } catch {
          continue;
        }
      }
      tiles.push({ input: buf, left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
    }
  }
  const base = await sharp({ create: { width: w, height: h, channels: 4, background: "#f5f4f2" } })
    .composite(tiles).png().toBuffer();
  const light = await sharp(base).modulate({ saturation: 0.18, brightness: 1.22 }).png().toBuffer();
  const d = chain
    .map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`)
    .join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>` +
      `<path d="${d}" fill="none" stroke="#fc5200" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`,
  );
  await sharp(light).composite([{ input: overlay, left: 0, top: 0 }]).png().toFile(file);
}

async function cropToRoute(file) {
  const img = sharp(file);
  const meta = await img.metadata();
  const width = meta.width, height = meta.height;
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
  if (found < 30) return sharp(file).resize({ width: 1100 }).jpeg({ quality: 85 }).toBuffer();
  const padX = Math.round((maxX - minX) * 0.08) + 20;
  const padY = Math.round((maxY - minY) * 0.08) + 20;
  const left = Math.max(0, minX - padX), top = Math.max(0, minY - padY);
  return sharp(file)
    .extract({
      left, top,
      width: Math.min(width - left, maxX - minX + 2 * padX),
      height: Math.min(height - top, maxY - minY + 2 * padY),
    })
    .resize({ width: 1000, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

const BLIND_PROMPT =
  'The orange line is a GPS route someone recorded while running — they were trying to "draw" a recognizable picture, shape, letter, or object with their path (like Strava art). ' +
  'What were they trying to draw? Reply exactly:\nGUESS: <1-3 words, or "nothing recognizable">\nCONFIDENCE: <0-10>';

const GENERIC_TOKENS = new Set([
  "head", "face", "animal", "figure", "shape", "object", "thing",
  "drawing", "picture", "outline", "body", "man", "woman",
]);
const norm = (s) =>
  s.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .filter((w) => !GENERIC_TOKENS.has(w));

function guessMatches(guess, acceptable) {
  const g = norm(guess);
  if (!g.length || guess.toLowerCase().includes("nothing recognizable")) return false;
  for (const a of acceptable) {
    const at = norm(a);
    if (!at.length) continue;
    if (at.some((t) => g.includes(t)) || g.some((t) => at.includes(t))) return true;
  }
  return false;
}

async function judgeImage(cropBuf, prompt) {
  const text = await callClaude(
    JUDGE_MODEL,
    [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: cropBuf.toString("base64") } },
      { type: "text", text: prompt },
    ],
    1024,
  );
  return text.replace(/\s+/g, " ");
}

/** Combined evaluation: 1 blind + 2 informed. Score weighted to the
 *  informed critic (it matches Ralph's calibration on our outputs). */
async function evaluate(mapFile, subject, acceptable) {
  const crop = await cropToRoute(mapFile);
  const blindText = await judgeImage(crop, BLIND_PROMPT);
  const blindGuess = blindText.match(/GUESS:\s*(.+?)(?:CONFIDENCE|$)/i)?.[1]?.trim() ?? "";
  const blindConf = Number(blindText.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)/i)?.[1] ?? 0);
  const blindHit = guessMatches(blindGuess, acceptable);
  const informedPrompt =
    `This image shows a GPS running route drawn on a city map as Strava art. The runner intended it to depict ${subject}. ` +
    `As a harsh art critic who has seen the best GPS art, score how well this route actually reads as ${subject} at a glance — clean silhouette, key features present, minimal noise. ` +
    `Reply exactly:\nSCORE: <0-10>\nWHY: <one short sentence>`;
  const scores = [];
  const notes = [];
  for (let i = 0; i < 2; i++) {
    const t = await judgeImage(crop, informedPrompt);
    scores.push(Number(t.match(/SCORE:\s*(\d+(?:\.\d+)?)/i)?.[1] ?? 0));
    notes.push(t.match(/WHY:\s*(.+)/i)?.[1]?.trim() ?? "");
  }
  const informedMean = scores.reduce((s, v) => s + v, 0) / Math.max(1, scores.length);
  const score = informedMean * 2 + (blindHit ? 6 : 0) + blindConf * 0.3;
  return { score, informedMean, informedNotes: notes, blindGuess, blindConf, blindHit };
}

// ---------------------------------------------------------------- exemplars
const MASTER_EXEMPLARS = [
  { file: "lion.webp", note: "huge boxy creature on the Midtown grid, limbs as clean rectangles, whole-neighborhood scale" },
  { file: "TIGER.webp", note: "tiger on the irregular downtown fabric — crooked streets ARE the stripe/fur texture" },
  { file: "LOVE.png", note: "container + content: giant heart outline with the word LOVE flowing inside it" },
];

async function loadMasterBlocks() {
  const blocks = [
    {
      type: "text",
      text:
        "STUDY THE MASTERS — real human-made GPS-art masterpieces:\n" +
        MASTER_EXEMPLARS.map((e, i) => `${i + 1}. ${e.note}`).join("\n"),
    },
  ];
  for (const e of MASTER_EXEMPLARS) {
    try {
      const buf = await sharp(path.join(process.cwd(), e.file))
        .resize({ width: 900, withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 80 })
        .toBuffer();
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } });
    } catch { /* optional */ }
  }
  return blocks;
}

// ---------------------------------------------------------------- edit ops
function applyEditOps(waypoints, ops) {
  let wps = waypoints.map((w) => [w[0], w[1]]);
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const clean = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((w) => Array.isArray(w) && typeof w[0] === "string" && typeof w[1] === "string")
        .map((w) => [w[0].trim(), w[1].trim()]);
    if (op.op === "replace" && Number.isInteger(op.from) && Number.isInteger(op.to)) {
      const from = Math.max(0, op.from);
      const to = Math.min(wps.length - 1, op.to);
      if (from > to) continue;
      wps = [...wps.slice(0, from), ...clean(op.waypoints), ...wps.slice(to + 1)];
    } else if (op.op === "insert" && Number.isInteger(op.after)) {
      const after = Math.max(-1, Math.min(wps.length - 1, op.after));
      wps = [...wps.slice(0, after + 1), ...clean(op.waypoints), ...wps.slice(after + 1)];
    } else if (op.op === "delete" && Number.isInteger(op.from) && Number.isInteger(op.to)) {
      const from = Math.max(0, op.from);
      const to = Math.min(wps.length - 1, op.to);
      if (from > to) continue;
      wps = [...wps.slice(0, from), ...wps.slice(to + 1)];
    }
  }
  if (wps.length < 8 || wps.length > 200) return null;
  return wps;
}

// ---------------------------------------------------------------- phases
async function wideSearch(net, imageBlock, masterBlocks, subjectLabel, outDir, pinnedSubject) {
  const candidates = [];
  let acceptable = [pinnedSubject];
  for (let i = 0; i < WIDE_N; i++) {
    const hint = STRATEGY_HINTS[i % STRATEGY_HINTS.length];
    console.log(`  [wide ${i + 1}/${WIDE_N}] strategy: ${hint.split(":")[0]}`);
    try {
      const content = [
        ...masterBlocks,
        { type: "text", text: "Now the subject — the user's uploaded image:" },
        imageBlock,
        {
          type: "text",
          text:
            `You are a master GPS artist working in Manhattan. Compose a route depicting this subject.\n\n` +
            `THE SUBJECT IS: ${pinnedSubject}. Do NOT reinterpret it as anything else — every judge will grade against exactly this.\n\n` +
            `STRATEGY FOR THIS ATTEMPT — ${hint}\n\n${DSL_RULES}\n\n${DESIGN_JSON}`,
        },
      ];
      const design = cleanDesign(parseJsonLoose(await callClaude(DESIGNER_MODEL, content, 32000, true)), subjectLabel);
      if (!design) {
        console.log("    unusable design");
        continue;
      }
      const routed = routeWaypoints(net, design.waypoints);
      if (routed.coords.length < 20 || routed.unresolved.length > design.waypoints.length * 0.15) {
        console.log(`    routing failed (${routed.unresolved.length} unresolved)`);
        continue;
      }
      if (acceptable.length === 1 && design.acceptableGuesses.length) {
        acceptable = [pinnedSubject, ...design.acceptableGuesses];
      }
      const mapFile = path.join(outDir, `wide-${i + 1}.png`);
      await renderStrava(routed.coords, mapFile);
      const ev = await evaluate(mapFile, pinnedSubject, acceptable);
      console.log(
        `    "${design.label}" ${routed.km.toFixed(1)} km → informed ${ev.informedMean.toFixed(1)} blind "${ev.blindGuess}"(${ev.blindConf}) score ${ev.score.toFixed(1)}`,
      );
      candidates.push({ design, routed, ev, mapFile, strategy: hint.split(":")[0] });
      await fs.writeFile(
        path.join(outDir, `wide-${i + 1}.json`),
        JSON.stringify({ strategy: hint, design, km: routed.km, ev }, null, 2),
      );
    } catch (err) {
      console.log(`    wide attempt failed: ${err.message}`);
    }
  }
  candidates.sort((a, b) => b.ev.score - a.ev.score);
  return { candidates, acceptable };
}

async function surgicalRefine(net, imageBlock, bone, acceptable, outDir, boneIdx, pinnedSubject) {
  let cur = {
    waypoints: bone.design.waypoints,
    routed: bone.routed,
    ev: bone.ev,
    mapFile: bone.mapFile,
  };
  let best = cur;
  for (let it = 1; it <= EDIT_ROUNDS; it++) {
    try {
      const crop = await cropToRoute(cur.mapFile);
      const numbered = cur.waypoints.map((w, i) => `${i}: ${w[0]} & ${w[1]}`).join("\n");
      const content = [
        { type: "text", text: "The subject being drawn (original image):" },
        imageBlock,
        { type: "text", text: "Current route on the map:" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: crop.toString("base64") } },
        {
          type: "text",
          text:
            `You are surgically improving this GPS-art route. THE SUBJECT IS: ${pinnedSubject} — do not reinterpret it. Critic verdict: ${cur.ev.informedMean.toFixed(1)}/10 — "${cur.ev.informedNotes[0]}". A stranger guessed "${cur.ev.blindGuess}".\n\n` +
            `Current waypoints (numbered):\n${numbered}\n\n${DSL_RULES}\n\n` +
            `Make AT MOST 5 SMALL EDITS to fix the critic's specific complaint — do NOT redesign. Ops:\n` +
            `{"op":"replace","from":N,"to":M,"waypoints":[["street","street"],...]} (replace range N..M inclusive)\n` +
            `{"op":"insert","after":N,"waypoints":[...]}\n` +
            `{"op":"delete","from":N,"to":M}\n` +
            `Return ONLY JSON: {"rationale":"one sentence","ops":[...]} — or {"ops":[]} if the route cannot be improved.`,
        },
      ];
      const resp = parseJsonLoose(await callClaude(DESIGNER_MODEL, content, 16000, true));
      const ops = Array.isArray(resp?.ops) ? resp.ops.slice(0, 5) : [];
      if (!ops.length) {
        console.log(`    [bone ${boneIdx} edit ${it}] designer says done`);
        break;
      }
      const newWps = applyEditOps(cur.waypoints, ops);
      if (!newWps) {
        console.log(`    [bone ${boneIdx} edit ${it}] ops invalid, skipping`);
        continue;
      }
      const routed = routeWaypoints(net, newWps);
      if (routed.coords.length < 20) {
        console.log(`    [bone ${boneIdx} edit ${it}] edit broke routing, reverting`);
        continue;
      }
      const mapFile = path.join(outDir, `bone${boneIdx}-edit${it}.png`);
      await renderStrava(routed.coords, mapFile);
      const ev = await evaluate(mapFile, pinnedSubject, acceptable);
      const better = ev.score > cur.ev.score + 0.05;
      console.log(
        `    [bone ${boneIdx} edit ${it}] ${resp.rationale ?? ""} → informed ${ev.informedMean.toFixed(1)} score ${ev.score.toFixed(1)} ${better ? "ACCEPT" : "revert"}`,
      );
      if (better) {
        cur = { waypoints: newWps, routed, ev, mapFile };
        if (ev.score > best.ev.score) best = cur;
      }
    } catch (err) {
      console.log(`    [bone ${boneIdx} edit ${it}] failed: ${err.message}`);
    }
  }
  return best;
}

// ---------------------------------------------------------------- final gate
/**
 * "As good as the samples or Ralph never sees it."
 * Test 1: full blind panel — 2 of 3 strangers must name the pinned subject.
 * Test 2: portfolio test — candidate sits next to the three master pieces;
 *         2 of 2 judges must say it belongs at that level.
 */
async function finalGate(mapFile, pinnedSubject, acceptable) {
  const crop = await cropToRoute(mapFile);
  let hits = 0;
  const guesses = [];
  for (let i = 0; i < 3; i++) {
    const t = await judgeImage(crop, BLIND_PROMPT);
    const guess = t.match(/GUESS:\s*(.+?)(?:CONFIDENCE|$)/i)?.[1]?.trim() ?? "";
    guesses.push(guess);
    if (guessMatches(guess, acceptable)) hits++;
  }
  if (hits < 2) return { pass: false, reason: `blind panel ${hits}/3 (${guesses.join(" / ")})` };

  // portfolio composite: A=lion B=tiger C=love D=candidate
  const cell = 700;
  const parts = [];
  const files = ["lion.webp", "TIGER.webp", "LOVE.png"];
  const labels = ["A", "B", "C", "D"];
  for (let i = 0; i < 4; i++) {
    const src = i < 3
      ? await sharp(files[i]).resize(cell, cell, { fit: "contain", background: "#fff" }).png().toBuffer()
      : await sharp(await cropToRoute(mapFile)).resize(cell, cell, { fit: "contain", background: "#fff" }).png().toBuffer();
    parts.push({ input: src, left: (i % 2) * cell, top: Math.floor(i / 2) * (cell + 40) + 40 });
    parts.push({
      input: Buffer.from(`<svg width="${cell}" height="40"><text x="10" y="30" font-family="Arial" font-size="28" font-weight="700" fill="#111">${labels[i]}</text></svg>`),
      left: (i % 2) * cell,
      top: Math.floor(i / 2) * (cell + 40),
    });
  }
  const composite = await sharp({ create: { width: cell * 2, height: (cell + 40) * 2, channels: 3, background: "#ffffff" } })
    .composite(parts).jpeg({ quality: 85 }).toBuffer();
  let yes = 0;
  const verdicts = [];
  for (let i = 0; i < 2; i++) {
    const t = await callClaude(
      JUDGE_MODEL,
      [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: composite.toString("base64") } },
        {
          type: "text",
          text:
            "A, B and C are celebrated GPS-art masterpieces. D is a new route submitted for the same portfolio. " +
            "Judge D purely on craft: clean readable silhouette, confident line, recognizable subject at a glance. " +
            "Reply exactly:\nBELONGS: <YES or NO — would D fit in this portfolio without embarrassing it?>\nWHY: <one short sentence>",
        },
      ],
      1024,
    );
    const belongs = /BELONGS:\s*YES/i.test(t);
    verdicts.push(t.replace(/\s+/g, " ").slice(0, 140));
    if (belongs) yes++;
  }
  if (yes < 2) return { pass: false, reason: `portfolio test ${yes}/2 (${verdicts.join(" | ")})` };
  return { pass: true, reason: `blind ${hits}/3 + portfolio ${yes}/2` };
}

// ---------------------------------------------------------------- mapbox verify
async function verifyWithMapbox(coords) {
  const token = await readEnv("NEXT_PUBLIC_MAPBOX_TOKEN");
  const sampled = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += haversine(coords[i - 1], coords[i]);
    if (acc >= 200 || i === coords.length - 1) {
      sampled.push(coords[i]);
      acc = 0;
    }
  }
  let mapboxM = 0;
  let failures = 0;
  const CHUNK = 24;
  for (let start = 0; start + 1 < sampled.length; start += CHUNK) {
    const slice = sampled.slice(start, start + CHUNK + 1);
    const cs = slice.map(([la, ln]) => `${ln.toFixed(6)},${la.toFixed(6)}`).join(";");
    try {
      const res = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/walking/${cs}?geometries=geojson&overview=false&access_token=${token}`,
      );
      if (!res.ok) {
        failures++;
        continue;
      }
      const json = await res.json();
      if (json.code !== "Ok" || !json.routes?.[0]) {
        failures++;
        continue;
      }
      mapboxM += json.routes[0].distance;
    } catch {
      failures++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { mapboxKm: mapboxM / 1000, failures };
}

// ---------------------------------------------------------------- main
async function main() {
  const t0 = Date.now();
  anthropicKey = await readEnv("ANTHROPIC_API_KEY");
  await fs.mkdir(path.join(ROOT, "passing"), { recursive: true });
  console.log("loading walk network…");
  const net = await loadNetwork();
  const masterBlocks = await loadMasterBlocks();
  const passing = [];
  const report = [];

  for (const { file: subjectFile, subject: userSubject } of SUBJECTS) {
    const label = path.basename(subjectFile).replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const outDir = path.join(ROOT, label);
    await fs.mkdir(outDir, { recursive: true });
    console.log(`\n████ SUBJECT: ${subjectFile} ████`);
    try {
      const imgBuf = await sharp(subjectFile).resize({ width: 1024, withoutEnlargement: true })
        .jpeg({ quality: 90 }).toBuffer();
      const imageBlock = {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: imgBuf.toString("base64") },
      };

      // Pin the subject ONCE per run — from the USER when provided (a real
      // user names their own logo at upload), else from a dedicated look.
      // Every judge call grades against THIS, never against the designer's
      // possibly-drifted label. (One run drifted to "fist" and the critic
      // scored it 6.5 as a fist; auto-pin also misread the gas logo.)
      const pinned = userSubject ?? (await callClaude(
        JUDGE_MODEL,
        [
          imageBlock,
          {
            type: "text",
            text:
              "Name what this image depicts in 2-4 words (if it is a screenshot of a GPS-art route, name what the ROUTE was meant to depict). Reply with ONLY the name, nothing else.",
          },
        ],
        256,
      )).trim().replace(/^["']|["'.]$/g, "");
      console.log(`  pinned subject: "${pinned}"${userSubject ? " (user-provided)" : " (auto)"}`);

      console.log(`\n▶ Phase A: wide search (${WIDE_N} strategies)`);
      const { candidates, acceptable } = await wideSearch(net, imageBlock, masterBlocks, label, outDir, pinned);
      if (!candidates.length) {
        report.push({ subject: subjectFile, result: "no routable designs" });
        continue;
      }
      const bones = candidates.slice(0, BONES);
      console.log(`\n▶ Phase B: surgical refinement of top ${bones.length} bones`);
      let subjectBest = null;
      for (let b = 0; b < bones.length; b++) {
        console.log(`  bone ${b + 1}: "${bones[b].design.label}" via ${bones[b].strategy} (score ${bones[b].ev.score.toFixed(1)})`);
        const refined = await surgicalRefine(net, imageBlock, bones[b], acceptable, outDir, b + 1, pinned);
        if (!subjectBest || refined.ev.score > subjectBest.ev.score) {
          subjectBest = { ...refined, label: bones[b].design.label };
        }
      }

      const entry = {
        subject: subjectFile,
        label: subjectBest.label,
        informedMean: subjectBest.ev.informedMean,
        blindGuess: subjectBest.ev.blindGuess,
        blindHit: subjectBest.ev.blindHit,
        score: subjectBest.ev.score,
        km: subjectBest.routed.km,
        notes: subjectBest.ev.informedNotes,
      };
      console.log(`\n  SUBJECT BEST: informed ${entry.informedMean.toFixed(1)}/10, blind "${entry.blindGuess}", ${entry.km.toFixed(1)} km`);

      let gate = { pass: false, reason: `informed ${entry.informedMean.toFixed(1)} below ${PASS_SCORE}` };
      if (entry.informedMean >= PASS_SCORE) {
        gate = await finalGate(subjectBest.mapFile, pinned, acceptable);
      }
      entry.gate = gate;
      console.log(`  FINAL GATE: ${gate.pass ? "PASS" : "fail"} — ${gate.reason}`);
      if (gate.pass) {
        const v = await verifyWithMapbox(subjectBest.routed.coords);
        entry.mapbox = v;
        const dst = path.join(ROOT, "passing", `${label}.png`);
        await fs.copyFile(subjectBest.mapFile, dst);
        const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso overnight" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${entry.label}</name><trkseg>
${subjectBest.routed.coords.map(([la, ln]) => `    <trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
        await fs.writeFile(path.join(ROOT, "passing", `${label}.gpx`), gpx, "utf8");
        passing.push(entry);
        console.log(`  ★★★ PASSES THE GATE (>= ${PASS_SCORE}) — saved to OVERNIGHT/passing/`);
      } else {
        console.log(`  below the gate (< ${PASS_SCORE}) — not shown`);
      }
      report.push(entry);
      await fs.writeFile(path.join(ROOT, "report.json"), JSON.stringify(report, null, 2));
    } catch (err) {
      console.log(`  SUBJECT FAILED: ${err.message}`);
      report.push({ subject: subjectFile, result: `error: ${err.message}` });
      await fs.writeFile(path.join(ROOT, "report.json"), JSON.stringify(report, null, 2));
    }
  }

  console.log(`\n════ OVERNIGHT DONE in ${((Date.now() - t0) / 1000 / 3600).toFixed(1)} h ════`);
  console.log(`${passing.length}/${SUBJECTS.length} subjects passed the >= ${PASS_SCORE} gate`);
  for (const p of passing) console.log(`  ★ ${p.subject}: "${p.label}" informed ${p.informedMean.toFixed(1)}, ${p.km.toFixed(1)} km`);
  if (!passing.length) {
    console.log("empty passing folder — that is the honest result; the ceiling is still below the gate");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
