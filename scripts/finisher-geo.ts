/**
 * FINISHER-GEO — the finisher with the model taken out of the loop.
 *
 * Same drawing state and edit moves as scripts/finisher.ts, but every
 * candidate is scored by lib/strokeLikeness (render-and-compare against the
 * uploaded drawing, distance transforms, ~5 ms) instead of by the vision
 * judge (several paid calls per move). ZERO model calls. Because scoring is
 * free the search can be much wider: a city-wide seat sweep over several
 * sizes and every near-upright grid orientation, then a long greedy climb on the best
 * seats. The output is a draft for a human to look at and edit
 * (scripts/finisher-edit.ts takes the summary.json).
 *
 * Usage:
 *   npx tsx scripts/finisher-geo.ts gas.png --mask=blue --name=gas-geo --sweep=1
 *       [--scales=1300,1700,2200] [--step=700] [--bbox=40.56,-74.05,40.81,-73.75]
 *       [--top=4] [--iters=500] [--minutes=120] [--maxkm=45] [--tol=0.09] [--maxrot=40] [--seed=1]
 *   npx tsx scripts/finisher-geo.ts gas.png --mask=blue --name=gas-geo2 \
 *       --resume=tmp-finisher/gas-fin2/summary.json --iters=800 [--fixed=1]
 *   npx tsx scripts/finisher-geo.ts gas.png --mask=blue --center=40.73,-73.992 --scale=1300 --rot=-28
 */
import fs from "node:fs/promises";
import path from "node:path";
import { place, type LatLng } from "../lib/streetGraphTrace";
import { localGridInfo, makePlan, nearestNode, orderStrokes, routePlacement, setHugTolerance, setTraceProfile, type PainterGraph, type Routed, type Stroke } from "../lib/strokePainter";
import { buildTarget, coverageMap, likenessAgainst, type Likeness, type Target } from "../lib/strokeLikeness";
import { loadMask, loadPackedGraph, makeRng, paleRender, propose, rdp, sharp, sideBySide, writeGpx, type State } from "./finisher-shared";

const argv = process.argv.slice(2);
const IMG = argv.find((a) => !a.startsWith("--"));
const opt = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
if (!IMG) {
  console.log("usage: npx tsx scripts/finisher-geo.ts <image> --mask=.. --name=.. (--sweep=1 | --resume=summary.json | --center=lat,lng --scale=.. --rot=..)");
  process.exit(1);
}
const NAME = opt("name", path.basename(IMG).replace(/\.[^.]+$/, "") + "-geo");
const MASK_MODE = opt("mask", "ink");
const GRAPH = opt("graph", "tmp-painter/nyc-core-walk-graph.json");
const OPEN_M = Number(opt("open", "60"));
const HUG_M = Number(opt("hug", "90"));
const ITERS = Number(opt("iters", "500"));
const MINUTES = Number(opt("minutes", "120"));
const MAX_KM = Number(opt("maxkm", "45"));
const TOL_U = Number(opt("tol", "0.09")); // fraction of the drawing's half-span
const MAX_ROT = Number(opt("maxrot", "40")); // degrees from north-up; a sideways logo is unreadable whatever the score says
const SWEEP = opt("sweep", "0") === "1";
const SCALES = opt("scales", "1300,1700,2200").split(",").map(Number);
const STEP_M = Number(opt("step", "700"));
const BBOX = opt("bbox", "40.56,-74.05,40.81,-73.75").split(",").map(Number) as [number, number, number, number];
const TOP = Number(opt("top", "4"));
const RESUME = opt("resume", "");
const FIXED = opt("fixed", "0") === "1";
const SIMPLIFY = Number(opt("simplify", "0")); // pre-simplify strokes: RDP tolerance in short blocks (0 = off)
const OUT = path.join(process.cwd(), "tmp-finisher", NAME);
const rnd = makeRng(Number(opt("seed", "1")));

