/**
 * MAP ARTIST v2 (Sep 27 decisive test) — the Sep 16 map agent, which is the only
 * automatic path that drew a non-trivial logo Ralph passed (bear, Namebase "n"),
 * widened: the whole 500k-node NYC graph (Manhattan, Brooklyn, Queens incl. the
 * irregular neighbourhoods where curves and small details exist), a human 9/10
 * sample shown as the quality bar, blind fresh-eyes naming of every draft, a
 * 40 km limit, and a spend ledger with a hard total cap (Ralph: $50).
 *
 *   npx tsx --env-file=.env.local scripts/map-artist2.ts --file=gas.png --name=gas
 *       [--label="..."] [--out=tmp-artist2] [--capusd=5] [--turns=30] [--total=50]
 *
 * --- original header ---
 * MAP AGENT — the AI draws GPS art the way a human artist does (Sep 16 test).
 *
 * Every earlier engine had the model draw first and handed the drawing to a
 * router. Human GPS artists work the other way round: look at the real map,
 * find streets that already resemble parts of the subject, place waypoints,
 * look at the resulting trace, fix what doesn't read, repeat. This rig gives
 * claude-opus-5 exactly those instruments:
 *   view_map   — a street map of any part of Manhattan with a metre grid
 *   set_route  — waypoints -> walking route on the real street graph; returns
 *                the trace as Strava shows it (line on white, north-up) and
 *                the same route on the map, plus km / retrace stats
 *   submit     — hand in the current route
 * Hard spend cap per logo; nothing touches the site.
 *
 * Usage: npx tsx --env-file=.env.local scripts/map-agent.ts [--stage=fetch|run|one]
 *        [--n=3] [--seed=23] [--out=tmp-agent] [--capusd=5] [--turns=30] [--name=..]
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import type { LatLng } from "../lib/streetGraphTrace";
import { meters, nearestNode, walk, type PainterGraph } from "../lib/strokePainter";
import { sharp, writeGpx } from "./finisher-shared";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const STAGE = opt("stage", "run");
const OUT = opt("out", "tmp-artist2");
/** Ralph's total budget for the whole test, across every run (ledger.jsonl in OUT) */
const TOTAL_USD = Number(opt("total", "50"));
const MAX_KM = 40;
const CAP_USD = Number(opt("capusd", "5"));
const MAX_TURNS = Number(opt("turns", "30"));
const MODEL = opt("model", "claude-opus-5");
const EFFORT = opt("effort", "medium") as "low" | "medium" | "high" | "xhigh" | "max";
/** cheap mode: no map image alongside each routed result (view_map still available), smaller maps */
const CHEAP = opt("cheap", "1") === "1";
// $ per token: input, cache write (1.25x), cache read (0.1x), output
const P_IN = 5e-6, P_CW = 6.25e-6, P_CR = 0.5e-6, P_OUT = 25e-6;

type Item = { name: string; kind: "brand" | "emoji"; file: string; label: string };

// ---------------------------------------------------------------------------
// local metre frame: origin at Times Square, x east, y north
// ---------------------------------------------------------------------------
const O: LatLng = [40.758, -73.9855];
const M_LAT = 111320, M_LNG = 111320 * Math.cos((O[0] * Math.PI) / 180);
const toLL = (x: number, y: number): LatLng => [O[0] + y / M_LAT, O[1] + x / M_LNG];
const toXY = (p: LatLng): [number, number] => [(p[1] - O[1]) * M_LNG, (p[0] - O[0]) * M_LAT];

