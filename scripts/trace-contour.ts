/**
 * ETCH-A-SKETCH tracer — Ralph's framing: GPS art is tracing a shape *with*
 * the map's real streets, not forcing a design onto a grid. Instead of the
 * coarse 3.7k-junction lattice, this routes on the FULL road graph (~103k
 * OSM nodes) so the traced path hugs the target contour tightly => smooth,
 * organic curves at large scale, like the reference lion/tiger.
 *
 * Corridor A*: between contour anchor points, find the street path that
 * stays closest to the shape (cost = street length + lambda * distance from
 * the target outline). Dense graph + large scale => small deviation => the
 * streets themselves draw the curve.
 *
 * Run: npx tsx scripts/trace-contour.ts <shape> <centerLat> <centerLng> <scaleMeters> [rotDeg]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

type LL = [number, number];
const M_PER_LAT = 111320;
const mPerLng = (lat: number) => M_PER_LAT * Math.cos((lat * Math.PI) / 180);
function meters(a: LL, b: LL) {
  return Math.hypot((b[0] - a[0]) * M_PER_LAT, (b[1] - a[1]) * mPerLng(a[0]));
}
// point-to-segment distance in meters (local equirectangular)
function distToSeg(p: LL, a: LL, b: LL): number {
  const lat0 = a[0];
  const px = (p[1] - a[1]) * mPerLng(lat0), py = (p[0] - a[0]) * M_PER_LAT;
  const bx = (b[1] - a[1]) * mPerLng(lat0), by = (b[0] - a[0]) * M_PER_LAT;
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by || 1)));
  return Math.hypot(px - t * bx, py - t * by);
}

// ---------------------------------------------------------------------------
// Road graph from the OSM walk cache (street centerlines only — no sidewalks)
// ---------------------------------------------------------------------------
const ROAD = new Set(["residential", "secondary", "primary", "tertiary", "unclassified", "living_street", "pedestrian", "footway", "path", "cycleway", "secondary_link", "primary_link", "tertiary_link"]);
export type Graph = {
  coord: Map<number, LL>;
  adj: Map<number, { to: number; w: number }[]>;
  cellOf: (lat: number, lng: number) => string;
  grid: Map<string, number[]>;
};
export type { LL };
export { meters, renderMap, traceContour, buildGraph, nearestNode };
export { place, coarseScore, sampleOutline, distToSeg, curvatureWeights, cbez as cbezExport, corridorPath };
export const getShape = (name: string) => SHAPES[name];
async function buildGraph(): Promise<Graph> {
  const d = JSON.parse(await fs.readFile(path.join(process.cwd(), "tmp-gas-spike", "osm-walk-network.json"), "utf8")) as { elements: any[] };
  const coord = new Map<number, LL>();
  for (const e of d.elements) if (e.type === "node") coord.set(e.id, [e.lat, e.lon]);
  const adj = new Map<number, { to: number; w: number }[]>();
  const add = (a: number, b: number) => {
    const ca = coord.get(a), cb = coord.get(b);
    if (!ca || !cb) return;
    const w = meters(ca, cb);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ to: b, w });
    adj.get(b)!.push({ to: a, w });
  };
  for (const e of d.elements) {
    if (e.type !== "way" || !e.tags?.highway || !ROAD.has(e.tags.highway)) continue;
    for (let i = 1; i < e.nodes.length; i++) add(e.nodes[i - 1], e.nodes[i]);
  }
  // keep only nodes that are in the graph; spatial grid (~0.003deg ~ 250m cells)
  const grid = new Map<string, number[]>();
  const cellOf = (lat: number, lng: number) => `${Math.round(lat / 0.003)}:${Math.round(lng / 0.003)}`;
  for (const id of adj.keys()) {
    const c = coord.get(id)!;
    const k = cellOf(c[0], c[1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(id);
  }
  return { coord, adj, cellOf, grid };
}
function nearestNode(g: Graph, p: LL): number {
  let best = -1, bd = Infinity;
  const [clat, clng] = [Math.round(p[0] / 0.003), Math.round(p[1] / 0.003)];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    for (const id of g.grid.get(`${clat + dr}:${clng + dc}`) ?? []) {
      const m = meters(p, g.coord.get(id)!);
      if (m < bd) { bd = m; best = id; }
    }
  }
  return best;
}

// Corridor A* from node a to node b that hugs the target contour.
function corridorPath(g: Graph, a: number, b: number, contour: LL[], lambda: number, corridorM: number): number[] | null {
  const target = g.coord.get(b)!;
  const distContour = (p: LL) => {
    let m = Infinity;
    for (let i = 1; i < contour.length; i++) { const dd = distToSeg(p, contour[i - 1], contour[i]); if (dd < m) m = dd; }
    return m;
  };
  const open = new Map<number, number>([[a, 0]]);
  const gScore = new Map<number, number>([[a, 0]]);
  const came = new Map<number, number>();
  const fScore = new Map<number, number>([[a, meters(g.coord.get(a)!, target)]]);
  const done = new Set<number>();
  let guard = 0;
  while (open.size && guard++ < 200000) {
    let cur = -1, cf = Infinity;
    for (const [n, f] of open) if (f < cf) { cf = f; cur = n; }
    if (cur === b) {
      const pathIds = [cur]; let c = cur;
      while (came.has(c)) { c = came.get(c)!; pathIds.push(c); }
      return pathIds.reverse();
    }
    open.delete(cur); done.add(cur);
    for (const { to, w } of g.adj.get(cur) ?? []) {
      if (done.has(to)) continue;
      const cto = g.coord.get(to)!;
      const dc = distContour(cto);
      if (dc > corridorM) continue; // stay in the corridor around the shape
      const tentative = gScore.get(cur)! + w + lambda * dc;
      if (tentative < (gScore.get(to) ?? Infinity)) {
        came.set(to, cur);
        gScore.set(to, tentative);
        fScore.set(to, tentative + meters(cto, target));
        open.set(to, fScore.get(to)!);
      }
    }
  }
  return null;
}

// Trace a whole closed contour: anchor every ~stepM, corridor-route between.
function traceContour(g: Graph, contour: LL[], opts: { anchorM: number; lambda: number; corridorM: number }): LL[] {
  // resample contour to dense, even spacing for good distance queries
  const dense: LL[] = [];
  for (let i = 1; i < contour.length; i++) {
    const a = contour[i - 1], b = contour[i];
    const d = meters(a, b), n = Math.max(1, Math.round(d / 25));
    for (let s = 0; s < n; s++) dense.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  dense.push(contour[contour.length - 1]);
  // anchors along the dense contour
  const anchors: LL[] = [];
  let acc = 0;
  anchors.push(dense[0]);
  for (let i = 1; i < dense.length; i++) {
    acc += meters(dense[i - 1], dense[i]);
    if (acc >= opts.anchorM) { anchors.push(dense[i]); acc = 0; }
  }
  anchors.push(dense[0]); // close the loop back to the start
  const chain: LL[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const na = nearestNode(g, anchors[i - 1]), nb = nearestNode(g, anchors[i]);
    if (na < 0 || nb < 0 || na === nb) continue;
    // corridor route; widen progressively so a segment NEVER gaps (keeps
    // the drawing closed even where streets are sparse)
    const direct = meters(anchors[i - 1], anchors[i]);
    let p = corridorPath(g, na, nb, dense, opts.lambda, opts.corridorM);
    if (!p) p = corridorPath(g, na, nb, dense, opts.lambda, opts.corridorM * 3);
    if (!p) p = corridorPath(g, na, nb, dense, 0, 1e7); // plain shortest path fallback
    if (!p) continue;
    // reject a segment that detours wildly (sparse/water gap) — a small gap
    // beats a huge loop across the city.
    let plen = 0; for (let k = 1; k < p.length; k++) plen += meters(g.coord.get(p[k - 1])!, g.coord.get(p[k])!);
    if (plen > direct * 2.2 + 250 || plen > 1400) continue;
    for (const id of p) chain.push(g.coord.get(id)!);
  }
  // dedupe consecutive identical points
  const out: LL[] = [];
  for (const p of chain) if (!out.length || meters(out[out.length - 1], p) > 1) out.push(p);
  return traceOpts.trim ? trimNubs(out) : out;
}
export const traceOpts = { trim: true };

// Remove little out-and-back "nubs": a short excursion that leaves a point and
// returns near it (a dead-end spur down a side street, or a jog) adds a stub
// that reads as an error. Splice out any excursion that returns within
// closeM of its start over <= maxLoopM of path — leaving the clean line.
function trimNubs(chain: LL[], closeM = 34, maxLoopM = 380): LL[] {
  const out = chain.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length - 2; i++) {
      let acc = 0;
      for (let j = i + 2; j < out.length && acc < maxLoopM; j++) {
        acc += meters(out[j - 1], out[j]);
        if (meters(out[i], out[j]) < closeM) { out.splice(i + 1, j - i); changed = true; break; }
      }
      if (changed) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shapes (unit contour in [-1,1], y up). Placed via center + scaleMeters + rot.
// ---------------------------------------------------------------------------
function circle(): LL[] { const p: LL[] = []; for (let i = 0; i <= 96; i++) { const a = (i / 96) * 2 * Math.PI; p.push([Math.sin(a), Math.cos(a)]); } return p; }
function cbez(p0: LL, p1: LL, p2: LL, p3: LL, n = 18): LL[] {
  const o: LL[] = [];
  for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t;
    o.push([u*u*u*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t*t*t*p3[0], u*u*u*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t*t*t*p3[1]]); }
  return o;
}
// Apple mark: bold closed body, bite on the upper right, leaf on top.
// Coords are [y,x] to match LL=[lat,lng] convention downstream? No — shapes
// are [x,y] unit; place() reads [x,y]. Keep [x,y], y up.
function apple(): LL[] {
  const p: LL[] = [];
  const B = (a: LL, b: LL, c: LL, d: LL) => p.push(...cbez(a, b, c, d));
  // start at top-center dip between the humps, go clockwise
  B([0, 0.60], [0.10, 0.86], [0.30, 0.95], [0.46, 0.78]);   // right hump
  B([0.46, 0.78], [0.66, 0.60], [0.62, 0.60], [0.86, 0.44]);// shoulder toward bite
  // BITE — concave notch cut into the right edge (curves inward then out)
  B([0.86, 0.44], [0.66, 0.30], [0.66, 0.10], [0.86, -0.04]);
  B([0.86, -0.04], [1.00, -0.30], [0.92, -0.66], [0.52, -0.86]); // lower right
  B([0.52, -0.86], [0.22, -1.02], [-0.22, -1.02], [-0.52, -0.86]); // bottom
  B([-0.52, -0.86], [-0.92, -0.66], [-1.00, -0.10], [-0.78, 0.42]); // left side up
  B([-0.78, 0.42], [-0.64, 0.62], [-0.42, 0.78], [-0.30, 0.86]);  // left shoulder
  B([-0.30, 0.86], [-0.16, 0.96], [-0.06, 0.86], [0, 0.60]);      // left hump back to dip
  return p;
}
// Apple leaf as a separate small closed lens above the dip (traced as its
// own loop; the connector retraces so it reads as a stem+leaf).
function appleLeaf(): LL[] {
  const p: LL[] = [];
  const B = (a: LL, b: LL, c: LL, d: LL) => p.push(...cbez(a, b, c, d));
  B([0.02, 0.62], [0.10, 0.92], [0.34, 1.06], [0.40, 1.16]);
  B([0.40, 1.16], [0.20, 1.10], [0.04, 0.92], [0.02, 0.62]);
  return p;
}
function heart(): LL[] { const p: LL[] = []; for (let i = 0; i <= 120; i++) { const t = Math.PI + (i / 120) * 2 * Math.PI; const x = 16 * Math.sin(t) ** 3; const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t); p.push([x / 17, y / 17]); } return p; }
// Bold simple fish: oval body + triangular tail. Chosen because coarse bold
// features survive street-scale where fine ones (apple bite) dissolve.
function fish(): LL[] {
  const p: LL[] = [];
  const B = (a: LL, b: LL, c: LL, d: LL) => p.push(...cbez(a, b, c, d));
  B([-1.0, 0.05], [-0.5, 0.62], [0.25, 0.6], [0.55, 0.28]);   // top of body, nose->tail base
  B([0.55, 0.28], [0.78, 0.42], [0.9, 0.55], [1.0, 0.6]);     // up to upper fluke tip
  B([1.0, 0.6], [0.86, 0.28], [0.78, 0.12], [0.7, 0.0]);      // fluke to tail notch
  B([0.7, 0.0], [0.78, -0.12], [0.86, -0.28], [1.0, -0.6]);   // notch to lower fluke tip
  B([1.0, -0.6], [0.9, -0.55], [0.78, -0.42], [0.55, -0.28]); // lower fluke to tail base
  B([0.55, -0.28], [0.25, -0.6], [-0.5, -0.62], [-1.0, 0.05]);// bottom of body back to nose
  return p;
}
// Nike swoosh — filled silhouette: sharp tail (left), convex bottom sweep up
// to a sharp tip (right), concave top edge back.
function swoosh(): LL[] {
  const p: LL[] = [];
  const B = (a: LL, b: LL, c: LL, d: LL) => p.push(...cbez(a, b, c, d));
  B([-1.0, 0.15], [-0.55, -0.12], [-0.1, -0.28], [0.35, -0.18]); // bottom edge, tail->
  B([0.35, -0.18], [0.7, -0.05], [0.9, 0.25], [1.0, 0.62]);      // up to the sharp tip
  B([1.0, 0.62], [0.72, 0.18], [0.4, 0.02], [0.02, 0.0]);        // concave top edge back
  B([0.02, 0.0], [-0.4, -0.02], [-0.72, 0.06], [-1.0, 0.15]);    // to the tail tip
  return p;
}
// Swoosh as ONE BOLD STROKE (giant checkmark): thin closed silhouettes
// collapse at street scale — their two edges are a block apart and merge.
// A single sweeping curve keeps the identity (dip, then the long rising
// tail) and lets the streets draw it smooth.
function swooshStroke(): LL[] {
  const p: LL[] = [];
  const B = (a: LL, b: LL, c: LL, d: LL) => p.push(...cbez(a, b, c, d));
  B([-1.0, -0.1], [-0.6, -0.45], [-0.25, -0.55], [0.05, -0.5]); // down into the dip
  B([0.05, -0.5], [0.45, -0.42], [0.8, -0.05], [1.0, 0.55]);    // long rising tail
  return p;
}
// Five-pointed star — sharp points are the distinctive features.
function star(): LL[] {
  const p: LL[] = [];
  for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const r = i % 2 === 0 ? 1 : 0.42; p.push([r * Math.cos(a), r * Math.sin(a)]); }
  return p;
}
// Crescent moon — outer curve + concave inner curve meeting at two cusps.
function crescent(): LL[] {
  const p: LL[] = [];
  for (let i = 0; i <= 44; i++) { const a = Math.PI / 2 + (i / 44) * Math.PI; p.push([Math.cos(a), Math.sin(a)]); }        // outer left arc, top->bottom
  for (let i = 0; i <= 30; i++) { const a = -Math.PI / 2 + (i / 30) * Math.PI; p.push([0.5 + 0.75 * Math.cos(a), 0.75 * Math.sin(a)]); } // inner arc, bottom->top
  return p;
}
// Dog in profile (facing left), 4 legs, ear, tail — a well-proportioned
// figurative silhouette in the spirit of Cameron's animal outlines.
function dog(): LL[] {
  const p: LL[] = [];
  const B = (a: LL, b: LL, c: LL, d: LL) => p.push(...cbez(a, b, c, d));
  const A = (...pts: LL[]) => p.push(...pts);
  B([-1.0, 0.05], [-0.95, 0.35], [-0.82, 0.5], [-0.7, 0.5]);   // nose -> forehead
  A([-0.63, 0.52], [-0.58, 0.84], [-0.5, 0.52]);               // ear (triangle)
  B([-0.5, 0.52], [-0.3, 0.62], [0.1, 0.58], [0.5, 0.52]);     // neck + back to rump
  A([0.64, 0.64], [0.92, 0.92], [0.78, 0.5]);                  // tail up + back
  B([0.78, 0.5], [0.83, 0.32], [0.81, 0.18], [0.78, 0.05]);    // rump down
  A([0.78, -0.7], [0.66, -0.7], [0.66, 0.0]);                  // hind leg (far)
  A([0.55, 0.0], [0.55, -0.7], [0.43, -0.7], [0.43, 0.02]);    // hind leg (near)
  A([-0.25, 0.02]);                                            // belly
  A([-0.25, -0.7], [-0.37, -0.7], [-0.37, 0.05]);              // front leg (near)
  A([-0.48, 0.05], [-0.48, -0.7], [-0.6, -0.7], [-0.6, 0.08]); // front leg (far)
  B([-0.6, 0.08], [-0.8, 0.16], [-0.95, -0.05], [-1.0, 0.05]); // chest + chin -> nose
  return p;
}
// Unicorn facing right — zigzag horn, ear, muzzle, 4 legs, flowing tail, and
// a zigzag mane along the back. A well-proportioned figurative silhouette in
// the spirit of Cameron's references (authored from his unicorn's proportions).
function unicorn(): LL[] {
  // Copies Cameron's composition: clean defined horn + BIG head held high at
  // top, body + 4 legs below, flowing tail, zigzag mane.
  const p: LL[] = []; const A = (...pts: LL[]) => p.push(...pts); const B = (a: LL, b: LL, c: LL, d: LL) => p.push(...cbez(a, b, c, d));
  A([0.07, 1.58]);                          // horn tip (clean tapered triangle)
  A([0.15, 0.90]);                          // right edge down to forehead
  A([0.22, 0.96], [0.30, 0.84]);            // ear
  B([0.30, 0.84], [0.46, 0.78], [0.58, 0.64], [0.66, 0.48]); // long face
  A([0.72, 0.36], [0.62, 0.28]);            // muzzle + mouth
  B([0.62, 0.28], [0.50, 0.34], [0.40, 0.34], [0.32, 0.38]); // jaw
  B([0.32, 0.38], [0.20, 0.16], [0.14, -0.02], [0.14, -0.18]); // neck to chest
  A([0.14, -0.88], [0.04, -0.88], [0.04, -0.16]);          // front leg near
  A([-0.08, -0.16], [-0.08, -0.88], [-0.18, -0.88], [-0.18, -0.12]); // front leg far
  B([-0.18, -0.12], [-0.38, -0.18], [-0.56, -0.16], [-0.66, -0.12]); // belly
  A([-0.66, -0.88], [-0.76, -0.88], [-0.76, -0.14]);       // hind leg near
  A([-0.88, -0.14], [-0.88, -0.88], [-0.98, -0.88], [-0.98, 0.00]); // hind leg far
  B([-0.98, 0.00], [-1.08, 0.08], [-1.14, 0.12], [-1.20, 0.14]); // rump
  B([-1.20, 0.14], [-1.38, -0.08], [-1.32, -0.50], [-1.14, -0.34]); // tail down
  B([-1.14, -0.34], [-1.26, -0.02], [-1.14, 0.20], [-1.02, 0.24]);  // tail up
  A([-0.86, 0.28], [-0.58, 0.34]);          // back to withers
  A([-0.46, 0.52], [-0.38, 0.34], [-0.26, 0.56], [-0.18, 0.38], [-0.06, 0.60], [0.00, 0.42]); // zigzag mane
  A([-0.01, 0.90]);                          // forehead base-left of horn
  return p;
}
// Sitting cat — two pointed ears, rounded body, curled tail. Iconic silhouette.
function cat(): LL[] {
  const p: LL[] = []; const A = (...pts: LL[]) => p.push(...pts); const B = (a: LL, b: LL, c: LL, d: LL) => p.push(...cbez(a, b, c, d));
  A([-0.40, 1.30], [-0.16, 0.48], [0.0, 0.58], [0.16, 0.48], [0.40, 1.30], [0.46, 0.42]); // BIG sharp ears + head
  B([0.46, 0.42], [0.54, 0.15], [0.56, -0.10], [0.60, -0.58]);   // right body down
  A([0.66, -0.88]);                                              // right haunch base
  B([0.66, -0.88], [0.9, -0.74], [1.04, -0.34], [0.9, -0.04]);   // tail out + up
  B([0.9, -0.04], [0.8, -0.16], [0.74, -0.22], [0.66, -0.30]);   // tail curl tip
  A([0.5, -0.9], [-0.5, -0.9]);                                  // base bottom
  B([-0.5, -0.9], [-0.58, -0.5], [-0.54, -0.1], [-0.46, 0.20]);  // left body up
  A([-0.46, 0.42], [-0.40, 1.30]);                               // to left ear, close
  return p;
}
// SINGLE-LINE unicorn (one continuous stroke like Cameron's, NOT a filled
// silhouette): horn zigzag -> head -> neck -> belly with thin OUT-AND-BACK
// legs -> tail -> back -> mane. Legs come out thin because each is one street
// down and back, exactly how a runner draws them.
function uniline(): LL[] {
  // legs are PURE vertical spurs (down and back up the SAME line) so they
  // retrace one street = clean thin leg. Needs trimNubs OFF (traceOpts.trim).
  return [
    [0.06, 0.55], [0.14, 0.72], [0.06, 0.80], [0.16, 0.98], [0.10, 1.05],  // horn up
    [0.02, 0.90], [0.10, 0.82], [0.00, 0.66], [0.04, 0.56],                // horn down
    [0.16, 0.62], [0.22, 0.50],                                            // ear
    [0.36, 0.40], [0.46, 0.30], [0.42, 0.24],                             // face + muzzle
    [0.34, 0.30], [0.28, 0.36],                                            // jaw
    [0.22, 0.14], [0.20, -0.02],                                          // neck to chest
    [0.20, -0.76], [0.20, -0.02],                                         // front leg 1 (spur)
    [0.06, -0.02], [0.06, -0.76], [0.06, -0.02],                          // front leg 2 (spur)
    [-0.34, -0.04], [-0.34, -0.76], [-0.34, -0.04],                       // hind leg 1 (spur)
    [-0.50, -0.04], [-0.50, -0.76], [-0.50, -0.04],                       // hind leg 2 (spur)
    [-0.68, 0.04],
    [-0.82, -0.10], [-0.92, -0.34], [-0.86, -0.36], [-0.74, -0.10], [-0.66, 0.06], // tail
    [-0.5, 0.16], [-0.28, 0.26], [-0.12, 0.34],                           // back
    [-0.04, 0.42], [0.04, 0.34], [0.10, 0.46], [0.04, 0.56],              // mane to horn base
  ] as LL[];
}
const SHAPES: Record<string, () => LL[]> = { circle, heart, apple, fish, swoosh, swooshstroke: swooshStroke, star, crescent, dog, unicorn, cat, uniline };

function place(unit: LL[], center: LL, scaleM: number, rotDeg: number): LL[] {
  const r = (rotDeg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return unit.map(([x, y]) => {
    const rx = x * cos - y * sin, ry = x * sin + y * cos;
    return [center[0] + (ry * scaleM) / M_PER_LAT, center[1] + (rx * scaleM) / mPerLng(center[0])] as LL;
  });
}

// ---- rendering ----
const TILE = 256;
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z; };
async function renderMap(chain: LL[], target: LL[], file: string, w = 1400, h = 1100) {
  let zoom = 14;
  for (let z = 16; z >= 11; z--) { const xs = chain.map((p) => lonToX(p[1], z)), ys = chain.map((p) => latToY(p[0], z)); if (Math.max(...xs) - Math.min(...xs) <= w * 0.82 && Math.max(...ys) - Math.min(...ys) <= h * 0.82) { zoom = z; break; } }
  const xs = chain.map((p) => lonToX(p[1], zoom)), ys = chain.map((p) => latToY(p[0], zoom));
  const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - w / 2, vy = (Math.min(...ys) + Math.max(...ys)) / 2 - h / 2;
  const tiles: sharp.OverlayOptions[] = [];
  // Strava style: clean pale CARTO map + thin single line (how real GPS art
  // is shown). Heavy red double-strokes on the busy OSM map made routes read
  // as clumsy blobs; this is the honest presentation.
  for (let tx = Math.floor(vx / TILE); tx <= Math.floor((vx + w) / TILE); tx++) for (let ty = Math.floor(vy / TILE); ty <= Math.floor((vy + h) / TILE); ty++) {
    const res = await fetch(`https://a.basemaps.cartocdn.com/light_all/${zoom}/${tx}/${ty}@2x.png`, { headers: { "User-Agent": "pace-casso route preview (dev)" } });
    if (!res.ok) continue;
    tiles.push({ input: await sharp(Buffer.from(await res.arrayBuffer())).resize(TILE, TILE).toBuffer(), left: Math.round(tx * TILE - vx), top: Math.round(ty * TILE - vy) });
  }
  const pth = (pts: LL[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"} ${(lonToX(p[1], zoom) - vx).toFixed(1)} ${(latToY(p[0], zoom) - vy).toFixed(1)}`).join(" ");
  const tgt = target.length ? `<path d="${pth(target)}" fill="none" stroke="#3aa0ff" stroke-width="2" stroke-dasharray="6 6" opacity="0.7"/>` : "";
  const overlay = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${tgt}<path d="${pth(chain)}" fill="none" stroke="#fc5200" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  await sharp({ create: { width: w, height: h, channels: 4, background: "#eaeaea" } }).composite([...tiles, { input: overlay, left: 0, top: 0 }]).png().toFile(file);
}

// resample a closed outline to n evenly-spaced points (by arc length)
function sampleOutline(outline: LL[], n: number): LL[] {
  let total = 0; const seg: number[] = [0];
  for (let i = 1; i < outline.length; i++) { total += meters(outline[i - 1], outline[i]); seg.push(total); }
  const out: LL[] = [];
  for (let k = 0; k < n; k++) {
    const d = (k / n) * total;
    let i = 1; while (i < seg.length && seg[i] < d) i++;
    const t = (d - seg[i - 1]) / (seg[i] - seg[i - 1] || 1);
    const a = outline[i - 1], b = outline[i];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}
// Ralph's insight: the DISTINCTIVE parts (a head-curve, a sharp point) are
// what make a design recognizable — so the placement must land THOSE on
// matching city geometry, not minimize average closeness (which flattens the
// features). Weight each outline sample by local curvature: sharp turns and
// tight curves count heavily, straight runs count ~0.
function curvatureWeights(pts: LL[]): number[] {
  const n = pts.length, w: number[] = [];
  const K = Math.max(2, Math.round(n / 40)); // window
  for (let i = 0; i < n; i++) {
    const a = pts[(i - K + n) % n], b = pts[i], c = pts[(i + K) % n];
    // turn angle at b between a->b and b->c
    const v1 = [(b[0] - a[0]) * 111320, (b[1] - a[1]) * mPerLng(a[0])];
    const v2 = [(c[0] - b[0]) * 111320, (c[1] - b[1]) * mPerLng(b[0])];
    const d1 = Math.hypot(v1[0], v1[1]) || 1, d2 = Math.hypot(v2[0], v2[1]) || 1;
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (d1 * d2);
    w[i] = 0.15 + (1 - Math.max(-1, Math.min(1, cos))); // 0.15 baseline .. ~2.15 at a U-turn
  }
  return w;
}
// Feature-weighted placement score. Also checks that the city actually TURNS
// where the design turns (a curve wants a real curve/junction under it), not
// just that a road is nearby. Lower is better.
function coarseScore(g: Graph, outline: LL[]): { score: number; miss: number } {
  const pts = sampleOutline(outline, 72);
  const w = curvatureWeights(pts);
  let wsum = 0, acc = 0, miss = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const nd = nearestNode(g, p);
    const d = nd < 0 ? 500 : meters(p, g.coord.get(nd)!);
    if (d > 130) miss++;
    // feature points additionally need the road to bend there: a lone straight
    // road under a design-curve can't render it. Reward matching curvature.
    let bendPenalty = 0;
    if (w[i] > 0.9 && nd >= 0) {
      const nbrs = (g.adj.get(nd) ?? []).map((e) => g.coord.get(e.to)!);
      // max turn available at this junction (junctions with >2 legs / real
      // corners can carry a feature; a mid-block node with 2 collinear legs can't)
      let bestTurn = 0;
      for (let a = 0; a < nbrs.length; a++) for (let b = a + 1; b < nbrs.length; b++) {
        const c = g.coord.get(nd)!;
        const v1 = [(nbrs[a][0] - c[0]), (nbrs[a][1] - c[1])];
        const v2 = [(nbrs[b][0] - c[0]), (nbrs[b][1] - c[1])];
        const dd = (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1])) || 1;
        const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / dd;
        bestTurn = Math.max(bestTurn, 1 - cos);
      }
      // design wants turn w[i]; penalize if the city can't provide it
      bendPenalty = Math.max(0, w[i] - bestTurn) * 120;
    }
    acc += w[i] * Math.min(d, 300) + bendPenalty;
    wsum += w[i];
  }
  return { score: acc / (wsum || 1) + miss * 40, miss };
}

// Search the whole map for the placement (center, scale, rotation) where the
// city's streets best trace this shape — Ralph's "find where the city wants
// to draw it". Coarse-score a grid of placements, then fully trace the best.
async function search(shape: string, g: Graph) {
  const unit = SHAPES[shape]();
  // Manhattan-ish sweep box
  const cands: { center: LL; scale: number; rot: number; score: number; miss: number }[] = [];
  for (let lat = 40.710; lat <= 40.792; lat += 0.006)
    for (let lng = -74.012; lng <= -73.938; lng += 0.006)
      for (const scale of [1400, 2000, 2700, 3400])
        for (const rot of [0, 15, -15, 29, -29]) {
          const outline = place(unit, [lat, lng], scale, rot);
          const { score, miss } = coarseScore(g, outline);
          if (miss <= 8) cands.push({ center: [lat, lng], scale, rot, score, miss });
        }
  cands.sort((a, b) => a.score - b.score);
  console.log(`scored ${cands.length} placements; tracing top 6...`);
  // de-dup near-identical top placements (spread the picks out)
  const picks: typeof cands = [];
  for (const c of cands) {
    if (picks.length >= 6) break;
    if (picks.some((p) => meters(p.center, c.center) < 500 && Math.abs(p.scale - c.scale) < 300)) continue;
    picks.push(c);
  }
  const traced: { i: number; km: number; dev: number; chain: LL[]; target: LL[]; meta: typeof picks[0] }[] = [];
  for (let i = 0; i < picks.length; i++) {
    const pk = picks[i];
    const target = place(unit, pk.center, pk.scale, pk.rot);
    const chain = traceContour(g, target, { anchorM: 200, lambda: 12, corridorM: 90 });
    let dev = 0; for (const p of chain) { let m = Infinity; for (let j = 1; j < target.length; j++) { const dd = distToSeg(p, target[j - 1], target[j]); if (dd < m) m = dd; } dev += m; }
    let km = 0; for (let j = 1; j < chain.length; j++) km += meters(chain[j - 1], chain[j]);
    dev /= (chain.length || 1);
    traced.push({ i, km, dev, chain, target, meta: pk });
    console.log(`  #${i} score=${pk.score.toFixed(0)} @${pk.center[0].toFixed(3)},${pk.center[1].toFixed(3)} scale=${pk.scale} rot=${pk.rot} -> ${km.toFixed(1)}km dev=${dev.toFixed(1)}m`);
  }
  traced.sort((a, b) => a.dev - b.dev);
  const OUT = path.join(process.cwd(), "tmp-trace", `search-${shape}`);
  await fs.mkdir(OUT, { recursive: true });
  // clean best (route only, for honest judging) + a couple ranked with target
  await renderMap(traced[0].chain, [], path.join(OUT, "best.png"), 1000, 820);
  for (let r = 0; r < Math.min(2, traced.length); r++) {
    await renderMap(traced[r].chain, traced[r].target, path.join(OUT, `rank${r}-dev${traced[r].dev.toFixed(0)}.png`), 900, 750);
  }
  console.log(`best: ${shape} rank0 dev=${traced[0].dev.toFixed(1)}m ${traced[0].km.toFixed(1)}km @${traced[0].meta.center[0].toFixed(3)},${traced[0].meta.center[1].toFixed(3)} scale=${traced[0].meta.scale} rot=${traced[0].meta.rot}`);
}

async function main() {
  if (process.argv[2] === "search") { console.log("building graph..."); const g = await buildGraph(); await search(process.argv[3] ?? "apple", g); return; }
  if (process.argv[2] === "searchmany") {
    console.log("building graph..."); const g = await buildGraph();
    for (const s of process.argv.slice(3)) { console.log(`\n=== ${s} ===`); await search(s, g); }
    return;
  }
  const shape = process.argv[2] ?? "circle";
  const center: LL = [Number(process.argv[3] ?? 40.758), Number(process.argv[4] ?? -73.978)];
  const scaleM = Number(process.argv[5] ?? 1500);
  const rot = Number(process.argv[6] ?? 0);
  const lambda = Number(process.argv[7] ?? 6);
  const corridorM = Number(process.argv[8] ?? 140);
  if (!SHAPES[shape]) throw new Error(`unknown shape ${shape}`);
  const OUT = path.join(process.cwd(), "tmp-trace", shape);
  await fs.mkdir(OUT, { recursive: true });

  console.log("building road graph...");
  const g = await buildGraph();
  console.log(`graph: ${g.adj.size} nodes`);
  const target = place(SHAPES[shape](), center, scaleM, rot);
  const chain = traceContour(g, target, { anchorM: 200, lambda, corridorM });
  // smoothness: mean deviation of chain from target contour
  let sum = 0;
  for (const p of chain) { let m = Infinity; for (let i = 1; i < target.length; i++) { const dd = distToSeg(p, target[i - 1], target[i]); if (dd < m) m = dd; } sum += m; }
  let km = 0; for (let i = 1; i < chain.length; i++) km += meters(chain[i - 1], chain[i]);
  console.log(`${shape}: ${(km / 1000).toFixed(1)} km, ${chain.length} pts, meanDev ${(sum / chain.length).toFixed(1)} m`);
  await renderMap(chain, target, path.join(OUT, "map.png"));
  await renderMap(chain, [], path.join(OUT, "map-clean.png")); // route only, for blind judging
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="PaceCasso"><trk><name>${shape}</name><trkseg>\n${chain.map(([la, ln]) => `<trkpt lat="${la.toFixed(7)}" lon="${ln.toFixed(7)}"></trkpt>`).join("\n")}\n</trkseg></trk></gpx>`;
  await fs.writeFile(path.join(OUT, `${shape}.gpx`), gpx, "utf8");
  console.log("  wrote", path.join("tmp-trace", shape, "map.png"));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