const log: string[] = [];
const say = (s: string) => {
  console.log(s);
  log.push(s);
};
const t0 = Date.now();
const minutes = () => (Date.now() - t0) / 60000;

type Eval = { r: Routed; lk: Likeness };
const normRot = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
/** grid-aligned orientations that keep the drawing near upright */
function uprightRots(gridRot: number): number[] {
  const out: number[] = [];
  for (const k of [0, 90, -90, 180]) {
    const a = normRot(gridRot + k);
    if (Math.abs(a) <= MAX_ROT && !out.some((b) => Math.abs(b - a) < 1)) out.push(a);
  }
  return out;
}
function evaluate(g: PainterGraph, t: Target, st: State): Eval | null {
  if (Math.abs(normRot(st.rot)) > MAX_ROT) return null;
  const r = routePlacement(g, orderStrokes(st.strokes), st.center, st.scale, st.rot, false);
  if (!r || r.dropped > 0 || r.maxGap > 400 || r.km > MAX_KM) return null;
  return { r, lk: likenessAgainst(t, r.chain, { center: st.center, scale: st.scale, rot: st.rot }, { tolU: TOL_U }) };
}
const fmt = (e: Eval) => `geo ${e.lk.score.toFixed(1)} (r ${e.lk.recall.toFixed(2)} p ${e.lk.precision.toFixed(2)}) ${e.r.km.toFixed(1)} km`;

/** cheap land check: centre and four corners of the footprint must sit near a walkable node */
function onLand(g: PainterGraph, center: LatLng, scale: number, rot: number): boolean {
  const probes = place([[0, 0], [-0.7, -0.7], [0.7, -0.7], [0.7, 0.7], [-0.7, 0.7]], center, scale, rot);
  return probes.every((p) => nearestNode(g, p).d < 250);
}

async function sweep(g: PainterGraph, t: Target, mask: Uint8Array, w: number, h: number): Promise<{ st: State; ev: Eval }[]> {
  const [lat1, lng1, lat2, lng2] = BBOX;
  const dLat = STEP_M / 111320;
  const dLng = STEP_M / (111320 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180));
  const found: { st: State; ev: Eval }[] = [];
  let tried = 0, skipped = 0, unroutable = 0;
  for (const scale of SCALES) {
    const plan = makePlan(mask, w, h, scale, { pitchM: 160, rows: 0, openM: OPEN_M }, []);
    say(`sweep scale ${scale}: ${plan.strokes.length} strokes`);
    for (let lat = lat1; lat <= lat2; lat += dLat)
      for (let lng = lng1; lng <= lng2; lng += dLng) {
        const c: LatLng = [lat, lng];
        const gi = localGridInfo(g, c);
        const rots = uprightRots(gi ? gi.rot : 0);
        for (const rot of rots) {
          if (!onLand(g, c, scale, rot)) { skipped++; continue; }
          tried++;
          const st: State = { strokes: plan.strokes, center: c, scale, rot };
          const ev = evaluate(g, t, st);
          if (!ev) { unroutable++; continue; }
          found.push({ st, ev });
          if (found.length % 25 === 0) {
            const b = found.reduce((a, x) => (x.ev.lk.score > a.ev.lk.score ? x : a));
            say(`  ${tried} routed, ${skipped} skipped, ${unroutable} unroutable, ${found.length} kept | best so far ${fmt(b.ev)} @ ${b.st.center.map((v) => v.toFixed(4))} s${b.st.scale} r${b.st.rot.toFixed(0)} | ${minutes().toFixed(0)} min`);
          }
          if (minutes() > MINUTES * 0.6) {
            say("sweep time budget reached");
            return pickTop(found);
          }
        }
      }
  }
  say(`sweep done: ${tried} routed, ${skipped} skipped, ${unroutable} unroutable, ${found.length} kept in ${minutes().toFixed(0)} min`);
  return pickTop(found);
}
function pickTop(found: { st: State; ev: Eval }[]): { st: State; ev: Eval }[] {
  found.sort((a, b) => b.ev.lk.score - a.ev.lk.score);
  const picked: { st: State; ev: Eval }[] = [];
  for (const f of found) {
    if (picked.length >= TOP) break;
    const far = picked.every((p) => Math.hypot((p.st.center[0] - f.st.center[0]) * 111320, (p.st.center[1] - f.st.center[1]) * 84000) > 1500 || p.st.scale !== f.st.scale);
    if (far) picked.push(f);
  }
  return picked;
}