// ---------------------------------------------------------------------------
// map rendering (ArcGIS World Street Map tiles, cached)
// ---------------------------------------------------------------------------
const TILE = 256;
const lonToPx = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToPx = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
const tileCache = new Map<string, Buffer | null>();
async function tile(z: number, x: number, y: number): Promise<Buffer | null> {
  const k = `${z}/${y}/${x}`;
  if (tileCache.has(k)) return tileCache.get(k)!;
  let buf: Buffer | null = null;
  try {
    const res = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`, { headers: { "User-Agent": "pace-casso map agent (dev)" } });
    if (res.ok) buf = Buffer.from(await res.arrayBuffer());
  } catch {
    /* missing tile */
  }
  tileCache.set(k, buf);
  return buf;
}

// 800 px JPEG: the first run sent 1024 px PNGs every turn and hit the API request-size limit
const SIZE = CHEAP ? 640 : 800;
/** street map of a square window (local metres), grid lines labelled in metres, optional route + numbered waypoints */
async function renderMap(cx: number, cy: number, widthM: number, route?: { chain: LatLng[]; waypoints: [number, number][] }): Promise<Buffer> {
  const c = toLL(cx, cy);
  const mpp0 = 156543.03 * Math.cos((c[0] * Math.PI) / 180);
  const z = Math.max(10, Math.min(16, Math.ceil(Math.log2((mpp0 * SIZE) / widthM))));
  const winPx = widthM / (mpp0 / 2 ** z);
  const px0 = lonToPx(c[1], z) - winPx / 2, py0 = latToPx(c[0], z) - winPx / 2;
  const w = Math.round(winPx);
  const comps: { input: Buffer; left: number; top: number }[] = [];
  for (let tx = Math.floor(px0 / TILE); tx <= Math.floor((px0 + winPx) / TILE); tx++)
    for (let ty = Math.floor(py0 / TILE); ty <= Math.floor((py0 + winPx) / TILE); ty++) {
      const t = await tile(z, tx, ty);
      if (t) comps.push({ input: t, left: Math.round(tx * TILE - px0), top: Math.round(ty * TILE - py0) });
    }
  const base = await sharp({ create: { width: w, height: w, channels: 3, background: "#e8e8e8" } }).composite(comps.filter((q) => q.left > -TILE && q.top > -TILE && q.left < w && q.top < w)).png().toBuffer();
  const k = SIZE / winPx;
  const PX = (p: LatLng) => [(lonToPx(p[1], z) - px0) * k, (latToPx(p[0], z) - py0) * k] as const;
  const step = widthM <= 1600 ? 100 : widthM <= 3500 ? 250 : widthM <= 8000 ? 500 : widthM <= 16000 ? 1000 : 2000;
  const svg: string[] = [];
  for (let gx = Math.ceil((cx - widthM / 2) / step) * step; gx <= cx + widthM / 2; gx += step) {
    const [x] = PX(toLL(gx, cy));
    svg.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${SIZE}" stroke="#0057b8" stroke-opacity="0.35" stroke-width="1"/><text x="${(x + 3).toFixed(1)}" y="14" font-size="12" font-family="Arial" fill="#0057b8">x=${gx}</text>`);
  }
  for (let gy = Math.ceil((cy - widthM / 2) / step) * step; gy <= cy + widthM / 2; gy += step) {
    const [, y] = PX(toLL(cx, gy));
    svg.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${SIZE}" y2="${y.toFixed(1)}" stroke="#0057b8" stroke-opacity="0.35" stroke-width="1"/><text x="3" y="${(y - 3).toFixed(1)}" font-size="12" font-family="Arial" fill="#0057b8">y=${gy}</text>`);
  }
  if (route && route.chain.length > 1) {
    const d = route.chain.map((p, i) => `${i ? "L" : "M"}${PX(p).map((v) => v.toFixed(1)).join(" ")}`).join(" ");
    svg.push(`<path d="${d}" fill="none" stroke="#fc5200" stroke-width="4" stroke-linejoin="round" stroke-opacity="0.9"/>`);
    route.waypoints.forEach(([wx, wy], i) => {
      const [x, y] = PX(toLL(wx, wy));
      svg.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#111"/><text x="${(x + 5).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="11" font-family="Arial" font-weight="bold" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke">${i}</text>`);
    });
  }
  const overlay = Buffer.from(`<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">${svg.join("")}</svg>`);
  return sharp(base).resize(SIZE, SIZE).composite([{ input: overlay, left: 0, top: 0 }]).jpeg({ quality: 80 }).toBuffer();
}

