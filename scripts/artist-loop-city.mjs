/**
 * Artist-loop CITY — v2 of the automated GPS artist. Composes IN STREET
 * LANGUAGE instead of translating a picture onto streets.
 *
 * v1 (artist-loop-poc.ts, committed at bc96b3e as the dial-back) drew in
 * abstract 0..1 space, then placed + quantized + compiled — each step bled
 * fidelity. v2 does what the hand-authored winners (curated-manhattan-
 * runs.mjs, gas-interp-v4) and the master references (TIGER/lion/LOVE) do:
 * the design IS a list of real street intersections, routed corridor-by-
 * corridor over the full OSM walk network — downtown irregular streets
 * included, because the masters use crooked streets as texture.
 *
 * Run: node scripts/artist-loop-city.mjs <image> [--rounds=5]
 *        [--designer=claude-fable-5] [--judge=claude-opus-4-8] [--skip-verify]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { loadNetwork, haversine } from "./gas-spike-lattice.mjs";
const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");

// ---------------------------------------------------------------------------
// CLI + env
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const imageFile = args.find((a) => !a.startsWith("--"));
if (!imageFile) {
  console.error("usage: node scripts/artist-loop-city.mjs <image> [--rounds=5]");
  process.exit(1);
}
const flag = (name, dflt) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;
const MAX_ROUNDS = Number(flag("rounds", "5"));
const DESIGNER_MODEL = flag("designer", "claude-fable-5");
const JUDGE_MODEL = flag("judge", "claude-opus-4-8");
const SKIP_VERIFY = args.includes("--skip-verify");
const baseName = path.basename(imageFile).replace(/\.[a-z0-9]+$/i, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-");
const OUT = path.join(process.cwd(), "tmp-artist-city", baseName);

async function readEnv(name) {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) throw new Error(`${name} not found in .env.local`);
  return m[1].trim();
}

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------
let anthropicKey = "";
async function callClaude(model, content, maxTokens, thinking = false) {
  let useThinking = thinking;
  for (let attempt = 0; attempt < 5; attempt++) {
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
      const wait = 5000 * (attempt + 1);
      console.log(`  api network error (${err.message}), retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 400 && useThinking) {
      useThinking = false;
      continue;
    }
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const wait = 5000 * (attempt + 1);
      console.log(`  api ${res.status}, retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const text = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join(" ")
      .trim();
    if (text) return text;
    throw new Error(`empty response (stop=${json.stop_reason})`);
  }
  throw new Error("Anthropic API kept failing after retries");
}

function parseJsonLoose(text) {
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  if (start < 0) throw new Error("no JSON object in response");
  const end = stripped.lastIndexOf("}");
  if (end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch {
      /* truncation repair below */
    }
  }
  let body = stripped.slice(start);
  const lastObj = body.lastIndexOf("]");
  if (lastObj < 0) throw new Error("unrepairable JSON");
  body = body.slice(0, lastObj + 1);
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

