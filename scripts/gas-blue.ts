// Gas badge via color-plane extraction: the art is saturated BLUE on a
// yellow disc. A blue-hue mask isolates pump+hose+person as one connected
// silhouette (luminance cuts grab disc edges and shred it). Then the
// standard lane: upright trace sweep → likeness-to-upload ≥8 → GPX.
// Usage: npx tsx scripts/gas-blue.ts
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { getStreetGraph, traceContour, place, toUnit, type NormalizedPoint, type LatLng } from "../lib/streetGraphTrace";
import { extractNormalizedContourFromLineMask } from "../lib/extractNormalizedContourFromLineMask";

const sharp = createRequire(path.join(process.cwd(), "package.json"))("sharp");
const OUT = "tmp-studio/gas-blue";
let KEY = "";

// Load the Brooklyn walk graph (same packed format as Manhattan's). The
// composition is wider than Manhattan at legible scale; Brooklyn's fine
// grid is where the reference art draws wide subjects.
async function getBrooklynGraph(): Promise<any> {
  const data = JSON.parse(await fs.readFile("tmp-wow/brooklyn-walk-graph.json", "utf8")) as { scale: number; lat: number[]; lng: number[]; edges: number[] };
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
  const CELL = 0.003;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(coord[i]![0] / CELL)}:${Math.round(coord[i]![1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  }
  return { coord, adj, grid };
}

function meters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180, dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const la = (a[0] * Math.PI) / 180, lb = (b[0] * Math.PI) / 180;
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2));
}

const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z; };
async function render(chain: LatLng[], file: string, w = 1200, h = 1000) {
  let zoom = 14;
  for (let z = 16; z >= 11; z--) {
    const xs = chain.map((p) => lonToX(p[1], z)), ys = chain.map((p) => latToY(p[0], z));
    if (Math.max(...xs) - Math.min(...xs) <= w * 0.82 && Math.max(...ys) - Math.min(...ys) <= h * 0.82) { zoom = z; break; }
  }
  const xs = chain.map((p) => lonToX(p[1], zoom)), ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: any[] = [];
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) {
    for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
      const res = await fetch(`https://a.basemaps.cartocdn.com/light_all/${zoom}/${tx}/${ty}@2x.png`, { headers: { "User-Agent": "pace-casso route preview (dev)" } });
      if (!res.ok) continue;
      tiles.push({ input: await sharp(Buffer.from(await res.arrayBuffer())).resize(TILE, TILE).toBuffer(), left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
    }
  }
  const d = chain.map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
  const overlay = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="#fc5200" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eaeaea" } }).composite([...tiles, { input: overlay, left: 0, top: 0 }]).png().toFile(file);
}

const GAS_NAMES = ["gas", "pump", "fuel", "refuel", "nozzle", "petrol", "gasoline"];
const gasNamed = (guess: string) => GAS_NAMES.some((n) => guess.toLowerCase().includes(n));

async function coldName(file: string, kind: string): Promise<{ guess: string; confidence: number }[]> {
  const img = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(file).resize({ width: 1100 }).jpeg({ quality: 85 }).toBuffer()).toString("base64") } };
  const prompt = `${kind} What does it depict? Reply exactly:\nGUESS: <1-4 words, or "nothing recognizable">\nCONFIDENCE: <0-10>`;
  const out: { guess: string; confidence: number }[] = [];
  for (let i = 0; i < 3; i++) {
    let guess = "", confidence = 0;
    for (let attempt = 0; attempt < 2 && !guess; attempt++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-fable-5", max_tokens: 1024, messages: [{ role: "user", content: [img, { type: "text", text: prompt }] }] }),
      });
      const json: any = await res.json();
      const text = (json.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
      guess = (text.match(/GUESS:\s*(.+?)(?:\n|CONFIDENCE)/i)?.[1] ?? "").trim();
      confidence = Number(text.match(/CONFIDENCE:\s*(\d+)/i)?.[1] ?? 0);
    }
    out.push({ guess: guess || "no response", confidence });
  }
  return out;
}