/** the trace as Strava shows it: the line alone, north-up, on white */
async function renderStrava(chain: LatLng[], size = 600): Promise<Buffer> {
  const xy = chain.map(toXY);
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = 40, k = (size - 2 * pad) / span;
  const ox = pad + (size - 2 * pad - (maxX - minX) * k) / 2, oy = pad + (size - 2 * pad - (maxY - minY) * k) / 2;
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${(ox + (x - minX) * k).toFixed(1)} ${(size - oy - (y - minY) * k).toFixed(1)}`).join(" ");
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="none" stroke="#fc5200" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ---------------------------------------------------------------------------
// the 500k-node NYC walk graph (Manhattan, Brooklyn, Queens) as a PainterGraph
// ---------------------------------------------------------------------------
function loadBigGraph(): PainterGraph {
  const raw = JSON.parse(readFileSync("lib/data/nyc-core-walk-graph.json", "utf8")) as { scale: number; lat: number[]; lng: number[]; edges: number[] };
  const coord: LatLng[] = raw.lat.map((la, i) => [la / raw.scale, raw.lng[i]! / raw.scale]);
  const adj: { to: number; w: number }[][] = coord.map(() => []);
  for (let i = 0; i < raw.edges.length; i += 2) {
    const a = raw.edges[i]!, b = raw.edges[i + 1]!;
    if (a === b) continue;
    const w = meters(coord[a]!, coord[b]!);
    adj[a]!.push({ to: b, w });
    adj[b]!.push({ to: a, w });
  }
  const grid = new Map<string, number[]>();
  const CELL = 0.003; // must match lib/strokePainter.ts
  coord.forEach((c, i) => {
    const k = `${Math.round(c[0] / CELL)}:${Math.round(c[1] / CELL)}`;
    const cell = grid.get(k);
    if (cell) cell.push(i);
    else grid.set(k, [i]);
  });
  return { coord, adj, grid };
}

// ---------------------------------------------------------------------------
// routing: waypoints -> shortest walking path between consecutive points
// ---------------------------------------------------------------------------
type Routed = { chain: LatLng[]; km: number; retracedKm: number; problems: string[]; waypoints: [number, number][] };
function routeWaypoints(g: PainterGraph, pts: [number, number][]): Routed {
  const problems: string[] = [];
  const ids: (number | null)[] = pts.map(([x, y], i) => {
    const nn = nearestNode(g, toLL(x, y));
    if (nn.id < 0 || nn.d > 150) {
      problems.push(`waypoint ${i} (${Math.round(x)}, ${Math.round(y)}) is ${nn.id < 0 ? "far" : Math.round(nn.d) + " m"} from any walkable street and was skipped`);
      return null;
    }
    return nn.id;
  });
  const chainIds: number[] = [];
  let prev: number | null = null, prevIdx = -1;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id == null) continue;
    if (prev == null) {
      chainIds.push(id);
    } else {
      const straight = meters(g.coord[prev]!, g.coord[id]!);
      const path = walk(g, prev, id, straight * 3 + 800);
      if (!path) problems.push(`no walkable path from waypoint ${prevIdx} to ${i}; drew nothing between them`);
      else {
        const walked = path.reduce((a, n, j) => (j ? a + meters(g.coord[path[j - 1]!]!, g.coord[n]!) : 0), 0);
        if (walked > straight * 1.6 + 250) problems.push(`waypoints ${prevIdx}->${i}: the streets detour ${Math.round(walked)} m for a ${Math.round(straight)} m gap (water, park or missing street in between)`);
        chainIds.push(...path.slice(1));
      }
    }
    prev = id;
    prevIdx = i;
  }
  const chain = chainIds.map((n) => g.coord[n]!);
  let km = 0, retraced = 0;
  const seen = new Set<string>();
  for (let i = 1; i < chainIds.length; i++) {
    const a = chainIds[i - 1]!, b = chainIds[i]!;
    const m = meters(g.coord[a]!, g.coord[b]!);
    km += m;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) retraced += m;
    seen.add(key);
  }
  return { chain, km: km / 1000, retracedKm: retraced / 1000, problems, waypoints: pts };
}

// ---------------------------------------------------------------------------
// the agent
// ---------------------------------------------------------------------------
const SYSTEM = `You are a GPS artist. A runner will run your route through New York City with a GPS watch, and the recorded trace, shown as a line on Strava, must read as their logo to a stranger who has not been told what it is. That is the only bar: would a stranger name it at a glance?

The standard is the best human GPS art. You are shown one such piece: a stranger rates it 9 out of 10. Notice how it works: a bold, simplified silhouette; the 2-3 features that make the subject what it is (for a cat: ears, face, whiskers, front legs, tail), exaggerated and drawn big; long confident lines taken from real streets; small details hung off the main line as out-and-back spurs so the run never has to travel to reach them. It is an interpretation of the subject, not a tracing of a picture.

You work the way skilled GPS artists work: first choose WHERE, by looking for a neighbourhood whose streets already suit the subject, then study those streets, find ones that already resemble parts of the subject (a diagonal avenue for a slope, a curving drive or a waterfront for a curve, a small block loop for an eye), place waypoints at intersections, look at the resulting trace, and fix what does not read. Expect to iterate many times.

Where you can draw: all of Manhattan, Brooklyn and Queens. They differ a lot:
- Manhattan: a rigid grid rotated about 29 degrees clockwise from north, blocks about 80 m by 250 m. Good for bold straight-edged shapes; poor for curves and small details.
- Brooklyn and Queens: many grids at different angles meeting along diagonal avenues, plus irregular, curving neighbourhoods with short blocks (for example Forest Hills Gardens, Jamaica Estates, Douglaston and Bayside in Queens; Manhattan Beach, Gerritsen Beach, Marine Park, Midwood and the streets around Prospect Park in Brooklyn). Curves, round shapes and small features are far easier where streets curve and blocks are short. Explore; do not default to Manhattan.

Instruments:
- Coordinates are metres in a local frame: x east, y north, origin (0, 0) at Times Square. Brooklyn is roughly y -3000 to -21000; Queens roughly x 3000 to 19000. The map images carry labelled grid lines.
- view_map(center_x, center_y, width_m) shows a street map of a square window.
- set_route(waypoints) walks the shortest street path between consecutive waypoints, in order, as ONE continuous run. It returns the trace as Strava shows it (orange line on white, north-up) and stats; call view_map to see which streets it used. Put waypoints on intersections and closely enough that each hop follows the street you intend; the shortest path between far-apart points takes whatever streets it likes.
- After every set_route, a person who has never seen the logo is shown only the Strava view and says what it looks like. Use that as your stranger test.
- submit(note) hands in the most recent set_route result as final.

Craft:
- Everything is one line. Going back over streets you already ran is invisible on Strava, which is how artists reach a feature and return; keep retracing moderate.
- Distance: at most ${MAX_KM} km, and shorter is better when it reads just as well. A long route that does not read is the worst outcome.
- Parks, piers and water break the line; the map shows where streets exist.

Place a rough first route with set_route within your first 3 turns, even if crude, and improve from there. Seeing real routes teaches you more than long planning.

Submit when the fresh eyes name the subject and you believe it is close to the standard, or when you are nearly out of turns (you will be told how many remain); in that case submit your best version.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "view_map",
    description: "Street map of a square window of New York City with labelled metre grid lines (x east, y north, origin at Times Square).",
    input_schema: {
      type: "object",
      properties: {
        center_x: { type: "number", description: "window centre, metres east of Times Square" },
        center_y: { type: "number", description: "window centre, metres north of Times Square" },
        width_m: { type: "number", description: "window width and height in metres, 800 to 30000" },
      },
      required: ["center_x", "center_y", "width_m"],
    },
  },
  {
    name: "set_route",
    description: "Route the waypoints in order as one continuous run on walkable streets. Returns the Strava view, the route on the map, and stats.",
    input_schema: {
      type: "object",
      properties: {
        waypoints: {
          type: "array",
          description: "ordered points [x, y] in metres; at least 3",
          items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        },
      },
      required: ["waypoints"],
    },
  },
  {
    name: "submit",
    description: "Hand in the most recent set_route result as the final route.",
    input_schema: { type: "object", properties: { note: { type: "string", description: "what the drawing is and how it reads" } }, required: ["note"] },
  },
];

