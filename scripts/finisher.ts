/**
 * FINISHER — the machine does what Cameron does by hand.
 *
 * Start from a draft (the inkline engine's best judged seat). Then, for as
 * long as the budget allows: make ONE small edit to the drawing — drag a
 * corner with a smooth falloff, nudge or rescale one stroke, drop a spur,
 * simplify a wobbly run, or shift/rotate/scale the whole placement — route
 * it on real streets, render it the way Strava would, ask the blind judge
 * "how clearly is this the uploaded picture?", and KEEP the edit only when
 * strangers read it better. Judge noise is handled by re-scoring the
 * incumbent every few rounds and pooling its samples.
 *
 * Usage: npx tsx scripts/finisher.ts <image> --mask=blue --center=40.73,-73.9921
 *        --scale=1300 --rot=-28 [--iters=45] [--open=60] [--hug=90] [--name=gas-fin]
 *        [--graph=tmp-painter/nyc-core-walk-graph.json] [--seed=1]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { place, type LatLng } from "../lib/streetGraphTrace";
import {
  makePlan,
  orderStrokes,
  routePlacement,
  meters,
  setHugTolerance,
  setTraceProfile,
  type PainterGraph,
  type Plan,
  type Routed,
  type Stroke,
  type UnitPt,
} from "../lib/strokePainter";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const argv = process.argv.slice(2);
const IMG = argv.find((a) => !a.startsWith("--"));
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
if (!IMG) {
  console.log("usage: npx tsx scripts/finisher.ts <image> --mask=.. --center=lat,lng --scale=.. --rot=..");
  process.exit(1);
}
const NAME = opt("name", path.basename(IMG).replace(/\.[^.]+$/, "") + "-fin");
const MASK_MODE = opt("mask", "ink");
const CENTER0 = opt("center", "40.73,-73.99").split(",").map(Number) as [number, number];
const SCALE0 = Number(opt("scale", "1300"));
const ROT0 = Number(opt("rot", "0"));
const ITERS = Number(opt("iters", "45"));
const OPEN_M = Number(opt("open", "60"));
const HUG_M = Number(opt("hug", "90"));
const GRAPH = opt("graph", "tmp-painter/nyc-core-walk-graph.json");
const MODEL = opt("model", "claude-fable-5");
const RESUME = opt("resume", ""); // a previous run's summary.json: continue from its best drawing
const OUT = path.join(process.cwd(), "tmp-finisher", NAME);
const BOX = 320;
let seed = Number(opt("seed", "1"));
const rnd = () => {
  // deterministic LCG so a run can be repeated
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// ---------------------------------------------------------------------------
// mask + graph (same as the inkline rig)
// ---------------------------------------------------------------------------
async function loadMask(file: string, mode: string): Promise<{ mask: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(file)
    .resize(BOX, BOX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width as number;
  const h = info.height as number;
  const mask = new Uint8Array(w * h);
  if (mode === "edges") {
    const label = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, a = data[i * 4 + 3]!;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (a < 128 || lum > 235) label[i] = 0;
      else if (lum < 70) label[i] = 1;
      else {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx ? (mx - mn) / mx : 0;
        if (sat < 0.25) label[i] = 2;
        else {
          let hue = 0;
          if (mx === r) hue = ((g - b) / (mx - mn + 1e-9) + 6) % 6;
          else if (mx === g) hue = (b - r) / (mx - mn + 1e-9) + 2;
          else hue = (r - g) / (mx - mn + 1e-9) + 4;
          label[i] = 3 + Math.floor(hue);
        }
      }
    }
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = label[i];
        if (label[i + 1] !== l || label[i + w] !== l) {
          mask[i] = 255;
          mask[i + 1] = 255;
          mask[i + w] = 255;
        }
      }
    return { mask, w, h };
  }
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, a = data[i * 4 + 3]!;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let ink = false;
    if (mode === "blue") ink = a > 128 && b > 60 && b > r * 1.25 && b > g * 1.25;
    else if (mode === "dark") ink = a > 128 && lum < 110;
    else ink = a > 128 && lum < 200;
    if (ink) mask[i] = 255;
  }
  return { mask, w, h };
}
const CELL = 0.003;
async function loadPackedGraph(file: string): Promise<PainterGraph> {
  const data = JSON.parse(await fs.readFile(file, "utf8")) as { scale: number; lat: number[]; lng: number[]; edges: number[] };
  const n = data.lat.length;
  const coord: LatLng[] = new Array(n);
  for (let i = 0; i < n; i++) coord[i] = [data.lat[i]! / data.scale, data.lng[i]! / data.scale];
  const adj: { to: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < data.edges.length; e += 2) {
    const a = data.edges[e]!, b = data.edges[e + 1]!;
    const w = meters(coord[a]!, coord[b]!);
    adj[a]!.push({ to: b, w });
    adj[b]!.push({ to: a, w });
  }
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(coord[i]![0] / CELL)}:${Math.round(coord[i]![1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  }
  return { coord, adj, grid };
}

// ---------------------------------------------------------------------------
// render + judge
// ---------------------------------------------------------------------------
const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
const tileCache = new Map<string, Buffer | null>();
async function tile(z: number, x: number, y: number): Promise<Buffer | null> {
  const k = `${z}/${y}/${x}`;
  if (tileCache.has(k)) return tileCache.get(k)!;
  let buf: Buffer | null = null;
  try {
    const res = await fetch(`https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`, {
      headers: { "User-Agent": "pace-casso route preview (dev)" },
    });
    if (res.ok) buf = await sharp(Buffer.from(await res.arrayBuffer())).resize(TILE, TILE).toBuffer();
  } catch {
    /* missing tile */
  }
  tileCache.set(k, buf);
  return buf;
}
async function paleRender(chain: LatLng[], file: string): Promise<Buffer> {
  const w = 1300, h = 1100;
  let zoom = 14;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z)), ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.9 && Math.max(...ys) - Math.min(...ys) <= h * 0.9) {
      zoom = z;
      break;
    }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom)), ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: object[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++)
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      const t = await tile(zoom, tx, ty);
      if (t) tiles.push({ input: t, left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
    }
  const d = chain.map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="white" stroke-width="11" stroke-linejoin="round" opacity="0.9"/><path d="${d}" fill="none" stroke="#fc5200" stroke-width="5.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  );
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eaeaea" } })
    .composite([...tiles, { input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(file);
  return sharp(file).resize({ width: 1400 }).jpeg({ quality: 88 }).toBuffer();
}

let KEY = "";
let UPLOAD_B64 = "";
async function claude(content: unknown[], maxTokens = 2500): Promise<string> {
  for (let a = 0; a < 6; a++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
        continue;
      }
      const j = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
    } catch {
      await new Promise((r) => setTimeout(r, 5000 * (a + 1)));
    }
  }
  return "";
}
const LIKE_PROMPT =
  "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as an orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1 to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color or background. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>";
const COLD_PROMPT =
  "The orange line is a GPS route someone recorded while running; they were trying to draw a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words, or \"nothing recognizable\">\nCONFIDENCE: <0-10>";
async function likeness(renderJpg: Buffer, n: number): Promise<{ scores: number[]; reasons: string[] }> {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: renderJpg.toString("base64") } };
  const up = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: UPLOAD_B64 } };
  const scores: number[] = [];
  const reasons: string[] = [];
  const calls = Array.from({ length: n }, () => claude([up, img, { type: "text", text: LIKE_PROMPT }]));
  for (const t of await Promise.all(calls)) {
    const m = t.match(/SCORE:\s*(\d+)/i);
    if (m) {
      scores.push(Number(m[1]));
      reasons.push((t.match(/REASON:\s*(.+)/i)?.[1] ?? "").trim());
    }
  }
  return { scores, reasons };
}
async function coldName(renderJpg: Buffer, n: number): Promise<{ guess: string; conf: number }[]> {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: renderJpg.toString("base64") } };
  const out: { guess: string; conf: number }[] = [];
  const calls = Array.from({ length: n }, () => claude([img, { type: "text", text: COLD_PROMPT }]));
  for (const t of await Promise.all(calls)) {
    const guess = (t.match(/GUESS\**:?\**\s*(.+?)\s*(?:\n|\*|CONFIDENCE|$)/i)?.[1] ?? "").trim();
    out.push({ guess: guess || "?", conf: Number(t.match(/CONFIDENCE\**:?\**\s*(\d+)/i)?.[1] ?? 0) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the drawing state and the edit moves
// ---------------------------------------------------------------------------
type State = { strokes: Stroke[]; center: LatLng; scale: number; rot: number };
const cloneStrokes = (s: Stroke[]): Stroke[] => s.map((k) => ({ ...k, pts: k.pts.map((p) => [p[0], p[1]] as UnitPt) }));
const strokeLen = (s: Stroke) => {
  let l = 0;
  for (let i = 1; i < s.pts.length; i++) l += Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]);
  return l;
};
function pickStroke(strokes: Stroke[]): number {
  const w = strokes.map((s) => Math.max(0.05, strokeLen(s)));
  const total = w.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < w.length; i++) {
    r -= w[i]!;
    if (r <= 0) return i;
  }
  return w.length - 1;
}
function turnAt(pts: UnitPt[], i: number): number {
  if (i <= 0 || i >= pts.length - 1) return 0;
  const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}
