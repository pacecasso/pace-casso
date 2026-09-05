/**
 * INKLINE — draw the upload the way the reference pieces are drawn: as LINE
 * ART (outline + interior lines, no hatch fill) traced organically on real
 * streets, seated anywhere in the city (downtown fine grid, Brooklyn, parks
 * allowed), free rotation, and the blind judge as the final ranker.
 *
 * Differences from scripts/stroke-painter.ts (the production painter):
 *   - rows=0: no hatch rows; masses are outlined, thin parts are centerlines
 *   - no uniform-grid gate, no 14th St floor, no Central Park exclusion
 *   - rotation: local grid rotation AND free angles (0, ±15, ±30)
 *   - seat score is curvature-weighted (features must land on junctions)
 *   - routing is the organic tracer (quantize=false) — stairs come from the
 *     streets, not from a measured lattice
 *   - the judge (not the fidelity proxy) picks the final order
 *
 * Usage: npx tsx scripts/inkline.ts <image> [--mask=ink|blue|dark] [--name=x]
 *        [--graph=tmp-painter/nyc-core-walk-graph.json] [--scales=1300,1600,2000]
 *        [--lat=40.70,40.80] [--lng=-74.02,-73.93] [--rots=auto|0,15,-15]
 *        [--open=60] [--hug=90] [--rows=0] [--route=40] [--judge=8] [--nojudge]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { place, type LatLng } from "../lib/streetGraphTrace";
import { buildDistanceField, elasticFit, warpPoint, densify, featureWeights, toXY, fromXY, type XY } from "../lib/elasticFit";
import {
  makePlan,
  orderStrokes,
  routePlacement,
  localGridInfo,
  nearestNode,
  meters,
  setHugTolerance,
  setBlockify,
  setTraceProfile,
  TRACE,
  type PainterGraph,
  type Plan,
  type Routed,
  type UnitPt,
} from "../lib/strokePainter";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const argv = process.argv.slice(2);
const IMG = argv.find((a) => !a.startsWith("--"));
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
if (!IMG) {
  console.log("usage: npx tsx scripts/inkline.ts <image> [--mask=ink|blue|dark]");
  process.exit(1);
}
const NAME = opt("name", path.basename(IMG).replace(/\.[^.]+$/, ""));
const MASK_MODE = opt("mask", "ink");
const SCALES = opt("scales", "1300,1600,2000").split(",").map(Number);
const OPEN_M = Number(opt("open", "60"));
const HUG_M = Number(opt("hug", "90"));
const ROWS = Number(opt("rows", "0"));
const PITCH_M = Number(opt("pitch", "160"));
const GRAPH = opt("graph", "tmp-painter/nyc-core-walk-graph.json");
const [LAT0, LAT1] = opt("lat", "40.70,40.80").split(",").map(Number);
const [LNG0, LNG1] = opt("lng", "-74.02,-73.93").split(",").map(Number);
const ROTS_OPT = opt("rots", "auto");
const N_ROUTE = Number(opt("route", "40"));
const N_JUDGE = Number(opt("judge", "8"));
const JUDGE = !argv.includes("--nojudge");
const STEP_LAT = Number(opt("step", "0.003"));
const STEP_LNG = STEP_LAT * 1.33;
const OUT = path.join(process.cwd(), "tmp-inkline", NAME);
const BOX = 320;
const MODEL = opt("model", "claude-fable-5");
const QUANTIZE = opt("quantize", "off") === "on";
// elastic registration: --elastic=on [--alpha=2] [--beta=0.02] [--levels=900,450,220]
const ELASTIC = opt("elastic", "off") === "on";
const ALPHA = Number(opt("alpha", "2"));
const BETA = Number(opt("beta", "0.02"));
const LEVELS = opt("levels", "900,450,220").split(",").map(Number);
const BLOCKIFY_ON = opt("blockify", "off") === "on";
// tracer profile overrides: --corridor=65 --lambda=30 --bend=60 --anchor=200 --trim=on --gapwalk=3000
const num = (k: string, d: number) => Number(opt(k, String(d)));
const TRIM = opt("trim", "off") === "on";

// ---------------------------------------------------------------------------
// mask + graph
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
    // colour-region boundaries = the logo's own line art (lips vs tongue vs teeth)
    const label = new Int32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!, a = data[i * 4 + 3]!;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (a < 128 || lum > 235) label[i] = 0; // background / white
      else if (lum < 70) label[i] = 1; // black line / dark
      else {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx ? (mx - mn) / mx : 0;
        if (sat < 0.25) label[i] = 2; // grey
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
// render + judge (same presentation as the production rig)
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
async function debugRender(r: Routed, file: string) {
  const w = 1300, h = 1100;
  const chain = r.chain;
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
  const segs: string[] = [];
  for (let i = 1; i < chain.length; i++) {
    const c = r.isInk[i] ? "#fc5200" : "#2266dd";
    segs.push(`<line x1="${(xs[i - 1]! - vx).toFixed(1)}" y1="${(ys[i - 1]! - vy).toFixed(1)}" x2="${(xs[i]! - vx).toFixed(1)}" y2="${(ys[i]! - vy).toFixed(1)}" stroke="${c}" stroke-width="${r.isInk[i] ? 4 : 2.5}" stroke-linecap="round"/>`);
  }
  const svg = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="#fff"/>${segs.join("")}</svg>`);
  await sharp(svg).png().toFile(file);
}
async function planSheet(mask: Uint8Array, w: number, h: number, plan: Plan, file: string) {
  const S = 3;
  const px: string[] = [];
  const col = { outline: "#e11", hatch: "#06c", thin: "#0a0" } as const;
  const toPx = (p: UnitPt) => [(plan.cx + (p[0] * plan.span) / 2) * S, (plan.cy - (p[1] * plan.span) / 2) * S];
  for (const s of plan.strokes) {
    const d = s.pts
      .map((p, i) => {
        const [x, y] = toPx(p);
        return `${i ? "L" : "M"}${x!.toFixed(1)} ${y!.toFixed(1)}`;
      })
      .join(" ");
    px.push(`<path d="${d}" fill="none" stroke="${col[s.kind]}" stroke-width="2.5" stroke-linejoin="round"/>`);
  }
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i] === 255 ? 200 : 255;
    raw[i * 3] = v;
    raw[i * 3 + 1] = v;
    raw[i * 3 + 2] = v;
  }
  const base = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).resize(w * S, h * S, { kernel: "nearest" }).png().toBuffer();
  const svg = Buffer.from(`<svg width="${w * S}" height="${h * S}" xmlns="http://www.w3.org/2000/svg">${px.join("")}</svg>`);
  await sharp(base).composite([{ input: svg, left: 0, top: 0 }]).png().toFile(file);
}

let KEY = "";
async function claude(content: unknown[], maxTokens = 2500): Promise<string> {
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 4000 * (a + 1)));
        continue;
      }
      const j = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
    } catch {
      await new Promise((r) => setTimeout(r, 4000 * (a + 1)));
    }
  }
  return "";
}
type Judge = { cold: { guess: string; conf: number }[]; like: number[]; reasons: string[] };
const COLD_PROMPT =
  "The orange line is a GPS route someone recorded while running; they were trying to draw a recognizable picture with their path (Strava art). What were they trying to draw? Reply exactly:\nGUESS: <1-4 words, or \"nothing recognizable\">\nCONFIDENCE: <0-10>";
const LIKE_PROMPT =
  "Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as an orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1 to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color or background. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>";
async function judge(renderJpg: Buffer, upload: string): Promise<Judge> {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: renderJpg.toString("base64") } };
  const cold: { guess: string; conf: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await claude([img, { type: "text", text: COLD_PROMPT }]);
    const guess = (t.match(/GUESS\**:?\**\s*(.+?)\s*(?:\n|\*|CONFIDENCE|$)/i)?.[1] ?? "").trim();
    cold.push({ guess: guess || "?", conf: Number(t.match(/CONFIDENCE\**:?\**\s*(\d+)/i)?.[1] ?? 0) });
  }
  const up = {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: (await sharp(upload).flatten({ background: "#fff" }).resize({ width: 700 }).jpeg({ quality: 88 }).toBuffer()).toString("base64"),
    },
  };
  const like: number[] = [];
  const reasons: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await claude([up, img, { type: "text", text: LIKE_PROMPT }]);
    like.push(Number(t.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
    reasons.push((t.match(/REASON:\s*(.+)/i)?.[1] ?? "").trim());
  }
  return { cold, like, reasons };
}

// ---------------------------------------------------------------------------
// seat scoring: curvature-weighted street support
// ---------------------------------------------------------------------------
type Sample = { p: UnitPt; w: number };
function sampleStrokes(plan: Plan, scale: number): Sample[] {
  const out: Sample[] = [];
  for (const s of plan.strokes) {
    const pts = s.pts;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * scale;
      const n = Math.max(1, Math.round(len / 70));
      let turn = 0;
      if (i >= 2) {
        const z = pts[i - 2]!;
        const a1 = Math.atan2(a[1] - z[1], a[0] - z[0]);
        const a2 = Math.atan2(b[1] - a[1], b[0] - a[0]);
        let dd = Math.abs(a2 - a1);
        if (dd > Math.PI) dd = 2 * Math.PI - dd;
        turn = dd;
      }
      const wv = 1 + 2.5 * Math.min(1, turn / (Math.PI / 2));
      for (let k = 0; k < n; k++) out.push({ p: [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], w: k === 0 ? wv : 1 });
    }
  }
  return out;
}

type Cand = { center: LatLng; scale: number; rot: number; score: number; plan: Plan; grid: number | null };

/** inverse of place(): lat/lng back to the unit frame of (center, scale, rot) */
function unplace(q: LatLng, center: LatLng, scaleM: number, rotDeg: number): UnitPt {
  const [ex, ny] = toXY(q, center);
  const rx = ex / scaleM;
  const ry = ny / scaleM;
  const r = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [rx * cos + ry * sin, -rx * sin + ry * cos];
}