async function climb(g: PainterGraph, t: Target, start: State, startEv: Eval, iters: number, tag: string): Promise<{ st: State; ev: Eval; accepted: number }> {
  let best = start;
  let bestEv = startEv;
  let accepted = 0;
  let stale = 0;
  const blockU = 110 / best.scale;
  for (let it = 1; it <= iters; it++) {
    const { next, move } = propose(best, blockU, rnd, !FIXED);
    const ev = evaluate(g, t, next);
    if (!ev) continue;
    if (ev.lk.score > bestEv.lk.score + 0.05) {
      best = next;
      bestEv = ev;
      accepted++;
      stale = 0;
      say(`${tag} it${it} ${move.kind} ${move.detail}: ${fmt(ev)} — ACCEPT`);
    } else if (++stale >= 250) {
      say(`${tag} no gain in 250 moves, stopping at it${it}`);
      break;
    }
    if (minutes() > MINUTES) {
      say("time budget reached");
      break;
    }
  }
  return { st: best, ev: bestEv, accepted };
}

async function coveragePng(t: Target, chain: LatLng[], st: State, file: string): Promise<void> {
  const cov = coverageMap(t, chain, { center: st.center, scale: st.scale, rot: st.rot }, { tolU: TOL_U });
  const n = t.n, k = 4;
  const rects: string[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (t.boundary[i]) rects.push(`<rect x="${x * k}" y="${y * k}" width="${k}" height="${k}" fill="${cov[i]! > 0.5 ? "#2a9d3f" : "#d62828"}"/>`);
      else if (t.fill[i]) rects.push(`<rect x="${x * k}" y="${y * k}" width="${k}" height="${k}" fill="#ddd"/>`);
    }
  const svg = `<svg width="${n * k}" height="${n * k}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>${rects.join("")}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

async function writeResult(t: Target, st: State, ev: Eval, tag: string, extra: object): Promise<void> {
  await paleRender(ev.r.chain, path.join(OUT, `${tag}.png`));
  await sideBySide(IMG!, path.join(OUT, `${tag}.png`), path.join(OUT, `${tag}-compare.png`));
  await coveragePng(t, ev.r.chain, st, path.join(OUT, `${tag}-coverage.png`));
  await fs.writeFile(path.join(OUT, `${tag}.gpx`), writeGpx(ev.r.chain, `${NAME}-${tag}`, "PaceCasso finisher-geo"));
  await fs.writeFile(
    path.join(OUT, `${tag === "best" ? "summary" : tag}.json`),
    JSON.stringify({ name: NAME, tag, geo: ev.lk, km: ev.r.km, inkKm: ev.r.inkKm, connectorKm: ev.r.connectorKm, center: st.center, scale: st.scale, rot: st.rot, strokes: st.strokes, ...extra }, null, 0),
  );
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  setHugTolerance(HUG_M);
  setTraceProfile({ trimNubs: true });
  const loaded = await loadMask(IMG!, MASK_MODE);
  const { mask, w, h } = loaded;
  const maskUsed = (loaded as { mode?: string }).mode ?? MASK_MODE;
  const t = buildTarget(mask, w, h);
  const g = await loadPackedGraph(GRAPH);
  say(`${NAME}: mask ${maskUsed}, ${t.targetCells} target cells, graph ${g.coord.length} nodes, tol ${TOL_U} of half-span, max rot ${MAX_ROT}°, model calls 0`);

  let seeds: { st: State; ev: Eval }[] = [];
  if (RESUME) {
    const prev = JSON.parse(await fs.readFile(RESUME, "utf8")) as { strokes: Stroke[]; center: LatLng; scale: number; rot: number };
    const st: State = { strokes: prev.strokes, center: prev.center, scale: prev.scale, rot: prev.rot };
    const ev = evaluate(g, t, st);
    if (!ev) throw new Error("resume state did not route");
    say(`resume ${RESUME}: ${fmt(ev)}`);
    seeds = [{ st, ev }];
  } else if (SWEEP) {
    seeds = await sweep(g, t, mask, w, h);
    seeds.forEach((s, i) => say(`seed ${i + 1}: ${fmt(s.ev)} @ ${s.st.center.map((v) => v.toFixed(4))} scale ${s.st.scale} rot ${s.st.rot.toFixed(1)}`));
    for (let i = 0; i < seeds.length; i++) await writeResult(t, seeds[i]!.st, seeds[i]!.ev, `seed-${i + 1}`, {});
  } else {
    const center = opt("center", "40.73,-73.992").split(",").map(Number) as [number, number];
    const scale = Number(opt("scale", "1300"));
    const rot = Number(opt("rot", "-28"));
    const plan = makePlan(mask, w, h, scale, { pitchM: 160, rows: 0, openM: OPEN_M }, []);
    const st: State = { strokes: plan.strokes, center, scale, rot };
    const ev = evaluate(g, t, st);
    if (!ev) throw new Error("the starting seat did not route");
    say(`start: ${fmt(ev)}`);
    seeds = [{ st, ev }];
  }
  if (!seeds.length) throw new Error("no routable seed");
  if (SIMPLIFY > 0) {
    // deliberate lines: drop the mask's pixel wobble so every run is a real street run
    for (const seed of seeds) {
      const eps = (SIMPLIFY * 110) / seed.st.scale;
      const before = seed.st.strokes.reduce((a, k) => a + k.pts.length, 0);
      const strokes: Stroke[] = seed.st.strokes.map((k) => {
        const pts = rdp(k.pts, eps);
        if (k.closed && pts.length > 2) pts[pts.length - 1] = [pts[0]![0], pts[0]![1]];
        return pts.length >= (k.closed ? 4 : 2) ? { ...k, pts } : k;
      });
      const st: State = { ...seed.st, strokes };
      const ev = evaluate(g, t, st);
      if (ev) {
        say(`simplify ${SIMPLIFY} blocks: ${before} -> ${strokes.reduce((a, k) => a + k.pts.length, 0)} pts, ${fmt(seed.ev)} -> ${fmt(ev)}`);
        seed.st = st;
        seed.ev = ev;
      } else say(`simplify ${SIMPLIFY} blocks: did not route, keeping the original strokes`);
    }
  }

  const per = Math.max(50, Math.floor(ITERS / seeds.length));
  let best: { st: State; ev: Eval; accepted: number } | null = null;
  for (let i = 0; i < seeds.length; i++) {
    const res = await climb(g, t, seeds[i]!.st, seeds[i]!.ev, per, `c${i + 1}`);
    say(`climb ${i + 1}: ${fmt(seeds[i]!.ev)} → ${fmt(res.ev)} (${res.accepted} accepted)`);
    await writeResult(t, res.st, res.ev, `climb-${i + 1}`, { accepted: res.accepted });
    if (!best || res.ev.lk.score > best.ev.lk.score) best = res;
  }
  await writeResult(t, best!.st, best!.ev, "best", { accepted: best!.accepted, iters: ITERS, modelCalls: 0 });
  say(`\nFINAL ${NAME}: ${fmt(best!.ev)} | ${minutes().toFixed(0)} min | model calls 0 | ${path.join(OUT, "best-compare.png")}`);
  await fs.writeFile(path.join(OUT, "log.txt"), log.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