type LogEntry = { turn: number; text?: string; tool?: string; input?: unknown; result?: string; usd: number };

async function runOne(item: Item): Promise<void> {
  const dir = path.join(OUT, item.name);
  await fs.mkdir(dir, { recursive: true });
  const client = new Anthropic();
  const g = loadBigGraph();
  const logo = await sharp(item.file).flatten({ background: "#fff" }).resize(512, 512, { fit: "contain", background: "#fff" }).png().toBuffer();
  // the whole drawable area: Manhattan, Brooklyn, Queens
  const overview = await renderMap(7200, -8100, 26000);
  const sample = await sharp("tmp-corpus/stravart/images/cats-dogs-2662.jpg").resize(700).jpeg({ quality: 80 }).toBuffer();
  const b64 = (b: Buffer): Anthropic.ImageBlockParam => ({ type: "image", source: { type: "base64", media_type: b[0] === 0x89 ? "image/png" : "image/jpeg", data: b.toString("base64") } });
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "The runner's logo:" },
        b64(logo),
        { type: "text", text: `What the logo is: ${item.label}` },
        { type: "text", text: "The standard to aim for: a human GPS artist's piece (a seated cat, in another country) that strangers rate 9 out of 10:" },
        b64(sample),
        { type: "text", text: "An overview of where you can draw (Manhattan, Brooklyn, Queens; 26 km window) to get your bearings:" },
        b64(overview),
        { type: "text", text: `Design the route. You have ${MAX_TURNS} turns.` },
      ],
    },
  ];
  // --from=<route json>: continue from a saved route instead of a blank map (Ralph, Sep 17:
  // "save that one, then let it keep going from that point for another $15")
  const FROM = opt("from", "");
  const BRIEF = opt("brief", "");
  const REF = opt("ref", "");
  const KEEP_GOING = opt("keepgoing", "0") === "1";
  // --fresheyes=1: after every route, a separate call that has never seen the logo looks at the
  // Strava view alone and says what it is. Its answer goes back to the artist as feedback only.
  const FRESH_EYES = opt("fresheyes", "1") === "1";
  const freshEyes = async (png: Buffer): Promise<{ text: string; usd: number }> => {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
            { type: "text", text: "This orange line is a GPS trace of a route someone ran through a city, drawn as a picture. What is it a picture of? Give your best guess in a few words first, then list each part you can make out and what it looks like. If a part looks like nothing, say so. Be blunt." },
          ],
        },
      ],
    });
    const u = res.usage;
    const cost = (u.input_tokens ?? 0) * P_IN + (u.cache_creation_input_tokens ?? 0) * P_CW + (u.cache_read_input_tokens ?? 0) * P_CR + (u.output_tokens ?? 0) * P_OUT;
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    return { text: text || "(no answer)", usd: cost };
  };
  let seed: Routed | null = null;
  if (FROM) {
    const saved = JSON.parse(await fs.readFile(FROM, "utf8")) as { waypoints: [number, number][] };
    seed = routeWaypoints(g, saved.waypoints);
    const seedStrava = await renderStrava(seed.chain);
    const sxy = seed.chain.map(toXY);
    const sxs = sxy.map((p) => p[0]), sys = sxy.map((p) => p[1]);
    const seedMap = await renderMap((Math.min(...sxs) + Math.max(...sxs)) / 2, (Math.min(...sys) + Math.max(...sys)) / 2, Math.max(1200, Math.max(Math.max(...sxs) - Math.min(...sxs), Math.max(...sys) - Math.min(...sys)) * 1.15), seed);
    const first = messages[0]!.content as Anthropic.ContentBlockParam[];
    first.pop();
    first.push(
      { type: "text", text: "This is the route you designed in an earlier session. Strava view:" },
      b64(seedStrava),
      { type: "text", text: "The same route on the map, waypoints numbered:" },
      b64(seedMap),
      ...(REF
        ? ([
            { type: "text", text: "For reference, an EARLIER version of this route. The client prefers one part of this one; the brief below says which." },
            b64(await fs.readFile(REF)),
          ] as Anthropic.ContentBlockParam[])
        : []),
      {
        type: "text",
        text: `Its waypoints: ${JSON.stringify(saved.waypoints)}\nStats: ${seed.km.toFixed(1)} km, ${seed.retracedKm.toFixed(1)} km retraced.\n\nKeep improving this route until it is genuinely great: a stranger should name every part of the logo at a glance, with clean lines and nothing that reads as a stray scribble. Look hard for what is weakest and fix it; try bolder changes where a part does not read. You have ${MAX_TURNS} turns.${KEEP_GOING ? " There is budget to keep refining, so do not stop early; submit only records a checkpoint and you continue." : ""}${BRIEF ? `\n\nTHE CLIENT'S BRIEF, in their own words — this outranks your own judgement about what to change:\n"""\n${BRIEF}\n"""\nMake exactly these changes. Keep everything they praised as it is.` : ""}`,
      },
    );
  }
  const log: LogEntry[] = [];
  let usd = 0;
  const spendFile = path.join(dir, "spend.txt");
  const spentBefore = (await totalSpent()) - (existsSync(spendFile) ? Number(await fs.readFile(spendFile, "utf8")) || 0 : 0);
  const runCap = Math.min(CAP_USD, TOTAL_USD - spentBefore);
  console.log(`${item.name}: $${spentBefore.toFixed(2)} spent so far of $${TOTAL_USD}; this run may use up to $${runCap.toFixed(2)}`);
  if (runCap < 0.5) {
    console.log(`${item.name}: not started, the $${TOTAL_USD} total budget is used up`);
    return;
  }
  let last: Routed | null = seed;
  let routes = 0;
  let submitted: string | null = null;
  const t0 = Date.now();
  for (let turn = 1; turn <= MAX_TURNS && !submitted; turn++) {
    // the cap can be raised while a run is going: write a number to <out>/cap.txt
    let cap = runCap;
    try {
      const v = Number((await fs.readFile(path.join(OUT, "cap.txt"), "utf8")).trim());
      if (Number.isFinite(v) && v > 0) cap = Math.min(v, TOTAL_USD - spentBefore);
    } catch {
      /* no override */
    }
    if (usd > cap * 0.9) {
      log.push({ turn, text: `spend cap: stopping at $${usd.toFixed(2)}`, usd });
      break;
    }
    let res: Anthropic.Message;
    try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      system: SYSTEM,
      tools: TOOLS,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      cache_control: { type: "ephemeral" },
      messages,
    });
    res = await stream.finalMessage();
    } catch (e) {
      // keep what was drawn: finish with the last route instead of losing the run
      log.push({ turn, text: `API error, stopping: ${e instanceof Error ? e.message : String(e)}`, usd });
      console.log(`${item.name} API error at turn ${turn}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      break;
    }
    const u = res.usage;
    const cost = (u.input_tokens ?? 0) * P_IN + (u.cache_creation_input_tokens ?? 0) * P_CW + (u.cache_read_input_tokens ?? 0) * P_CR + (u.output_tokens ?? 0) * P_OUT;
    usd += cost;
    await fs.writeFile(spendFile, usd.toFixed(4));
    messages.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text" && b.text.trim()) log.push({ turn, text: b.text.trim(), usd });
    if (res.stop_reason === "refusal") {
      log.push({ turn, text: "refused", usd });
      break;
    }
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      messages.push({ role: "user", content: [{ type: "text", text: `Keep working with the tools. ${MAX_TURNS - turn} turns left.` }] });
      continue;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of uses) {
      const input = tu.input as Record<string, unknown>;
      const left = MAX_TURNS - turn;
      try {
        if (tu.name === "view_map") {
          const cx = Number(input.center_x), cy = Number(input.center_y);
          const wm = Math.max(800, Math.min(30000, Number(input.width_m)));
          if (![cx, cy, wm].every(Number.isFinite)) throw new Error("center_x, center_y and width_m must be numbers");
          const img = await renderMap(cx, cy, wm, last ?? undefined);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: [{ type: "text", text: `Map centred (${Math.round(cx)}, ${Math.round(cy)}), ${Math.round(wm)} m wide.${last ? " Your current route is drawn on it." : ""} ${left} turns left.` }, b64(img)] });
          log.push({ turn, tool: "view_map", input, usd });
        } else if (tu.name === "set_route") {
          const raw = input.waypoints;
          if (!Array.isArray(raw) || raw.length < 3) throw new Error("waypoints must be an array of at least 3 [x, y] pairs");
          const pts = raw.map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN]) as [number, number]).filter((p) => p.every(Number.isFinite));
          const r = routeWaypoints(g, pts);
          if (r.chain.length < 3) throw new Error(`the waypoints produced no route. ${r.problems.join("; ")}`);
          last = r;
          routes++;
          const strava = await renderStrava(r.chain);
          const xy = r.chain.map(toXY);
          const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          const wm = Math.max(1200, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.15);
          const onMap = await renderMap(cx, cy, wm, r);
          const tag = String(routes).padStart(2, "0");
          await fs.writeFile(path.join(dir, `route-${tag}-strava.png`), strava);
          await fs.writeFile(path.join(dir, `route-${tag}-map.jpg`), onMap);
          await fs.writeFile(path.join(dir, `route-${tag}.json`), JSON.stringify({ waypoints: pts, km: r.km, retracedKm: r.retracedKm }));
          const stats = `${r.km.toFixed(1)} km total${r.km > MAX_KM ? ` (OVER the ${MAX_KM} km limit: this cannot be submitted, make it smaller)` : ""}, ${r.retracedKm.toFixed(1)} km of it retraced, ${pts.length} waypoints.${r.problems.length ? " Problems: " + r.problems.join("; ") + "." : ""} ${left} turns left.`;
          let fresh = "";
          if (FRESH_EYES) {
            try {
              const fe = await freshEyes(strava);
              usd += fe.usd;
              await fs.writeFile(spendFile, usd.toFixed(4));
              fresh = `\n\nFresh eyes: someone who has never seen the logo was shown only the Strava view and asked what it is. They said:\n"""\n${fe.text}\n"""\nUse this to find the parts that do not read yet.`;
              await fs.writeFile(path.join(dir, `route-${tag}-fresheyes.txt`), fe.text);
            } catch (e) {
              fresh = `\n\n(Fresh-eyes check failed: ${e instanceof Error ? e.message : String(e)})`;
            }
          }
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: CHEAP
              ? [{ type: "text", text: `Strava view (what a stranger sees):` }, b64(strava), { type: "text", text: `${stats + fresh}\nCall view_map if you need to see which streets the route is on.` }]
              : [{ type: "text", text: `Strava view (what a stranger sees):` }, b64(strava), { type: "text", text: "The route on the map, waypoints numbered:" }, b64(onMap), { type: "text", text: stats + fresh }],
          });
          log.push({ turn, tool: "set_route", input: { n: pts.length }, result: stats + fresh, usd });
        } else if (tu.name === "submit") {
          if (!last) throw new Error("nothing to submit yet: call set_route first");
          if (last.km > MAX_KM) throw new Error(`the current route is ${last.km.toFixed(1)} km, over the ${MAX_KM} km limit; make it smaller before submitting`);
          if (KEEP_GOING) {
            results.push({ type: "tool_result", tool_use_id: tu.id, content: `Checkpoint recorded. Keep improving: find the weakest part and make it read better. ${left} turns left.` });
            log.push({ turn, tool: "submit", result: `checkpoint: ${String(input.note ?? "")}`, usd });
            continue;
          }
          submitted = String(input.note ?? "");
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "Submitted." });
          log.push({ turn, tool: "submit", result: submitted, usd });
        } else throw new Error(`unknown tool ${tu.name}`);
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: e instanceof Error ? e.message : String(e) });
        log.push({ turn, tool: tu.name, result: `error: ${e instanceof Error ? e.message : String(e)}`, usd });
      }
    }
    messages.push({ role: "user", content: results });
    console.log(`${item.name} turn ${turn}: ${uses.map((u2) => u2.name).join(",")} | $${usd.toFixed(2)} | ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
  const summary = { item, submitted: submitted !== null, note: submitted, routes, usd, minutes: (Date.now() - t0) / 60000, km: last?.km, retracedKm: last?.retracedKm, waypoints: last?.waypoints };
  if (last) {
    await fs.writeFile(path.join(dir, "final-strava.png"), await renderStrava(last.chain, 1024));
    await fs.writeFile(path.join(dir, "final.gpx"), writeGpx(last.chain, item.name, "PaceCasso map agent"));
  }
  await fs.writeFile(path.join(dir, "summary.json"), JSON.stringify(summary, null, 1));
  await fs.writeFile(path.join(dir, "log.json"), JSON.stringify(log, null, 1));
  console.log(`${item.name} DONE: ${JSON.stringify({ ...summary, waypoints: undefined })}`);
}

async function totalSpent(): Promise<number> {
  let t = 0;
  if (!existsSync(OUT)) return 0;
  for (const d of await fs.readdir(OUT)) {
    const f = path.join(OUT, d, "spend.txt");
    if (existsSync(f)) t += Number(await fs.readFile(f, "utf8")) || 0;
  }
  return t;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  if (STAGE === "spent") return void console.log(`spent so far: $${(await totalSpent()).toFixed(2)} of $${TOTAL_USD}`);
  if (STAGE === "selftest") {
    // free check of the instruments on the big graph: overview + a Queens block loop
    const g = loadBigGraph();
    await fs.writeFile(path.join(OUT, "selftest-overview.jpg"), await renderMap(7200, -8100, 26000));
    const r = routeWaypoints(g, [[8000, -300], [8800, -300], [8800, -1100], [8000, -1100], [8000, -300]]);
    console.log(`selftest route: ${r.km.toFixed(2)} km, retraced ${r.retracedKm.toFixed(2)}, problems: ${r.problems.join("; ") || "none"}`);
    await fs.writeFile(path.join(OUT, "selftest-map.jpg"), await renderMap(8400, -700, 2400, r));
    await fs.writeFile(path.join(OUT, "selftest-strava.png"), await renderStrava(r.chain));
    return;
  }
  const file = opt("file", "");
  const name = opt("name", path.basename(file).replace(/\.[^.]+$/, ""));
  if (!file || !existsSync(file)) throw new Error("--file=<logo image> is required");
  await runOne({ name, kind: "brand", file, label: opt("label", name) });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