function rdp(pts: UnitPt[], eps: number): UnitPt[] {
  if (pts.length < 3) return pts;
  const d2 = (p: UnitPt, a: UnitPt, b: UnitPt) => {
    const bx = b[0] - a[0], by = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * bx + (p[1] - a[1]) * by) / (bx * bx + by * by || 1)));
    return Math.hypot(p[0] - a[0] - t * bx, p[1] - a[1] - t * by);
  };
  let idx = -1, md = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = d2(pts[i]!, pts[0]!, pts[pts.length - 1]!);
    if (d > md) { md = d; idx = i; }
  }
  if (md > eps) return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  return [pts[0]!, pts[pts.length - 1]!];
}

type Move = { kind: string; detail: string };
/** one Cameron-style edit; returns the new state and a label */
function propose(st: State, blockU: number): { next: State; move: Move } {
  const next: State = { strokes: cloneStrokes(st.strokes), center: [st.center[0], st.center[1]], scale: st.scale, rot: st.rot };
  const r = rnd();
  if (r < 0.6) {
    // drag a corner: prefer high-turn vertices, smooth falloff along the polyline
    const si = pickStroke(next.strokes);
    const s = next.strokes[si]!;
    const pts = s.pts;
    if (pts.length < 3) return propose(st, blockU);
    const weights = pts.map((_, i) => 0.3 + turnAt(pts, i));
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = rnd() * total, vi = 0;
    for (let i = 0; i < weights.length; i++) { acc -= weights[i]!; if (acc <= 0) { vi = i; break; } }
    const mag = blockU * (0.4 + rnd() * 1.8);
    const ang = rnd() * 2 * Math.PI;
    const dx = Math.cos(ang) * mag, dy = Math.sin(ang) * mag;
    const radius = blockU * 1.5;
    // arc-length distance from vi, both directions
    const dist = new Array<number>(pts.length).fill(Infinity);
    dist[vi] = 0;
    for (let i = vi + 1; i < pts.length; i++) dist[i] = dist[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    for (let i = vi - 1; i >= 0; i--) dist[i] = dist[i + 1]! + Math.hypot(pts[i]![0] - pts[i + 1]![0], pts[i]![1] - pts[i + 1]![1]);
    for (let i = 0; i < pts.length; i++) {
      const f = Math.exp(-((dist[i]! / radius) ** 2));
      if (f < 0.02) continue;
      pts[i] = [pts[i]![0] + dx * f, pts[i]![1] + dy * f];
    }
    if (s.closed) pts[pts.length - 1] = [pts[0]![0], pts[0]![1]];
    return { next, move: { kind: "drag", detail: `stroke ${si} v${vi} by ${(mag / blockU).toFixed(1)} blocks` } };
  }
  if (r < 0.72) {
    // nudge or rescale one whole stroke
    const si = pickStroke(next.strokes);
    const s = next.strokes[si]!;
    let cx = 0, cy = 0;
    for (const p of s.pts) { cx += p[0]; cy += p[1]; }
    cx /= s.pts.length; cy /= s.pts.length;
    if (rnd() < 0.5) {
      const dx = (rnd() - 0.5) * 2 * blockU, dy = (rnd() - 0.5) * 2 * blockU;
      s.pts = s.pts.map((p) => [p[0] + dx, p[1] + dy] as UnitPt);
      return { next, move: { kind: "shift-stroke", detail: `stroke ${si}` } };
    }
    const k = 1 + (rnd() - 0.5) * 0.3;
    s.pts = s.pts.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k] as UnitPt);
    return { next, move: { kind: "scale-stroke", detail: `stroke ${si} x${k.toFixed(2)}` } };
  }
  if (r < 0.8) {
    // simplify one stroke: fewer wobbles, longer deliberate runs
    const si = pickStroke(next.strokes);
    const s = next.strokes[si]!;
    const eps = blockU * (0.3 + rnd() * 0.5);
    const before = s.pts.length;
    let pts = rdp(s.pts, eps);
    if (s.closed && pts.length > 2) pts[pts.length - 1] = [pts[0]![0], pts[0]![1]];
    if (pts.length >= (s.closed ? 4 : 2)) s.pts = pts;
    return { next, move: { kind: "simplify", detail: `stroke ${si} ${before}->${s.pts.length} pts` } };
  }
  if (r < 0.85 && next.strokes.length > 1) {
    // drop a small stroke (spur / clutter) — never the biggest outline
    const lens = next.strokes.map(strokeLen);
    const biggest = lens.indexOf(Math.max(...lens));
    const cands = next.strokes.map((_, i) => i).filter((i) => i !== biggest);
    const si = cands[Math.floor(rnd() * cands.length)]!;
    next.strokes.splice(si, 1);
    return { next, move: { kind: "drop", detail: `stroke ${si}` } };
  }
  if (r < 0.92) {
    next.center = [st.center[0] + ((rnd() - 0.5) * 2 * blockU * st.scale) / 111320, st.center[1] + ((rnd() - 0.5) * 2 * blockU * st.scale) / (111320 * Math.cos((st.center[0] * Math.PI) / 180))];
    return { next, move: { kind: "shift-all", detail: "" } };
  }
  if (r < 0.96) {
    next.rot = st.rot + (rnd() - 0.5) * 8;
    return { next, move: { kind: "rotate", detail: `${next.rot.toFixed(1)}°` } };
  }
  next.scale = Math.round(st.scale * (1 + (rnd() - 0.5) * 0.12));
  return { next, move: { kind: "rescale", detail: `${next.scale} m` } };
}

