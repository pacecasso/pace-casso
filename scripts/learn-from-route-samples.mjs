#!/usr/bin/env node
/*
 * Learn route-art grammar from successful sample screenshots.
 *
 * This is intentionally sample-first: extract the actual red/orange route stroke
 * from each reference image, vectorize it, and report the map-native primitives
 * the route uses. The goal is to learn reusable transformations, not to trace
 * uploaded logos more literally.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const ROOT = process.cwd();
const OUT_ROOT = path.join(ROOT, "tmp-sample-replication");

const SAMPLE_SPECS = [
  { id: "lion", file: "lion.webp", subject: "lion", kind: "sample" },
  { id: "tiger", file: "TIGER.webp", subject: "tiger", kind: "sample" },
  { id: "witch", file: "witch.jpg", subject: "witch", kind: "sample" },
  { id: "love", file: "LOVE.png", subject: "heart + LOVE route", kind: "sample" },
  { id: "heart", file: "HEART.webp", subject: "heart", kind: "sample" },
  { id: "fish", file: "FISH.png", subject: "fish", kind: "candidate" },
  { id: "puma", file: "sneaker.jpg", subject: "shoe / puma project", kind: "sample" },
  { id: "unicorn", file: "unicorn.jpg", subject: "unicorn", kind: "sample" },
];

function idx(x, y, w) {
  return y * w + x;
}

function neighbors8(x, y, w, h) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) out.push([nx, ny]);
    }
  }
  return out;
}

function routePixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max - min;
  const red = r > 130 && r - g > 32 && r - b > 28;
  const orange = r > 150 && g > 45 && g < 160 && b < 105 && r - b > 70 && sat > 70;
  const stravaOrange = r > 165 && g > 65 && g < 135 && b < 75;
  return red || orange || stravaOrange;
}

function dilate(mask, w, h, rounds = 1) {
  let cur = mask;
  for (let round = 0; round < rounds; round++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = idx(x, y, w);
        if (cur[i]) {
          out[i] = 1;
          continue;
        }
        for (const [nx, ny] of neighbors8(x, y, w, h)) {
          if (cur[idx(nx, ny, w)]) {
            out[i] = 1;
            break;
          }
        }
      }
    }
    cur = out;
  }
  return cur;
}

function erode(mask, w, h, rounds = 1) {
  let cur = mask;
  for (let round = 0; round < rounds; round++) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = idx(x, y, w);
        if (!cur[i]) continue;
        let keep = true;
        for (const [nx, ny] of neighbors8(x, y, w, h)) {
          if (!cur[idx(nx, ny, w)]) {
            keep = false;
            break;
          }
        }
        if (keep) out[i] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

function closeMask(mask, w, h) {
  return erode(dilate(mask, w, h, 1), w, h, 1);
}

function components(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = idx(x, y, w);
      if (!mask[start] || seen[start]) continue;
      const stack = [[x, y]];
      const comp = [];
      seen[start] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        comp.push([cx, cy]);
        for (const [nx, ny] of neighbors8(cx, cy, w, h)) {
          const ni = idx(nx, ny, w);
          if (mask[ni] && !seen[ni]) {
            seen[ni] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      comps.push(comp);
    }
  }
  return comps.sort((a, b) => b.length - a.length);
}

function keepRouteComponents(mask, w, h) {
  const comps = components(mask, w, h);
  const largest = comps[0]?.length ?? 0;
  const minSize = Math.max(18, Math.round(largest * 0.01));
  const kept = comps.filter((c) => c.length >= minSize).slice(0, 28);
  const out = new Uint8Array(w * h);
  for (const comp of kept) {
    for (const [x, y] of comp) out[idx(x, y, w)] = 1;
  }
  return { mask: out, comps: comps.map((c) => c.length), keptCount: kept.length };
}

function zhangSuen(bin, w, h) {
  const get = (x, y) => bin[idx(x, y, w)];
  let changed = true;
  let iter = 0;
  while (changed && iter++ < 90) {
    changed = false;
    for (const step of [0, 1]) {
      const del = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!get(x, y)) continue;
          const p2 = get(x, y - 1), p3 = get(x + 1, y - 1), p4 = get(x + 1, y), p5 = get(x + 1, y + 1);
          const p6 = get(x, y + 1), p7 = get(x - 1, y + 1), p8 = get(x - 1, y), p9 = get(x - 1, y - 1);
          const ns = [p2, p3, p4, p5, p6, p7, p8, p9];
          const b = ns.reduce((s, v) => s + (v ? 1 : 0), 0);
          let a = 0;
          for (let i = 0; i < 8; i++) if (!ns[i] && ns[(i + 1) % 8]) a++;
          if (b < 2 || b > 6 || a !== 1) continue;
          if (step === 0) {
            if (p2 && p4 && p6) continue;
            if (p4 && p6 && p8) continue;
          } else {
            if (p2 && p4 && p8) continue;
            if (p2 && p6 && p8) continue;
          }
          del.push(idx(x, y, w));
        }
      }
      if (del.length) {
        changed = true;
        for (const i of del) bin[i] = 0;
      }
    }
  }
  return bin;
}

function skeletonGraph(mask, w, h) {
  const nodes = [];
  const idByPixel = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[idx(x, y, w)]) continue;
      const id = nodes.length;
      nodes.push([x, y]);
      idByPixel.set(`${x},${y}`, id);
    }
  }
  const adj = Array.from({ length: nodes.length }, () => []);
  const edges = new Set();
  for (let id = 0; id < nodes.length; id++) {
    const [x, y] = nodes[id];
    for (const [nx, ny] of neighbors8(x, y, w, h)) {
      const nid = idByPixel.get(`${nx},${ny}`);
      if (nid == null || nid === id) continue;
      const a = Math.min(id, nid);
      const b = Math.max(id, nid);
      const key = `${a}:${b}`;
      if (edges.has(key)) continue;
      edges.add(key);
      adj[id].push(nid);
      adj[nid].push(id);
    }
  }
  return { nodes, adj, edgeCount: edges.size };
}

function traverseGraph(graph) {
  if (!graph.nodes.length) return [];
  const unused = new Set();
  for (let i = 0; i < graph.adj.length; i++) {
    for (const j of graph.adj[i]) if (i < j) unused.add(`${i}:${j}`);
  }
  const degree = graph.adj.map((a) => a.length);
  let cur = degree.findIndex((d) => d === 1);
  if (cur < 0) cur = degree.findIndex((d) => d > 2);
  if (cur < 0) cur = 0;
  const out = [graph.nodes[cur]];
  while (unused.size) {
    let best = -1;
    for (const nxt of graph.adj[cur]) {
      const a = Math.min(cur, nxt);
      const b = Math.max(cur, nxt);
      if (unused.has(`${a}:${b}`)) {
        best = nxt;
        break;
      }
    }
    if (best < 0) {
      let nearEdge = null;
      let nearD = Infinity;
      const [cx, cy] = graph.nodes[cur];
      for (const key of unused) {
        const [a, b] = key.split(":").map(Number);
        for (const id of [a, b]) {
          const [x, y] = graph.nodes[id];
          const d = Math.hypot(x - cx, y - cy);
          if (d < nearD) {
            nearD = d;
            nearEdge = id;
          }
        }
      }
      if (nearEdge == null) break;
      cur = nearEdge;
      out.push(graph.nodes[cur]);
      continue;
    }
    const a = Math.min(cur, best);
    const b = Math.max(cur, best);
    unused.delete(`${a}:${b}`);
    cur = best;
    out.push(graph.nodes[cur]);
  }
  return out;
}

function simplifyByDistance(points, minDist = 4) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) {
      out.push(p);
      last = p;
    }
  }
  if (points.length && out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

function bounds(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function normalize(points) {
  if (!points.length) return [];
  const b = bounds(points);
  const scale = 1000 / Math.max(1, b.maxX - b.minX, b.maxY - b.minY);
  return points.map(([x, y]) => [(x - b.minX) * scale, (b.maxY - y) * scale]);
}

function turnAngle(a, b, c) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const ul = Math.hypot(ux, uy) || 1;
  const vl = Math.hypot(vx, vy) || 1;
  const dot = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (ul * vl)));
  return Math.acos(dot) * 180 / Math.PI;
}

function directionBucket(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { bucket: "zero", len };
  let deg = Math.atan2(dy, dx) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  const near = (target) => Math.min(Math.abs(deg - target), 360 - Math.abs(deg - target));
  if ([0, 90, 180, 270].some((d) => near(d) <= 14)) return { bucket: "grid", len };
  if ([45, 135, 225, 315].some((d) => near(d) <= 14)) return { bucket: "diagonal", len };
  return { bucket: "free", len };
}

function analyzeVector(points, graph) {
  const route = normalize(points);
  let length = 0;
  let grid = 0;
  let diagonal = 0;
  let free = 0;
  let turns45 = 0;
  let turns80 = 0;
  let hairpins = 0;
  let shortSpurs = 0;
  for (let i = 1; i < route.length; i++) {
    const d = directionBucket(route[i - 1], route[i]);
    length += d.len;
    if (d.bucket === "grid") grid += d.len;
    else if (d.bucket === "diagonal") diagonal += d.len;
    else free += d.len;
  }
  for (let i = 2; i < route.length; i++) {
    const ang = turnAngle(route[i - 2], route[i - 1], route[i]);
    if (ang > 45) turns45++;
    if (ang > 80) turns80++;
    if (ang > 145) hairpins++;
  }
  for (let i = 2; i < route.length; i++) {
    const a = route[i - 2], b = route[i - 1], c = route[i];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (l1 < 42 && l2 < 42 && turnAngle(a, b, c) > 135) shortSpurs++;
  }
  const b = route.length ? bounds(route) : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const nodeDegrees = graph.adj.map((a) => a.length);
  return {
    normalizedLength: Number(length.toFixed(1)),
    bboxAspect: Number(((b.maxX - b.minX) / Math.max(1, b.maxY - b.minY)).toFixed(2)),
    vectorPoints: route.length,
    skeletonNodes: graph.nodes.length,
    skeletonEdges: graph.edgeCount,
    endpoints: nodeDegrees.filter((d) => d === 1).length,
    junctions: nodeDegrees.filter((d) => d > 2).length,
    gridShare: Number((grid / Math.max(1, length)).toFixed(2)),
    diagonalShare: Number((diagonal / Math.max(1, length)).toFixed(2)),
    freeShare: Number((free / Math.max(1, length)).toFixed(2)),
    turns45,
    turns80,
    hairpins,
    shortSpurs,
    primitiveHints: primitiveHints({ grid, diagonal, free, length, turns80, hairpins, shortSpurs, junctions: nodeDegrees.filter((d) => d > 2).length }),
  };
}

function primitiveHints(m) {
  const hints = [];
  if (m.grid / Math.max(1, m.length) > 0.55) hints.push("block-grid strokes");
  if (m.diagonal / Math.max(1, m.length) > 0.14) hints.push("long diagonals / bridge-like cuts");
  if (m.turns80 > 40) hints.push("dense stair-step texture");
  if (m.hairpins > 8 || m.shortSpurs > 4) hints.push("out-and-back spikes");
  if (m.junctions > 30) hints.push("overlaid/retraced route fabric");
  if (!hints.length) hints.push("simple contour route");
  return hints;
}

function svgPath(points, project) {
  if (points.length < 2) return "";
  return points.map((p, i) => {
    const [x, y] = project(p);
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function projectFor(points, w, h, pad = 32) {
  const b = bounds(points);
  const sx = (w - pad * 2) / Math.max(1, b.maxX - b.minX);
  const sy = (h - pad * 2) / Math.max(1, b.maxY - b.minY);
  const s = Math.min(sx, sy);
  const usedW = (b.maxX - b.minX) * s;
  const usedH = (b.maxY - b.minY) * s;
  const ox = (w - usedW) / 2;
  const oy = (h - usedH) / 2;
  return ([x, y]) => [ox + (x - b.minX) * s, oy + (b.maxY - y) * s];
}

async function renderMask(mask, w, h, file) {
  const rgba = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      rgba[i * 4] = 230;
      rgba[i * 4 + 1] = 35;
      rgba[i * 4 + 2] = 35;
      rgba[i * 4 + 3] = 255;
    }
  }
  await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toFile(file);
}

async function renderVector(points, file, title, analysis) {
  const route = normalize(points);
  const w = 900;
  const h = 680;
  const project = projectFor(route, w, h, 48);
  const d = svgPath(route, project);
  const note = analysis.primitiveHints.join("; ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#fbfbf8"/>
    <text x="24" y="34" font-family="Arial" font-size="24" font-weight="700" fill="#111827">${escapeXml(title)}</text>
    <text x="24" y="58" font-family="Arial" font-size="14" fill="#4b5563">${escapeXml(note)}</text>
    <path d="${d}" fill="none" stroke="#ef2727" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

function escapeXml(s) {
  return String(s).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

async function extractSample(spec) {
  const input = path.join(ROOT, spec.file);
  const dir = path.join(OUT_ROOT, spec.id);
  await fs.mkdir(dir, { recursive: true });
  const img = sharp(input).resize({ width: 900, withoutEnlargement: true }).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  let mask = new Uint8Array(info.width * info.height);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (routePixel(data[i], data[i + 1], data[i + 2])) mask[idx(x, y, info.width)] = 1;
    }
  }
  mask = closeMask(mask, info.width, info.height);
  const kept = keepRouteComponents(mask, info.width, info.height);
  const skeleton = zhangSuen(kept.mask.slice(), info.width, info.height);
  const graph = skeletonGraph(skeleton, info.width, info.height);
  const ordered = simplifyByDistance(traverseGraph(graph), 5);
  const analysis = analyzeVector(ordered, graph);

  await fs.copyFile(input, path.join(dir, `source${path.extname(spec.file)}`));
  await renderMask(kept.mask, info.width, info.height, path.join(dir, "1-route-mask.png"));
  await renderMask(skeleton, info.width, info.height, path.join(dir, "2-route-skeleton.png"));
  await renderVector(ordered, path.join(dir, "3-vectorized-route.png"), `${spec.subject} extracted route`, analysis);
  const normalized = normalize(ordered).map(([x, y]) => [Number(x.toFixed(2)), Number(y.toFixed(2))]);
  await fs.writeFile(path.join(dir, "route-normalized.json"), JSON.stringify(normalized, null, 2));
  await fs.writeFile(path.join(dir, "analysis.json"), JSON.stringify({ ...spec, image: { width: info.width, height: info.height }, keptComponents: kept.keptCount, componentSizes: kept.comps.slice(0, 12), ...analysis }, null, 2));
  return { ...spec, dir: path.relative(ROOT, dir).replace(/\\/g, "/"), keptComponents: kept.keptCount, componentSizes: kept.comps.slice(0, 8), ...analysis };
}

async function writeContactSheet(results) {
  const cellW = 460;
  const cellH = 390;
  const cols = 2;
  const rows = Math.ceil(results.length / cols);
  const comps = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const png = await sharp(path.join(ROOT, r.dir, "3-vectorized-route.png")).resize(cellW, cellH, { fit: "contain", background: "#fff" }).png().toBuffer();
    comps.push({ input: png, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH });
  }
  await sharp({ create: { width: cellW * cols, height: cellH * rows, channels: 4, background: "#e5e7eb" } })
    .composite(comps)
    .png()
    .toFile(path.join(OUT_ROOT, "SHEET.png"));
}

function aggregateGrammar(results) {
  const training = results.filter((r) => r.kind === "sample");
  const avg = (name) => Number((training.reduce((s, r) => s + (r[name] || 0), 0) / Math.max(1, training.length)).toFixed(2));
  const hints = new Map();
  for (const r of training) {
    for (const h of r.primitiveHints) hints.set(h, (hints.get(h) || 0) + 1);
  }
  return {
    sampleCount: training.length,
    average: {
      gridShare: avg("gridShare"),
      diagonalShare: avg("diagonalShare"),
      freeShare: avg("freeShare"),
      endpoints: avg("endpoints"),
      junctions: avg("junctions"),
      turns80: avg("turns80"),
      hairpins: avg("hairpins"),
      shortSpurs: avg("shortSpurs"),
    },
    primitiveFrequency: [...hints.entries()].sort((a, b) => b[1] - a[1]).map(([primitive, count]) => ({ primitive, count })),
    extrapolationRules: [
      "Do not preserve literal outlines when the subject is filled; convert filled masses into one or two readable strokes/loops.",
      "Let the city grid supply texture: use stair steps and short out-and-backs for fur, flames, hair, bristles, and sharp curves.",
      "Use long diagonals/bridges as feature anchors when the subject needs a body, broom, tail, wing, underline, or swoosh spine.",
      "Treat recognizability features as hard constraints; treat exact contour fidelity as optional.",
      "Search placement first, then distort the drawing to the street fabric; snapping a fixed trace is the fallback, not the main strategy.",
    ],
  };
}

async function main() {
  await fs.mkdir(OUT_ROOT, { recursive: true });
  const results = [];
  for (const spec of SAMPLE_SPECS) {
    try {
      await fs.access(path.join(ROOT, spec.file));
      console.log(`[sample] extracting ${spec.id} from ${spec.file}`);
      results.push(await extractSample(spec));
    } catch (err) {
      console.warn(`[sample] skipped ${spec.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await writeContactSheet(results);
  const grammar = aggregateGrammar(results);
  await fs.writeFile(path.join(OUT_ROOT, "summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results, grammar }, null, 2));
  console.log(path.relative(ROOT, OUT_ROOT));
  for (const r of results) {
    console.log(`${r.id.padEnd(8)} comps=${String(r.keptComponents).padStart(2)} grid=${r.gridShare} diag=${r.diagonalShare} turns80=${r.turns80} hints=${r.primitiveHints.join(" | ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