async function likeness(renderFile: string): Promise<number[]> {
  const a = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp("gas.png").resize({ width: 700 }).flatten({ background: "#fff" }).jpeg({ quality: 88 }).toBuffer()).toString("base64") } };
  const b = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: (await sharp(renderFile).resize({ width: 1100 }).jpeg({ quality: 85 }).toBuffer()).toString("base64") } };
  const prompt = `Image 1 is a picture a customer uploaded. Image 2 is a GPS running route drawn as a thin orange line on a city street map. Score how clearly Image 2 depicts the SAME subject as Image 1, to a stranger: 0 = unrelated or shapeless, 5 = related but distorted, 10 = unmistakably the same. Judge shape identity, not color; the badge circle is background, judge the figures. Reply exactly:\nSCORE: <0-10>\nREASON: <under 12 words>`;
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: 512, messages: [{ role: "user", content: [a, b, { type: "text", text: prompt }] }] }),
    });
    const json: any = await res.json();
    const text = (json.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
    out.push(Number(text.match(/SCORE:\s*(\d+)/i)?.[1] ?? 0));
  }
  return out;
}

async function main() {
  const env = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
  KEY = env.match(/^ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
  await fs.mkdir(OUT, { recursive: true });

  const BOX = 300;
  const { data, info } = await sharp("gas.png").flatten({ background: "#ffffff" }).resize(BOX, BOX, { fit: "contain", background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(BOX * BOX);
  let ink = 0;
  for (let i = 0; i < BOX * BOX; i++) {
    const r = data[i * info.channels], g = data[i * info.channels + 1], b = data[i * info.channels + 2];
    if (b > 60 && b > r * 1.25 && b > g * 1.25) { mask[i] = 255; ink++; }
  }
  console.log(`blue mask ink fraction: ${(ink / (BOX * BOX) * 100).toFixed(1)}%`);
  // The art is ONE connected blob (the hose links pump and figure). Erode a
  // few pixels so the thin hose vanishes, leaving pump/figure cores as
  // markers; watershed-assign every ink pixel to its nearest marker. The
  // hose pixels split between the two regions, whose outer rings absorb a
  // stub of it each — the thin ribbon itself never reaches the tracer.
  const eroded = new Uint8Array(mask);
  for (let round = 0; round < 5; round++) {
    const next = new Uint8Array(eroded);
    for (let i = 0; i < BOX * BOX; i++) {
      if (eroded[i] !== 255) continue;
      const x = i % BOX, y = (i / BOX) | 0;
      if (x === 0 || y === 0 || x === BOX - 1 || y === BOX - 1 ||
          eroded[i - 1] !== 255 || eroded[i + 1] !== 255 || eroded[i - BOX] !== 255 || eroded[i + BOX] !== 255) {
        next[i] = 0;
      }
    }
    eroded.set(next);
  }
  // Morphological OPENING: dilate the eroded mask back so fat shapes (pump,
  // figure) recover their outlines while thin structures (the hose) stay
  // gone. The hose = mask minus opened, handled separately as a centerline.
  const opened = new Uint8Array(eroded);
  for (let round = 0; round < 5; round++) {
    const next = new Uint8Array(opened);
    for (let i = 0; i < BOX * BOX; i++) {
      if (opened[i] === 255) continue;
      if (mask[i] !== 255) continue; // never grow beyond original ink
      const x = i % BOX;
      for (const q of [i - 1, i + 1, i - BOX, i + BOX]) {
        if (q < 0 || q >= BOX * BOX || Math.abs((q % BOX) - x) > 1) continue;
        if (opened[q] === 255) { next[i] = 255; break; }
      }
    }
    opened.set(next);
  }
  const hoseMask = new Uint8Array(BOX * BOX);
  let hoseInk = 0;
  for (let i = 0; i < BOX * BOX; i++) if (mask[i] === 255 && opened[i] !== 255) { hoseMask[i] = 255; hoseInk++; }
  console.log(`opening: hose pixels ${hoseInk}`);
  const labels = new Int32Array(BOX * BOX);
  let nextLabel = 0;
  const stack: number[] = [];
  const comps: { label: number; count: number; minX: number }[] = [];
  for (let i = 0; i < BOX * BOX; i++) {
    if (opened[i] !== 255 || labels[i] !== 0) continue;
    nextLabel++;
    const comp = { label: nextLabel, count: 0, minX: BOX };
    stack.push(i);
    labels[i] = nextLabel;
    while (stack.length) {
      const p = stack.pop()!;
      comp.count++;
      const x = p % BOX;
      if (x < comp.minX) comp.minX = x;
      for (const q of [p - 1, p + 1, p - BOX, p + BOX]) {
        if (q < 0 || q >= BOX * BOX || Math.abs((q % BOX) - x) > 1) continue;
        if (opened[q] === 255 && labels[q] === 0) { labels[q] = nextLabel; stack.push(q); }
      }
    }
    if (comp.count > 80) comps.push(comp);
  }
  comps.sort((a, b) => b.count - a.count);
  comps.length = Math.min(comps.length, 2);
  comps.sort((a, b) => a.minX - b.minX); // reading order, left to right
  console.log(`opened regions: ${comps.map((c) => c.count).join(", ")}`);
  const resampleN = (line: NormalizedPoint[], N: number) => {
    const lens = [0];
    for (let i = 1; i < line.length; i++) lens.push(lens[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y));
    const total = lens[lens.length - 1] || 1;
    const out: NormalizedPoint[] = [];
    for (let k = 0; k < N; k++) {
      const t = (k / (N - 1)) * total;
      let i = 1;
      while (i < lens.length - 1 && lens[i] < t) i++;
      const f = (t - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
      out.push({ x: line[i - 1].x + (line[i].x - line[i - 1].x) * f, y: line[i - 1].y + (line[i].y - line[i - 1].y) * f });
    }
    return out;
  };

  // Region pieces: fill interior holes first (the pump's window otherwise
  // gets woven into the ring as a C-shape), then take the OUTER ring only.
  const regionMasks: Uint8Array[] = [];
  const pieces: NormalizedPoint[][] = [];
  for (const comp of comps) {
    const one = new Uint8Array(BOX * BOX);
    for (let i = 0; i < BOX * BOX; i++) if (labels[i] === comp.label) one[i] = 255;
    // flood-fill the background from the border; unreached zeros = holes
    const outside = new Uint8Array(BOX * BOX);
    const q: number[] = [];
    for (let x = 0; x < BOX; x++) { q.push(x, (BOX - 1) * BOX + x); }
    for (let y = 0; y < BOX; y++) { q.push(y * BOX, y * BOX + BOX - 1); }
    for (const s of q) if (one[s] !== 255) outside[s] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi];
      if (one[p] === 255) continue;
      const x = p % BOX;
      for (const n of [p - 1, p + 1, p - BOX, p + BOX]) {
        if (n < 0 || n >= BOX * BOX || Math.abs((n % BOX) - x) > 1) continue;
        if (one[n] !== 255 && !outside[n]) { outside[n] = 1; q.push(n); }
      }
    }
    for (let i = 0; i < BOX * BOX; i++) if (one[i] !== 255 && !outside[i]) one[i] = 255; // fill holes
    regionMasks.push(one);
    const ring = extractNormalizedContourFromLineMask(one, 0.22, BOX, BOX, { source: "silhouette-outline" });
    if (ring && ring.length >= 8) pieces.push(ring);
    // The pump's WINDOW is its identity feature — a plain rectangle cold-reads
    // as a box/animal body. Holes must come from the ORIGINAL mask (opening
    // erodes the pump's thin wall and merges the window with the outside).
    if (pieces.length === 1) {
      const outsideO = new Uint8Array(BOX * BOX);
      const qo: number[] = [];
      for (let x = 0; x < BOX; x++) qo.push(x, (BOX - 1) * BOX + x);
      for (let y = 0; y < BOX; y++) qo.push(y * BOX, y * BOX + BOX - 1);
      for (const s of qo) if (mask[s] !== 255) outsideO[s] = 1;
      for (let qi = 0; qi < qo.length; qi++) {
        const p = qo[qi];
        if (mask[p] === 255) continue;
        const x = p % BOX;
        for (const n of [p - 1, p + 1, p - BOX, p + BOX]) {
          if (n < 0 || n >= BOX * BOX || Math.abs((n % BOX) - x) > 1) continue;
          if (mask[n] !== 255 && !outsideO[n]) { outsideO[n] = 1; qo.push(n); }
        }
      }
      let bx0 = BOX, bx1 = 0, by0 = BOX, by1 = 0;
      for (let i = 0; i < BOX * BOX; i++) {
        if (labels[i] === comp.label) {
          const x = i % BOX, y = (i / BOX) | 0;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
      const holes = new Uint8Array(BOX * BOX);
      let holeCount = 0;
      // only holes inside THIS region's bbox (the pump)
      for (let i = 0; i < BOX * BOX; i++) {
        const x = i % BOX, y = (i / BOX) | 0;
        if (mask[i] !== 255 && !outsideO[i] && x >= bx0 && x <= bx1 && y >= by0 && y <= by1) { holes[i] = 255; holeCount++; }
      }
      console.log(`pump interior holes: ${holeCount} px`);
      if (holeCount > 400 && process.env.SKIP_WINDOW !== "1") {
        const holeRing = extractNormalizedContourFromLineMask(holes, 0.22, BOX, BOX, { source: "silhouette-outline" });
        if (holeRing && holeRing.length >= 8) {
          // Exaggerate ~1.35x around its center — a window under 2 blocks
          // wide cannot survive streets, and bigger reads better anyway.
          const cx = holeRing.reduce((a, p) => a + p.x, 0) / holeRing.length;
          const cy = holeRing.reduce((a, p) => a + p.y, 0) / holeRing.length;
          pieces.push(holeRing.map((p) => ({ x: cx + (p.x - cx) * 1.35, y: cy + (p.y - cy) * 1.35 })));
          console.log(`interior window ring added (exaggerated 1.35x)`);
        }
      }
    }
  }

  // Hose centerline: split its ring at the two points TOUCHING the pump and
  // figure regions (its natural end caps), average the two arcs — this
  // follows the loop instead of shortcutting it (farthest-point splitting
  // straightened the loop into a diagonal).
  if (hoseInk > 200 && regionMasks.length === 2) {
    const ring = extractNormalizedContourFromLineMask(hoseMask, 0.22, BOX, BOX, { source: "silhouette-outline" });
    if (ring && ring.length >= 10) {
      const distToMask = (p: NormalizedPoint, m: Uint8Array) => {
        // sample the mask in a small window around p (normalized coords → px)
        const px = Math.round(p.x * (BOX - 1)), py = Math.round(p.y * (BOX - 1));
        let best = Infinity;
        for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) {
          const x = px + dx, y = py + dy;
          if (x < 0 || y < 0 || x >= BOX || y >= BOX) continue;
          if (m[y * BOX + x] === 255) best = Math.min(best, Math.hypot(dx, dy));
        }
        return best;
      };
      let capA = 0, capB = 0, dA = Infinity, dB = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const da = distToMask(ring[i], regionMasks[0]);
        const db = distToMask(ring[i], regionMasks[1]);
        if (da < dA) { dA = da; capA = i; }
        if (db < dB) { dB = db; capB = i; }
      }
      const [lo, hi] = capA < capB ? [capA, capB] : [capB, capA];
      const arc1 = ring.slice(lo, hi + 1);
      const arc2 = [...ring.slice(hi), ...ring.slice(0, lo + 1)].reverse();
      if (arc1.length > 4 && arc2.length > 4) {
        const A = resampleN(arc1, 50), B = resampleN(arc2, 50);
        let centerline = A.map((p, i) => ({ x: (p.x + B[i].x) / 2, y: (p.y + B[i].y) / 2 }));
        if (capB < capA) centerline = centerline.reverse(); // pump-side first
        pieces.splice(pieces.length - 1, 0, centerline); // just before the figure
        console.log(`hose centerline via cap-split: ${centerline.length} pts (caps ${dA.toFixed(0)}px/${dB.toFixed(0)}px from regions)`);
      }
    }
  }
  // SPREAD: every era's gas failure shares one perceptual root — pump and
  // figure sit adjacent and merge into one animal silhouette ("dog",
  // "reindeer"). Separate them; the hose stretches as the natural long
  // connector, keeping the story readable as pump → hose → person.
  const SPREAD = Number(process.env.SPREAD ?? 0);
  if (SPREAD > 0 && pieces.length >= 3) {
    const fi = pieces.length - 1, hi = pieces.length - 2; // figure, hose
    const dx = SPREAD, dy = SPREAD * 0.35;
    pieces[fi] = pieces[fi].map((p) => ({ x: p.x + dx, y: p.y + dy }));
    const N = pieces[hi].length;
    pieces[hi] = pieces[hi].map((p, i) => ({ x: p.x + (i / (N - 1)) * dx, y: p.y + (i / (N - 1)) * dy }));
    console.log(`spread applied: figure offset +${dx}/${dy.toFixed(2)}, hose stretched`);
  }
  // FIGURE REDRAW: verbatim boxes and lines read fine, but the figure's
  // story features (nozzle to head, headphones) dissolve at street scale —
  // the July lesson. Have the designer redraw ONLY the figure with those
  // features exaggerated, in the same bbox; pump/window/hose stay verbatim.
  if (process.env.FIGURE_REDRAW === "1") {
    const cache = path.join(OUT, "figure-redraw.json");
    let redrawn: NormalizedPoint[] | null = null;
    try {
      redrawn = JSON.parse(await fs.readFile(cache, "utf8"));
    } catch {
      const fig = pieces[pieces.length - 1];
      const fx0 = Math.min(...fig.map((p) => p.x)), fx1 = Math.max(...fig.map((p) => p.x));
      const fy0 = Math.min(...fig.map((p) => p.y)), fy1 = Math.max(...fig.map((p) => p.y));
      // render figure crop for the designer
      // the SPREAD offset was applied to the piece; the image crop must use
      // the figure's ORIGINAL location
      const sdx = SPREAD > 0 ? SPREAD : 0, sdy = SPREAD > 0 ? SPREAD * 0.35 : 0;
      const figPx = { left: Math.max(0, Math.round((fx0 - sdx) * BOX) - 6), top: Math.max(0, Math.round((fy0 - sdy) * BOX) - 6), width: Math.min(BOX, Math.round((fx1 - fx0) * BOX) + 12), height: Math.min(BOX, Math.round((fy1 - fy0) * BOX) + 12) };
      const crop = await sharp("gas.png").flatten({ background: "#ffffff" }).resize(BOX, BOX, { fit: "contain", background: "#ffffff" }).extract(figPx).resize({ width: 500 }).jpeg({ quality: 88 }).toBuffer();
      const prompt = `This is a stick figure holding a gas-pump nozzle to its head, wearing headphones. Redraw it as ONE closed one-line silhouette for GPS street art. Hard rules: exaggerate the identity features — the HEAD large (≥25% of the figure's height) with the HEADPHONE band clearly bulging over it, the NOZZLE drawn as a chunky pistol shape touching the head, the raised ARM thick; legs plain and thick; nothing thinner than 8% of the figure's height; at most 30 vertices; the silhouette must remain one closed ring. Output STRICT JSON only: {"polyline": [[x,y],...]} with coordinates in 0-1 relative to this image (y down), first point = last point.`;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-fable-5", max_tokens: 8000, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: crop.toString("base64") } }, { type: "text", text: prompt }] }] }),
      });
      const json: any = await res.json();
      const text = (json.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      // map designer 0-1 coords into the figure's bbox in canvas frame
      redrawn = (parsed.polyline as [number, number][]).map(([x, y]) => ({ x: fx0 + x * (fx1 - fx0), y: fy0 + y * (fy1 - fy0) }));
      await fs.writeFile(cache, JSON.stringify(redrawn));
    }
    if (redrawn && redrawn.length >= 10) {
      pieces[pieces.length - 1] = redrawn;
      console.log(`figure redrawn by designer: ${redrawn.length} pts (cached)`);
    }
  }
  // Rotate each closed ring so consecutive pieces join with the shortest
  // chord (which lands roughly where the hose ran). An unrotated join once
  // slashed a diagonal across the pump.
  const rotateRing = (ring: NormalizedPoint[], near: NormalizedPoint) => {
    const closed = Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].y - ring[ring.length - 1].y) < 0.02;
    if (!closed) {
      // open stroke (hose centerline): only choose direction, never rotate
      const dStart = Math.hypot(ring[0].x - near.x, ring[0].y - near.y);
      const dEnd = Math.hypot(ring[ring.length - 1].x - near.x, ring[ring.length - 1].y - near.y);
      return dEnd < dStart ? [...ring].reverse() : ring;
    }
    const core = ring.slice(0, -1);
    let k = 0, bd = Infinity;
    for (let i = 0; i < core.length; i++) {
      const d = Math.hypot(core[i].x - near.x, core[i].y - near.y);
      if (d < bd) { bd = d; k = i; }
    }
    const out = [...core.slice(k), ...core.slice(0, k)];
    out.push(out[0]);
    return out;
  };
  for (let i = 1; i < pieces.length; i++) {
    const prevEnd = pieces[i - 1][pieces[i - 1].length - 1];
    pieces[i] = rotateRing(pieces[i], prevEnd);
    if (i === 1) {
      // also rotate the FIRST ring so its end sits nearest the second's start
      pieces[0] = rotateRing(pieces[0], pieces[1][0]);
    }
  }
  // Simplify each piece: sub-2%-of-span jags (headphone bumps, pixel
  // scallops) tangle at street scale and add nothing a stranger reads.
  const rdp = (pts: NormalizedPoint[], eps: number): NormalizedPoint[] => {
    if (pts.length < 3) return pts;
    const d2seg = (p: NormalizedPoint, a: NormalizedPoint, b: NormalizedPoint) => {
      const vx = b.x - a.x, vy = b.y - a.y;
      const L2 = vx * vx + vy * vy || 1e-12;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2));
      return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
    };
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const st: [number, number][] = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop()!;
      let mi = -1, md = 0;
      for (let i = a + 1; i < b; i++) {
        const d = d2seg(pts[i], pts[a], pts[b]);
        if (d > md) { md = d; mi = i; }
      }
      if (mi >= 0 && md > eps) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i] === 1);
  };
  for (let i = 0; i < pieces.length; i++) {
    const before = pieces[i].length;
    pieces[i] = rdp(pieces[i], 0.012);
    if (pieces[i].length < before) console.log(`simplified piece ${i}: ${before} → ${pieces[i].length} pts`);
  }
  const contour: NormalizedPoint[] = pieces.flat();
  if (contour.length < 30) throw new Error("extraction failed");
  console.log(`contour: ${contour.length} pts from ${pieces.length} pieces`);
  // sketch for stage-A inspection
  {
    const xs = contour.map((p) => p.x), ys = contour.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
    const pts = contour.map((p) => `${(60 + ((p.x - minX) * 880) / span).toFixed(1)},${(60 + ((p.y - minY) * 880) / span).toFixed(1)}`).join(" ");
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="100%" height="100%" fill="white"/><polyline points="${pts}" fill="none" stroke="black" stroke-width="5" stroke-linejoin="round"/></svg>`)).png().toFile(path.join(OUT, "sketch.png"));
  }
  await fs.writeFile(path.join(OUT, "contour.json"), JSON.stringify(contour));
  await fs.writeFile(path.join(OUT, "pieces.json"), JSON.stringify(pieces));
  // Stage-A: the composition must cold-read as gas/pump before streets.
  const stageA = await coldName(path.join(OUT, "sketch.png"), "This is a one-line drawing.");
  console.log(`stage-A: ${stageA.map((v) => `"${v.guess}" ${v.confidence}`).join(" | ")}`);
  // Pre-gate at 2/3: it exists to save compute, not to accept. The FINAL
  // keeper gate (route cold-named 3/3 + likeness ≥8) stays strict.
  if (stageA.filter((v) => gasNamed(v.guess)).length < 2) {
    console.log("stage-A failed — composition does not read as gas yet; stopping honestly.");
    return;
  }

  const BROOKLYN = process.env.BROOKLYN === "1";
  const g: any = BROOKLYN ? await getBrooklynGraph() : await getStreetGraph();
  console.log(`graph: ${BROOKLYN ? "brooklyn" : "manhattan"}, ${g.coord.length} nodes`);
  const unit = toUnit(contour);
  // Per-piece unit slices in the SHARED frame (relative layout preserved).
  const unitPieces: [number, number][][] = [];
  {
    let off = 0;
    for (const p of pieces) {
      unitPieces.push(unit.slice(off, off + p.length) as [number, number][]);
      off += p.length;
    }
  }
  const nearestNodeId = (p: LatLng): number => {
    let best = -1, bd = Infinity;
    // grid-accelerated: search 3x3 cells around p
    const CELL = 0.003;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = `${Math.round(p[0] / CELL) + dy}:${Math.round(p[1] / CELL) + dx}`;
      for (const i of (g.grid.get(k) ?? [])) {
        const d = meters(g.coord[i], p);
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  };
  const shortestPath = (a: number, b: number): LatLng[] | null => {
    if (a < 0 || b < 0) return null;
    const dist = new Map<number, number>([[a, 0]]);
    const came = new Map<number, number>();
    const open = new Map<number, number>([[a, meters(g.coord[a], g.coord[b])]]);
    const done = new Set<number>();
    let guard = 0;
    while (open.size && guard++ < 200000) {
      let cur = -1, cf = Infinity;
      for (const [n, f] of open) if (f < cf) { cf = f; cur = n; }
      if (cur === b) {
        const out = [b];
        let w = b;
        while (came.has(w)) { w = came.get(w)!; out.push(w); }
        return out.reverse().map((n) => g.coord[n]);
      }
      open.delete(cur);
      done.add(cur);
      for (const { to, w } of g.adj[cur] ?? []) {
        if (done.has(to)) continue;
        const t = dist.get(cur)! + w;
        if (t < (dist.get(to) ?? Infinity)) {
          dist.set(to, t);
          came.set(to, cur);
          open.set(to, t + meters(g.coord[to], g.coord[b]));
        }
      }
    }
    return null;
  };
  const cands: any[] = [];
  // The composition is WIDE (pump→figure ≈ 74% of canvas): at half-size
  // 2000+ it spans ~3 km — Manhattan's full width — and the pump drowned in
  // the Hudson at every placement. Smaller scales, plus the grid tilt so
  // the wide art can lie along the island's diagonal axis.
  for (const scale of BROOKLYN ? [1600, 2000, 2400, 2900] : [1150, 1400, 1700, 2050]) {
    for (const rot of [0, 15, 29, -15]) {
      for (let lat = BROOKLYN ? 40.63 : 40.715; lat <= (BROOKLYN ? 40.735 : 40.78); lat += 0.008) {
        for (let lng = BROOKLYN ? -74.0 : -74.005; lng <= (BROOKLYN ? -73.89 : -73.95); lng += 0.008) {
          // Trace each piece SEPARATELY (the strava recipe: 0→37 survivors);
          // jump chords are never part of the strict-coverage target.
          const center: LatLng = [lat, lng];
          const chains: LatLng[][] = [];
          let ok = true;
          let windowOk = true;
          for (let pi = 0; pi < unitPieces.length; pi++) {
            const up = unitPieces[pi];
            // the window is piece index 1 when 4 pieces exist — OPTIONAL:
            // its failure must not kill an otherwise good placement.
            const isWindow = unitPieces.length === 4 && pi === 1;
            const target = place(up as any, center, scale, rot);
            const closed = meters(target[0], target[target.length - 1]) < 40;
            // Dual cadence per piece: sparse anchors give a simple box (the
            // pump) long deliberate edges; fine anchors keep the figure's
            // pose. Keep whichever hugs the target better per unit length.
            let bestChain: LatLng[] | null = null;
            let bestScore = -1;
            for (const anchorM of [110, 300]) {
              const r = traceContour(g, target, { anchorM, lambda: 12, corridorM: 90, closeLoop: closed });
              if (!r.chain.length || r.coverage < 0.999999 || r.maxGapM > 0) continue;
              const lenM = r.chain.slice(1).reduce((a, p, i) => a + meters(r.chain[i], p), 0);
              const targetM = target.slice(1).reduce((a, p, i) => a + meters(target[i], p), 0);
              const economy = targetM > 0 ? Math.min(1, targetM / Math.max(1, lenM)) : 0;
              if (economy > bestScore) { bestScore = economy; bestChain = r.chain; }
            }
            if (!bestChain) {
              if (isWindow) { windowOk = false; continue; }
              (globalThis as any).__pieceFails = (globalThis as any).__pieceFails ?? {};
              (globalThis as any).__pieceFails[pi] = ((globalThis as any).__pieceFails[pi] ?? 0) + 1;
              ok = false;
              break;
            }
            chains.push(bestChain);
          }
          if (!ok) continue;
          // connect pump→hose→figure with real street paths, each ≤500 m
          const full: LatLng[] = [...chains[0]];
          let connOk = true;
          for (let i = 1; i < chains.length; i++) {
            const conn = shortestPath(nearestNodeId(full[full.length - 1]), nearestNodeId(chains[i][0]));
            if (!conn) { connOk = false; break; }
            const connM = conn.slice(1).reduce((a, p, j) => a + meters(conn[j], p), 0);
            // Window hops cross the pump's own interior (reads as paneling)
            // and legitimately run longer than inter-object connectors.
            const hopCap = windowOk && chains.length === 4 && (i === 1 || i === 2) ? 1100 : 500;
            if (connM > hopCap) { connOk = false; break; }
            full.push(...conn.slice(1), ...chains[i].slice(1));
          }
          if (!connOk) continue;
          const km = full.slice(1).reduce((a, p, i) => a + meters(full[i], p), 0) / 1000;
          // The composition carries ~29 km of ink at even the smallest legible
          // scale — Ralph's rule: never trade recognizability for distance.
          if (km < 8 || km > 62) continue;
          cands.push({ center, scale, rot, chain: full, km, windowOk });
        }
      }
    }
  }
  console.log(`surviving placements: ${cands.length}; piece fails: ${JSON.stringify((globalThis as any).__pieceFails ?? {})}`);
  // Bigger scale = more legible features; judge a DIVERSE set (spread over
  // scales, rotations, and locations), not the six smallest routes.
  cands.sort((a, b) => Number(b.windowOk) - Number(a.windowOk) || b.scale - a.scale || Math.abs(a.rot) - Math.abs(b.rot));
  const diverse: typeof cands = [];
  for (const cand of cands) {
    if (diverse.some((d) => d.scale === cand.scale && Math.abs(d.rot - cand.rot) < 5 && meters(d.center, cand.center) < 2500)) continue;
    diverse.push(cand);
    if (diverse.length >= 10) break;
  }
  for (let c = 0; c < diverse.length; c++) {
    const cand = diverse[c];
    const file = path.join(OUT, `cand-${c}.png`);
    await render(cand.chain, file);
    const scores = await likeness(file);
    const names = await coldName(file, "The orange line is a GPS route someone recorded while running - they were trying to \"draw\" a recognizable picture with their path (Strava art).");
    const namedRight = names.filter((v) => gasNamed(v.guess)).length;
    console.log(`cand-${c}: rot=${cand.rot} scale=${cand.scale} km=${cand.km.toFixed(1)} likeness=${scores.join("/")} cold=${names.map((v) => `"${v.guess}" ${v.confidence}`).join(" | ")} → ${namedRight}/3 named`);
    // Ralph's acceptance test: recognizable = cold-named gas 3/3 AND
    // likeness ≥8 on every sample. Nothing in between gets shown.
    if (Math.min(...scores) >= 8 && namedRight === 3) {
      const gpx = cand.chain.map(([la, ln]: LatLng) => `<trkpt lat="${la.toFixed(6)}" lon="${ln.toFixed(6)}"/>`).join("\n");
      await fs.writeFile(path.join(OUT, "keeper.gpx"), `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="pace-casso studio" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>gas badge figures</name><trkseg>\n${gpx}\n</trkseg></trk>\n</gpx>\n`);
      console.log("KEEPER at the 8+ bar:", file);
      break;
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