// ---------------------------------------------------------------------------
// Designer prompt: the street-name DSL + the masters' techniques
// ---------------------------------------------------------------------------
const DSL_PROMPT = `You are a master GPS artist working in Manhattan. You do not draw pictures — you COMPOSE ROUTES directly out of named streets, exactly like the artists behind the greatest Strava art.

THE MEDIUM: your design is ONE ordered list of real Manhattan intersections, each written as a pair of street names: ["Orchard Street", "Broome Street"]. Consecutive waypoints are connected along real streets (if they share a street name, the leg runs along that street; otherwise the shortest walking path is used — keep those rare and short). The runner runs the list in order. Retracing a street you already drew is allowed and is the standard way to do interior details (draw the detail, retrace back). The route may end anywhere.

TECHNIQUES OF THE MASTERS (studied from their actual work, shown in the images above):
- COMPOSE WITH NEIGHBORHOOD CHARACTER: boxy parts (bodies, buildings, shells) live on the regular grids (Chelsea/Midtown: numbered streets x numbered avenues; East Village: Avenues A-D x East 2nd-14th). Organic wobble (fur, flames, tails, spirals) lives on the irregular downtown fabric (West Village, Chinatown, Lower East Side, Financial District) — crooked streets ARE the texture.
- THE LES FINE GRID (Orchard/Ludlow/Essex/Norfolk/Suffolk/Clinton x Hester/Grand/Broome/Delancey/Rivington/Stanton) is the finest resolution on the island — use it for faces, feathers, small features.
- TEXTURE = PARALLEL STREETS: stripes, laces, fur strokes are drawn as runs along adjacent parallel streets (out along one, back along the next) — the street fabric is your crosshatching. The tiger's stripes and the sneaker's lace comb work exactly this way.
- SCALE IS COURAGE: the masters' pieces span 15-25 km of running across half the island. Identity features get whole neighborhoods, never single blocks.
- CONTAINER + CONTENT: a giant outline (a heart spanning the island's lower half) can hold content inside it (the word LOVE flowing through SoHo). Consider two-level compositions when the subject allows.
- THE DOG ATTRACTOR: any lumpy mass with 2-4 short strokes poking down reads as "a dog" to strangers. Check your silhouette against this before submitting.
- SILHOUETTE FIRST: a stranger must name the subject from the outline alone. Pick the 3-5 identity features and exaggerate them; drop everything else.

CONSTRAINTS:
- Stay on Manhattan island (no bridges in this version).
- 40-160 waypoints. Route length 8-26 km.
- Long edges follow single streets/avenues. Vertical strokes = avenues or north-south streets; horizontal strokes = cross streets.
- Use exact official street names: "West 23rd Street", "East 4th Street", "10th Avenue", "Avenue B", "Orchard Street", "Bowery", "Broadway". No abbreviations.

Return ONLY JSON:
{
  "label": "short subject name",
  "concept": "2-3 sentences: composition plan, which neighborhoods play which body parts, where the texture goes",
  "identityFeatures": ["..."],
  "acceptableGuesses": ["4-8 words/phrases a stranger might say that should count as recognition"],
  "waypoints": [["10th Avenue","West 26th Street"], ["9th Avenue","West 26th Street"], ...]
}
No markdown, no extra keys.`;

function cleanDesign(raw) {
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
    label: typeof j.label === "string" ? j.label : baseName,
    concept: typeof j.concept === "string" ? j.concept : "",
    identityFeatures: Array.isArray(j.identityFeatures)
      ? j.identityFeatures.filter((f) => typeof f === "string")
      : [],
    acceptableGuesses: Array.isArray(j.acceptableGuesses)
      ? j.acceptableGuesses.filter((g) => typeof g === "string")
      : [],
    waypoints: wps,
  };
}

// ---------------------------------------------------------------------------
// Routing over the real walk network (curated-runs machinery)
// ---------------------------------------------------------------------------
function routeWaypoints(net, waypoints) {
  const { nodes, intersectionOf, corridorPath, walkPath } = net;
  const unresolved = [];
  const ids = waypoints.map(([a, b]) => {
    const id = intersectionOf(a, b) ?? intersectionOf(b, a);
    if (!id) unresolved.push(`${a} & ${b}`);
    return id;
  });
  const coords = [];
  const legs = [];
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
    const shared =
      a0 === a1 || a0 === b1 ? a0 : b0 === a1 || b0 === b1 ? b0 : null;
    let p = null;
    let via = "corridor";
    if (shared) p = corridorPath(shared, from, to);
    const chord = haversine(nodes.get(from), nodes.get(to));
    if (!p || pathLen(p) > chord * 1.3) {
      const w = walkPath(from, to);
      if (w && (!p || pathLen(w) < pathLen(p))) {
        p = w;
        via = "walk";
      }
    }
    if (!p) {
      problems.push(`unroutable: ${a0} & ${b0} -> ${a1} & ${b1}`);
      continue;
    }
    const m = pathLen(p);
    const ratio = m / Math.max(chord, 1);
    legs.push({
      leg: `${a0}&${b0} -> ${a1}&${b1}`,
      via,
      meters: Math.round(m),
      chord: Math.round(chord),
      detourRatio: Number(ratio.toFixed(2)),
    });
    if (ratio > 1.6 && m - chord > 150) {
      problems.push(`big detour (${ratio.toFixed(1)}x): ${a0} & ${b0} -> ${a1} & ${b1}`);
    }
    const pts = p.map((id) => nodes.get(id));
    coords.push(...(coords.length ? pts.slice(1) : pts));
  }
  let km = 0;
  for (let i = 1; i < coords.length; i++) km += haversine(coords[i - 1], coords[i]) / 1000;
  return { coords, km, legs, problems, unresolved };
}