// ---------------------------------------------------------------------------
async function main() {
  await fs.mkdir(OUT, { recursive: true });
  try {
    KEY = (await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8")).match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  } catch {
    /* no key */
  }
  if (!KEY) throw new Error("ANTHROPIC_API_KEY missing in .env.local");
  UPLOAD_B64 = (await sharp(IMG).flatten({ background: "#fff" }).resize({ width: 700 }).jpeg({ quality: 88 }).toBuffer()).toString("base64");
  setHugTolerance(HUG_M);
  setTraceProfile({ trimNubs: true });
  const { mask, w, h } = await loadMask(IMG!, MASK_MODE);
  const g = await loadPackedGraph(GRAPH);
  const plan0: Plan = makePlan(mask, w, h, SCALE0, { pitchM: 160, rows: 0, openM: OPEN_M }, []);
  let best: State = { strokes: plan0.strokes, center: CENTER0, scale: SCALE0, rot: ROT0 };
  if (RESUME) {
    const prev = JSON.parse(await fs.readFile(RESUME, "utf8")) as { strokes: Stroke[]; center: LatLng; scale: number; rot: number };
    best = { strokes: prev.strokes, center: prev.center, scale: prev.scale, rot: prev.rot };
    console.log(`resumed from ${RESUME}: ${best.strokes.length} strokes, scale ${best.scale}, rot ${best.rot}`);
  }
  const blockU = 110 / SCALE0; // ~ one short block in unit space

  const evaluate = async (st: State, tag: string, n = 3) => {
    const r: Routed | null = routePlacement(g, orderStrokes(st.strokes), st.center, st.scale, st.rot, false);
    if (!r || r.dropped > 0 || r.maxGap > 400) return null;
    const jpg = await paleRender(r.chain, path.join(OUT, `${tag}.png`));
    const lk = await likeness(jpg, n);
    if (!lk.scores.length) return null;
    return { r, jpg, scores: lk.scores, reasons: lk.reasons };
  };

  const log: string[] = [];
  const say = (s: string) => {
    console.log(s);
    log.push(s);
  };
  const first = await evaluate(best, "iter-000", 6);
  if (!first) throw new Error("the starting draft did not route");
  let bestSamples = first.scores.slice();
  let bestRouted = first.r;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  say(`start: likeness ${first.scores.join("/")} mean ${mean(bestSamples).toFixed(2)} | ${first.r.km.toFixed(1)} km | ${first.reasons[0]}`);
  await fs.copyFile(path.join(OUT, "iter-000.png"), path.join(OUT, "best.png"));

  let accepted = 0;
  let sinceRecheck = 0;
  const t0 = Date.now();
  for (let it = 1; it <= ITERS; it++) {
    const { next, move } = propose(best, blockU);
    const tag = `iter-${String(it).padStart(3, "0")}`;
    const ev = await evaluate(next, tag);
    if (!ev) {
      say(`${tag} ${move.kind} ${move.detail}: did not route — rejected`);
      continue;
    }
    const cm = mean(ev.scores);
    const bm = mean(bestSamples);
    const gain = cm - bm;
    if (gain > 0.3) {
      best = next;
      bestSamples = ev.scores.slice();
      bestRouted = ev.r;
      accepted++;
      sinceRecheck = 0;
      await fs.copyFile(path.join(OUT, `${tag}.png`), path.join(OUT, "best.png"));
      say(`${tag} ${move.kind} ${move.detail}: ${ev.scores.join("/")} vs best ${bm.toFixed(2)} — ACCEPT (${ev.r.km.toFixed(1)} km) | ${ev.reasons[0]}`);
    } else {
      say(`${tag} ${move.kind} ${move.detail}: ${ev.scores.join("/")} vs best ${bm.toFixed(2)} — reject`);
      try {
        await fs.unlink(path.join(OUT, `${tag}.png`));
      } catch {
        /* keep going */
      }
    }
    // pool fresh samples into the incumbent every few rounds so a lucky
    // score does not anchor the search
    if (++sinceRecheck >= 6) {
      sinceRecheck = 0;
      const jpg = await sharp(path.join(OUT, "best.png")).resize({ width: 1400 }).jpeg({ quality: 88 }).toBuffer();
      const lk = await likeness(jpg, 3);
      bestSamples.push(...lk.scores);
      say(`   recheck best: +${lk.scores.join("/")} → pooled mean ${mean(bestSamples).toFixed(2)} over ${bestSamples.length}`);
    }
    if ((Date.now() - t0) / 60000 > Number(opt("minutes", "60"))) {
      say("time budget reached");
      break;
    }
  }
  // final verdict on the incumbent: 6 fresh likeness samples + 3 cold names
  const jpg = await sharp(path.join(OUT, "best.png")).resize({ width: 1400 }).jpeg({ quality: 88 }).toBuffer();
  const finalLike = await likeness(jpg, 6);
  const cold = await coldName(jpg, 3);
  const gpx = bestRouted.chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
  await fs.writeFile(
    path.join(OUT, "best.gpx"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso finisher" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${NAME}</name><trkseg>\n${gpx}\n</trkseg></trk></gpx>\n`,
  );
  say(`\nFINAL ${NAME}: start ${first.scores.join("/")} → final likeness ${finalLike.scores.join("/")} (mean ${mean(finalLike.scores).toFixed(2)}) cold ${cold.map((c) => `${c.guess} ${c.conf}`).join(" / ")} | ${bestRouted.km.toFixed(1)} km | accepted ${accepted}/${ITERS} | ${((Date.now() - t0) / 60000).toFixed(0)} min`);
  await fs.writeFile(path.join(OUT, "log.txt"), log.join("\n"));
  await fs.writeFile(
    path.join(OUT, "summary.json"),
    JSON.stringify({ name: NAME, start: first.scores, final: finalLike.scores, cold, km: bestRouted.km, center: best.center, scale: best.scale, rot: best.rot, accepted, iters: ITERS, strokes: best.strokes }, null, 2),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