/**
 * Elastic pre-warp: drag the placed drawing onto the streets with a smooth
 * deformation, then hand the warped strokes (back in unit space) to the
 * tracer, which now has an easy job.
 */
function elasticStrokes(g: PainterGraph, strokes: Plan["strokes"], center: LatLng, scale: number, rot: number) {
  const placed = strokes.map((s) => place(s.pts, center, scale, rot).map((p) => toXY(p, center)));
  let radius = 800;
  for (const pl of placed) for (const [x, y] of pl) radius = Math.max(radius, Math.hypot(x, y) + 500);
  const F = buildDistanceField(g, center, radius, 10, 160);
  const dense = placed.map((pl) => densify(pl, 40));
  const { samples, weights, thetas } = featureWeights(dense);
  const res = elasticFit(F, samples, { weights, thetas, alpha: ALPHA, beta: BETA, levels: LEVELS, iterations: 250 });
  const warped = strokes.map((s, i) => ({
    ...s,
    pts: placed[i]!.map((xy: XY) => unplace(fromXY(warpPoint(res.lattice, xy), center), center, scale, rot)),
  }));
  return { strokes: warped, res };
}

// ---------------------------------------------------------------------------
async function main() {
  await fs.mkdir(OUT, { recursive: true });
  try {
    KEY = (await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8")).match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  } catch {
    /* no key */
  }
  setHugTolerance(HUG_M);
  setBlockify(BLOCKIFY_ON);
  setTraceProfile({
    outline: { anchorM: num("anchor", TRACE.outline.anchorM), lambda: num("lambda", TRACE.outline.lambda), corridorM: num("corridor", TRACE.outline.corridorM), bendWeight: num("bend", TRACE.outline.bendWeight) },
    thin: { anchorM: num("anchor", TRACE.thin.anchorM), lambda: num("lambda", TRACE.thin.lambda), corridorM: num("corridor", TRACE.thin.corridorM), bendWeight: num("bend", TRACE.thin.bendWeight) },
    trimNubs: TRIM,
    gapWalkM: num("gapwalk", TRACE.gapWalkM),
  });
  console.log(`trace profile: outline ${JSON.stringify(TRACE.outline)} trim=${TRACE.trimNubs} gapwalk=${TRACE.gapWalkM} quantize=${QUANTIZE}`);
  const { mask, w, h } = await loadMask(IMG!, MASK_MODE);
  let ink = 0;
  for (let i = 0; i < w * h; i++) if (mask[i] === 255) ink++;
  console.log(`${NAME}: mask ${((ink / (w * h)) * 100).toFixed(1)}% ink (${MASK_MODE})`);
  console.log("loading graph…");
  const g = await loadPackedGraph(GRAPH);
  console.log(`graph: ${g.coord.length} nodes`);

  // ---- sweep ----
  const t0 = Date.now();
  const cands: Cand[] = [];
  const gate: Record<string, number> = { noinfo: 0, miss: 0, ok: 0 };
  for (const scale of SCALES) {
    const plan = makePlan(mask, w, h, scale, { pitchM: PITCH_M, rows: ROWS, openM: OPEN_M }, []);
    await planSheet(mask, w, h, plan, path.join(OUT, `plan-${scale}.png`));
    const nThin = plan.strokes.filter((s) => s.kind === "thin").length;
    const nOut = plan.strokes.filter((s) => s.kind === "outline").length;
    const nHatch = plan.strokes.filter((s) => s.kind === "hatch").length;
    console.log(`scale ${scale}: ${nOut} outline, ${nThin} thin, ${nHatch} hatch; mass ${((plan.massPx / ink) * 100).toFixed(0)}% of ink, ${plan.mPerPx.toFixed(1)} m/px`);
    if (!plan.strokes.length) continue;
    const samples = sampleStrokes(plan, scale);
    const pts = samples.map((s) => s.p);
    const wsum = samples.reduce((a, s) => a + s.w, 0);
    for (let lat = LAT0; lat <= LAT1; lat += STEP_LAT) {
      for (let lng = LNG0; lng <= LNG1; lng += STEP_LNG) {
        const info = localGridInfo(g, [lat, lng]);
        if (!info) {
          gate.noinfo!++;
          continue;
        }
        const rots: number[] = [];
        if (ROTS_OPT === "auto") {
          rots.push(info.rot);
          for (const r of [0, 15, -15, 30, -30]) if (!rots.some((x) => Math.abs(x - r) < 5)) rots.push(r);
        } else for (const r of ROTS_OPT.split(",").map(Number)) rots.push(r);
        for (const rot of rots) {
          const placed = place(pts, [lat, lng], scale, rot);
          let sum = 0;
          let miss = 0;
          const missCap = Math.max(3, Math.floor(placed.length * 0.03));
          let bad = false;
          for (let i = 0; i < placed.length; i++) {
            const { d } = nearestNode(g, placed[i]!);
            if (d > 130) {
              miss++;
              if (miss > missCap) {
                bad = true;
                break;
              }
            }
            sum += Math.min(d, 130) * samples[i]!.w;
          }
          if (bad) {
            gate.miss!++;
            continue;
          }
          gate.ok!++;
          cands.push({ center: [lat, lng], scale, rot, score: sum / wsum, plan, grid: info.uniform >= 0.55 ? info.axis : null });
        }
      }
    }
  }
  console.log(`sweep: ${Object.entries(gate).map(([k, v]) => `${k}=${v}`).join(" ")} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  cands.sort((a, b) => a.score - b.score);
  const shortlist: Cand[] = [];
  for (const c of cands) {
    if (shortlist.length >= N_ROUTE) break;
    if (shortlist.some((p) => meters(p.center, c.center) < 450 && p.scale === c.scale && Math.abs(p.rot - c.rot) < 10)) continue;
    shortlist.push(c);
  }
  console.log(`${cands.length} legal placements; routing ${shortlist.length}`);
  if (!shortlist.length) return;

  // ---- route ----
  const t1 = Date.now();
  const routed: { c: Cand; r: Routed }[] = [];
  let elasticLog = "";
  for (const c of shortlist) {
    let strokes = c.plan.strokes;
    if (ELASTIC) {
      const e = elasticStrokes(g, strokes, c.center, c.scale, c.rot);
      strokes = e.strokes;
      elasticLog += ` ${e.res.before.toFixed(0)}→${e.res.after.toFixed(0)}m(shift ${e.res.meanShift.toFixed(0)})`;
    }
    const r = routePlacement(g, orderStrokes(strokes), c.center, c.scale, c.rot, QUANTIZE);
    if (r) routed.push({ c, r });
  }
  if (ELASTIC) console.log(`elastic (street distance before→after per seat):${elasticLog}`);
  routed.sort((a, b) => a.r.fidelity - b.r.fidelity);
  console.log(`routed ${routed.length} in ${((Date.now() - t1) / 1000).toFixed(0)} s; best fidelity ${routed[0]?.r.fidelity.toFixed(1)} (dev ${routed[0]?.r.devM.toFixed(0)} m)`);
  {
    const top = routed.slice(0, 10);
    const mean = (f: (r: Routed) => number) => (top.reduce((a, x) => a + f(x.r), 0) / Math.max(1, top.length)).toFixed(2);
    console.log(`top10 stats: dev ${mean((r) => r.devM)} m, visible conn ${mean((r) => r.visibleConnKm)} km, conn ${mean((r) => r.connectorKm)} km, dropped ${mean((r) => r.dropped)}, ink ${mean((r) => r.inkKm)} km`);
  }
  const picks: { c: Cand; r: Routed }[] = [];
  for (const x of routed) {
    if (picks.length >= N_JUDGE) break;
    if (picks.some((p) => meters(p.c.center, x.c.center) < 700 && p.c.scale === x.c.scale)) continue;
    picks.push(x);
  }

  // ---- render + judge ----
  type Row = {
    pick: number;
    center: LatLng;
    scale: number;
    rot: number;
    grid: number | null;
    km: number;
    inkKm: number;
    connectorKm: number;
    visibleConnKm: number;
    dropped: number;
    strokes: number;
    devM: number;
    fidelity: number;
    judge: Judge | null;
    likeMean: number;
  };
  const rows: Row[] = [];
  for (let k = 0; k < picks.length; k++) {
    const { c, r } = picks[k]!;
    const tag = `${NAME}-${k}`;
    const gpx = r.chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
    await fs.writeFile(
      path.join(OUT, `${tag}.gpx`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso inkline" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${tag}</name><trkseg>\n${gpx}\n</trkseg></trk></gpx>\n`,
    );
    const jpg = await paleRender(r.chain, path.join(OUT, `${tag}.png`));
    await debugRender(r, path.join(OUT, `${tag}-dbg.png`));
    const where = c.grid !== null ? ` (grid ${c.grid}°)` : " (organic)";
    console.log(
      `pick ${k}: ${c.center.map((v) => v.toFixed(4)).join(",")} scale ${c.scale} rot ${c.rot}${where} | ${r.km.toFixed(1)} km (ink ${r.inkKm.toFixed(1)}, conn ${r.connectorKm.toFixed(1)}, visible ${r.visibleConnKm.toFixed(1)}), ${r.dropped}/${r.strokes} dropped, dev ${r.devM.toFixed(0)} m, fid ${r.fidelity.toFixed(1)}`,
    );
    let j: Judge | null = null;
    if (JUDGE && KEY) {
      j = await judge(jpg, IMG!);
      console.log(`   cold: ${j.cold.map((x) => `${x.guess} (${x.conf})`).join(" / ")}   likeness: ${j.like.join("/")}  — ${j.reasons[0]}`);
    }
    rows.push({
      pick: k,
      center: c.center,
      scale: c.scale,
      rot: c.rot,
      grid: c.grid,
      km: r.km,
      inkKm: r.inkKm,
      connectorKm: r.connectorKm,
      visibleConnKm: r.visibleConnKm,
      dropped: r.dropped,
      strokes: r.strokes,
      devM: r.devM,
      fidelity: r.fidelity,
      judge: j,
      likeMean: j ? j.like.reduce((a, b) => a + b, 0) / j.like.length : 0,
    });
  }
  const conf = (r: Row) => r.judge?.cold.reduce((x, y) => x + y.conf, 0) ?? 0;
  rows.sort((a, b) => b.likeMean - a.likeMean || conf(b) - conf(a));
  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(rows, null, 2));
  console.log("\n=== ranked by judge ===");
  for (const r of rows) console.log(`pick ${r.pick}: likeness ${r.judge?.like.join("/") ?? "-"} cold ${r.judge?.cold.map((x) => `${x.guess} ${x.conf}`).join(" / ") ?? "-"} | ${r.km.toFixed(1)} km`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