// ---------------------------------------------------------------------------
// Strava-style render + judges
// ---------------------------------------------------------------------------
const TILE = 256;
const lonToX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

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
      const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
        headers: { "User-Agent": "pace-casso route preview (dev)" },
      });
      if (!res.ok) continue;
      tiles.push({
        input: Buffer.from(await res.arrayBuffer()),
        left: Math.round(tx * TILE - vx),
        top: Math.round(ty * TILE - vy),
      });
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
  "What were they trying to draw? Reply exactly:\n" +
  'GUESS: <1-3 words, or "nothing recognizable">\n' +
  "CONFIDENCE: <0-10, how obvious it is at a glance>";

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

async function blindJudge(file, acceptable) {
  const buf = await cropToRoute(file);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const text = await callClaude(
      JUDGE_MODEL,
      [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
        { type: "text", text: BLIND_PROMPT },
      ],
      1024,
    );
    const guess = text.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE|$)/i)?.[1]?.trim() ?? text.slice(0, 60);
    const confidence = Number(text.match(/CONFIDENCE:\s*(\d+(?:\.\d+)?)/i)?.[1] ?? 0);
    samples.push({ guess, confidence });
  }
  const recognizedCount = samples.filter((s) => guessMatches(s.guess, acceptable)).length;
  const confs = samples.map((s) => s.confidence).sort((a, b) => a - b);
  return { samples, recognizedCount, medianConfidence: confs[1] ?? 0 };
}

async function informedJudge(file, subject) {
  const buf = await cropToRoute(file);
  const prompt =
    `This image shows a GPS running route drawn on a city map as Strava art. The runner intended it to depict ${subject}. ` +
    `As a harsh art critic who has seen the best GPS art, score how well this route actually reads as ${subject} at a glance — clean silhouette, key features present, minimal noise. ` +
    `Reply exactly:\nSCORE: <0-10>\nWHY: <one short sentence>`;
  const scores = [];
  const notes = [];
  for (let i = 0; i < 2; i++) {
    const text = await callClaude(
      JUDGE_MODEL,
      [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
        { type: "text", text: prompt },
      ],
      1024,
    );
    scores.push(Number(text.match(/SCORE:\s*(\d+(?:\.\d+)?)/i)?.[1] ?? 0));
    notes.push(text.match(/WHY:\s*(.+)/i)?.[1]?.trim() ?? "");
  }
  return { scores, notes };
}

// ---------------------------------------------------------------------------
// Few-shot: master references + a real winning waypoint program
// ---------------------------------------------------------------------------
const MASTER_EXEMPLARS = [
  {
    file: "lion.webp",
    note: "Master piece 1 — a huge boxy creature composed on the Midtown grid, limbs and ears as clean rectangular street loops; whole-neighborhood scale",
  },
  {
    file: "TIGER.webp",
    note: "Master piece 2 — a tiger whose body lives on the irregular downtown fabric; the crooked streets ARE the fur/stripe texture",
  },
  {
    file: "LOVE.png",
    note: "Master piece 3 — container + content: a giant heart outline spanning the island's lower half with the word LOVE flowing inside it",
  },
];

const TURTLE_PROGRAM_SNIPPET = `A real winning waypoint program (the curated turtle, Chelsea grid — this exact technique produced verified, recognizable routes):
["10th Ave","W 26th St"] -> ["10th Ave","W 28th St"] (front-left leg up) -> ["9th Ave","W 28th St"] -> ["9th Ave","W 26th St"] (leg down) -> ["8th Ave","W 26th St"] (shell top) ... legs as one-block rectangles hanging off the shell, head as a box sticking out east, tail west. Boxy parts = grid rectangles; every waypoint a real intersection.`;

async function loadMasterBlocks() {
  const blocks = [
    {
      type: "text",
      text:
        "STUDY THE MASTERS. The images below are real, human-made GPS-art masterpieces (and how they work):\n" +
        MASTER_EXEMPLARS.map((e, i) => `${i + 1}. ${e.note}`).join("\n") +
        "\n\n" + TURTLE_PROGRAM_SNIPPET,
    },
  ];
  for (const e of MASTER_EXEMPLARS) {
    try {
      const buf = await sharp(path.join(process.cwd(), e.file))
        .resize({ width: 900, withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 80 })
        .toBuffer();
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") },
      });
    } catch {
      console.log(`  (exemplar ${e.file} unavailable, skipping)`);
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Best-across-everything archive
// ---------------------------------------------------------------------------
async function updateBestArchive(rec, coords, renderFile) {
  const bestDir = path.join(OUT, "BEST");
  await fs.mkdir(bestDir, { recursive: true });
  let prev = null;
  try {
    prev = JSON.parse(await fs.readFile(path.join(bestDir, "best.json"), "utf8"));
  } catch {
    /* first run */
  }
  if (prev && prev.score >= rec.score) return false;
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso artist-loop-city" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${rec.label}</name><trkseg>
${coords.map(([la, ln]) => `    <trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  await fs.writeFile(path.join(bestDir, "best.gpx"), gpx, "utf8");
  await fs.copyFile(renderFile, path.join(bestDir, "best-map.png"));
  await fs.writeFile(path.join(bestDir, "best.json"), JSON.stringify(rec, null, 2));
  return true;
}

// ---------------------------------------------------------------------------
// Mapbox verify
// ---------------------------------------------------------------------------
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
  let chainKm = 0;
  for (let i = 1; i < coords.length; i++) chainKm += haversine(coords[i - 1], coords[i]) / 1000;
  let mapboxM = 0;
  let failures = 0;
  const CHUNK = 24;
  for (let start = 0; start + 1 < sampled.length; start += CHUNK) {
    const slice = sampled.slice(start, start + CHUNK + 1);
    const cs = slice.map(([la, ln]) => `${ln.toFixed(6)},${la.toFixed(6)}`).join(";");
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
    const mLegs = json.routes[0].legs;
    for (let j = 0; j + 1 < slice.length; j++) {
      const want = haversine(slice[j], slice[j + 1]);
      const got = mLegs[j]?.distance ?? Infinity;
      if (got > want * 1.4 && got - want > 120) failures++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { mapboxKm: mapboxM / 1000, chainKm, failures };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  anthropicKey = await readEnv("ANTHROPIC_API_KEY");
  await fs.mkdir(OUT, { recursive: true });

  console.log("loading walk network (tmp-gas-spike/osm-walk-network.json)…");
  const net = await loadNetwork();

  const imgBuf = await sharp(imageFile).resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 90 }).toBuffer();
  const imageBlock = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: imgBuf.toString("base64") },
  };
  const masterBlocks = await loadMasterBlocks();

  let acceptable = [];
  let critique = [];
  const historyLines = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n━━━ ROUND ${round}/${MAX_ROUNDS} ━━━`);

    let design = null;
    let routed = null;
    let repair = [];
    for (let att = 0; att < 3; att++) {
      const content = [
        ...masterBlocks,
        { type: "text", text: "Now the subject — the user's uploaded image:" },
        imageBlock,
        ...critique,
        ...repair,
        { type: "text", text: DSL_PROMPT },
      ];
      let parsed = null;
      try {
        parsed = cleanDesign(parseJsonLoose(await callClaude(DESIGNER_MODEL, content, 32000, true)));
      } catch (err) {
        console.log(`  designer JSON error (${err.message}), retrying`);
        continue;
      }
      if (!parsed) {
        console.log("  designer returned no usable waypoints, retrying");
        continue;
      }
      const r = routeWaypoints(net, parsed.waypoints);
      console.log(
        `  "${parsed.label}": ${parsed.waypoints.length} waypoints → ${r.km.toFixed(1)} km, ` +
          `${r.unresolved.length} unresolved, ${r.problems.length} problem legs`,
      );
      if (r.unresolved.length > Math.max(2, parsed.waypoints.length * 0.1) || r.coords.length < 20) {
        repair = [
          {
            type: "text",
            text:
              `Your waypoint list had street-name problems. These intersections could not be found (wrong name or they don't cross): ` +
              r.unresolved.slice(0, 20).join("; ") +
              (r.problems.length ? `. Also problematic legs: ${r.problems.slice(0, 8).join("; ")}` : "") +
              ". Fix the names (exact official names, e.g. 'West 26th Street', 'Avenue B', 'Orchard Street') or reroute those parts. Return the corrected FULL JSON.",
          },
        ];
        console.log("  too many unresolved — sending repair feedback");
        continue;
      }
      design = parsed;
      routed = r;
      break;
    }
    if (!design || !routed) {
      console.log("  round failed to produce a routable design");
      continue;
    }
    if (!acceptable.length) {
      acceptable = design.acceptableGuesses.length ? design.acceptableGuesses : [design.label];
      console.log(`  acceptable answers (frozen): [${acceptable.join(", ")}]`);
    }
    console.log(`  concept: ${design.concept}`);

    const mapFile = path.join(OUT, `round-${round}-map.png`);
    await renderStrava(routed.coords, mapFile);
    await fs.writeFile(
      path.join(OUT, `round-${round}-design.json`),
      JSON.stringify({ design, km: routed.km, legs: routed.legs.length, problems: routed.problems, unresolved: routed.unresolved }, null, 2),
    );

    const blind = await blindJudge(mapFile, acceptable);
    console.log(
      `  BLIND: ${blind.samples.map((s) => `"${s.guess}"(${s.confidence})`).join("  ")} → ${blind.recognizedCount}/3 @ ${blind.medianConfidence}`,
    );
    const informed = await informedJudge(mapFile, design.label);
    console.log(`  INFORMED: ${informed.scores.join(", ")} — ${informed.notes[0]}`);

    const score =
      blind.recognizedCount * 10 +
      blind.medianConfidence +
      (informed.scores.reduce((s, v) => s + v, 0) / Math.max(1, informed.scores.length)) * 2;
    const improved = await updateBestArchive(
      {
        score,
        blind,
        informed: informed.scores,
        km: routed.km,
        label: design.label,
        round,
        when: new Date().toISOString(),
      },
      routed.coords,
      mapFile,
    );
    if (improved) console.log(`  ★ new best (score ${score.toFixed(1)}) archived to ${path.join(OUT, "BEST")}`);

    if (blind.recognizedCount >= 2 && blind.medianConfidence >= 6) {
      console.log("  ✔ blind-recognized with confidence — stopping early");
      break;
    }

    historyLines.push(
      `Round ${round} ("${design.label}", ${routed.km.toFixed(1)} km, concept: ${design.concept.slice(0, 120)}): strangers saw ${[...new Set(blind.samples.map((s) => s.guess))].join(" / ")}; informed critic ${informed.scores.join("/")}: ${informed.notes[0]}`,
    );
    const mapCrop = await cropToRoute(mapFile);
    critique = [
      {
        type: "text",
        text:
          `HISTORY — do not repeat failure modes:\n${historyLines.join("\n")}\n\n` +
          `The image below is your last route as strangers saw it. They guessed: ${blind.samples.map((s) => `"${s.guess}" (${s.confidence}/10)`).join(", ")}. ` +
          `An informed critic (told the subject) scored it ${informed.scores.join(" and ")}/10: "${informed.notes.join('" / "')}". ` +
          (routed.problems.length ? `Routing problems to avoid: ${routed.problems.slice(0, 6).join("; ")}. ` : "") +
          "Compose a STRUCTURALLY IMPROVED design: fix what the critic named, exaggerate the identity features strangers missed, and keep what worked. Same JSON contract.",
      },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: mapCrop.toString("base64") } },
    ];
  }

  const bestDir = path.join(OUT, "BEST");
  let best = null;
  try {
    best = JSON.parse(await fs.readFile(path.join(bestDir, "best.json"), "utf8"));
  } catch {
    throw new Error("no successful round produced a route");
  }
  console.log(`\n━━━ BEST: "${best.label}" round ${best.round}, score ${best.score.toFixed(1)}, ${best.km.toFixed(1)} km ━━━`);

  if (!SKIP_VERIFY) {
    const gpx = await fs.readFile(path.join(bestDir, "best.gpx"), "utf8");
    const coords = [...gpx.matchAll(/lat="([\d.-]+)" lon="([\d.-]+)"/g)].map(
      (m) => [Number(m[1]), Number(m[2])],
    );
    console.log("verifying best route against live Mapbox walking directions…");
    const v = await verifyWithMapbox(coords);
    console.log(
      `  mapbox ${v.mapboxKm.toFixed(1)} km vs chain ${v.chainKm.toFixed(1)} km, ${v.failures} problem legs — ` +
        (v.failures === 0 ? "RUNNABLE" : "CHECK PROBLEM LEGS"),
    );
    await fs.writeFile(path.join(bestDir, "verify.json"), JSON.stringify(v, null, 2));
  }
  console.log(`\ndone in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min — ${bestDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
