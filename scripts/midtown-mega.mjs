/**
 * Mega-scale designs: 14th–59th St canvas. Scale is the smoothness knob —
 * at this size one-block stairsteps read as curves (see lion.webp).
 *
 * Run: node scripts/midtown-mega.mjs [gasmega|all]
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadNetwork, haversine } from "./gas-spike-lattice.mjs";

const ROWS = {}; // R0 = 14th ... R45 = 59th
for (let i = 0; i <= 45; i++) {
  const n = 14 + i;
  const suf = n % 10 === 1 && n % 100 !== 11 ? "st"
    : n % 10 === 2 && n % 100 !== 12 ? "nd"
    : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  ROWS[`R${i}`] = `West ${n}${suf} Street`;
}
const COLS = {
  A11: "11th Avenue", A10: "10th Avenue", A9: "9th Avenue", A8: "8th Avenue",
  A7: "7th Avenue", A6: "6th Avenue", A5: "5th Avenue", AMad: "Madison Avenue",
  APark: "Park Avenue", APS: "Park Avenue South", ALex: "Lexington Avenue",
  A3: "3rd Avenue", A2: "2nd Avenue", A1: "1st Avenue",
};

/**
 * GAS logo, lion-scale (~2.3 km square, 14th–39th St).
 * Pump: 11th–8th x 16th–38th, chamfered top shoulders, fully inset window.
 * Hose: out on 26th, big loop 19th–26th (6th/7th), rise crossing itself,
 * nozzle at 33rd into the left ear cup.
 * Person: octagonal head 5th–Lex x 31st–37th (corner cuts via Mad/Park),
 * ear cups outside, floating band on 39th, torso 5th–ParkS, legs to 14th.
 */
const GASMEGA = [
  // ---- pump: 11th-8th x 22nd-46th, flat top, inset window 10th-9th x 36th-42nd
  ["A8", "R20"],  // start at hose port (8th & 34th)
  ["A8", "R32"],  // right edge upper (to 46th)
  ["A11", "R32"], // pump top (46th)
  ["A11", "R22"], // left edge upper (to 36th; clean stretch of 11th)
  ["A10", "R22"], // spur east to window corner (36th)
  ["A10", "R28"], // window left edge (up to 42nd)
  ["A9", "R28"],  // window top
  ["A9", "R22"],  // window right edge (down)
  ["A10", "R22"], // window bottom (close)
  ["A11", "R22"], // RT spur back to pump edge
  ["A11", "R8"],  // left edge lower (down to 22nd; walk-graph bridges Javits)
  ["A8", "R8"],   // pump bottom (22nd)
  ["A8", "R20"],  // right edge lower -> back at port
  // ---- hose: out on 34th, squat loop, rise crossing at 7th & 34th ----
  ["A6", "R20"],  // out east along 34th (passes 7th at Herald Sq side)
  ["A6", "R13"],  // drop on 6th to 27th
  ["A7", "R13"],  // loop bottom west (27th)
  ["A7", "R30"],  // rise on 7th to 44th — CROSSES out-line at 34th
  ["A5", "R30"],  // nozzle east on 44th -> left cup outer edge
  // ---- left ear cup (5th-Mad x 42nd-45th) ----
  ["A5", "R28"],  // cup outer edge (down to 42nd)
  ["AMad", "R28"],// cup bottom (east, meets head left edge)
  // ---- head (Mad-Lex x 40th-47th; Park runs inside, undrawn) ----
  ["AMad", "R26"],// head left edge, lower part (down to 40th)
  ["ALex", "R26"],// head bottom (40th)
  ["ALex", "R33"],// head right edge (up to 47th)
  ["AMad", "R33"],// head top (47th — clear of Helmsley at Park)
  ["AMad", "R28"],// head left edge upper (down) -> cup junction
  // ---- close left cup ----
  ["AMad", "R31"],// RT up head edge (45th)
  ["A5", "R31"],  // cup top (west)
  ["A5", "R30"],  // cup outer edge upper -> nozzle junction
  // ---- headphone band: tight halo riding the head top ----
  ["A5", "R31"],  // RT up cup edge
  ["AMad", "R31"],// RT east along cup top to head edge
  ["AMad", "R33"],// RT up head edge to head top corner
  ["AMad", "R34"],// band riser (48th)
  ["ALex", "R34"],// band across, exactly head width
  ["ALex", "R33"],// band riser down -> head top-right corner
  // ---- right ear cup (Lex-3rd x 42nd-45th) ----
  ["ALex", "R31"],// RT down head edge to cup top level
  ["A3", "R31"],  // cup top (east)
  ["A3", "R28"],  // cup outer edge (down)
  ["ALex", "R28"],// cup bottom (west, meets head edge)
  // ---- torso 5th-Lex x 28th-40th, legs to 22nd ----
  ["ALex", "R26"],// RT down head edge to shoulder corner
  ["ALex", "R14"],// torso right edge (down to 28th)
  ["APS", "R14"], // hip bar, east half (28th)
  ["APS", "R8"],  // right leg (Park Ave South down to 22nd)
  ["ALex", "R8"], // right foot (east along 22nd)
  ["APS", "R8"],  // RT west
  ["APS", "R14"], // RT up right leg
  ["A5", "R14"],  // hip bar, west half
  ["A5", "R8"],   // left leg (down)
  ["A6", "R8"],   // left foot (west along 22nd)
  ["A5", "R8"],   // RT east
  ["A5", "R14"],  // RT up left leg
  ["A5", "R26"],  // torso left edge (up to 40th)
  ["AMad", "R26"],// shoulders west half -> meets head bottom-left
  // ---- hanging arm (sprouts below the shoulder) ----
  ["ALex", "R26"],// RT east along head bottom / shoulders
  ["ALex", "R24"],// RT down torso edge to armpit (38th)
  ["A3", "R24"],  // arm out east (38th)
  ["A3", "R16"],  // forearm down 3rd (to 30th) -> end
];

/**
 * NIKE lockup: swoosh (34th-45th, 11th-2nd Ave) over stacked JUST / DO IT.
 * Swoosh is one closed loop; letters chain with short connectors; the only
 * off-glyph ink is two short vertical ticks (swoosh->J, JUST->DO IT).
 */
const NIKE = [
  // ---- swoosh: closed outline, start bottom-left at 10th & 35th ----
  ["A10", "R21"],
  ["A9", "R21"],  // bottom edge eastward
  ["A9", "R20"],
  ["A7", "R20"],  // belly sag flat along 34th
  ["A7", "R21"],
  ["A6", "R21"],
  ["A6", "R22"],
  ["A5", "R22"],
  ["A5", "R24"],
  ["AMad", "R24"],
  ["AMad", "R25"],
  ["APark", "R25"],
  ["APark", "R26"], // 39th->40th, stops at GCT boundary
  ["ALex", "R26"],
  ["ALex", "R27"],
  ["A3", "R27"],
  ["A3", "R29"],
  ["A2", "R29"],
  ["A2", "R31"],  // tail point (45th & 2nd)
  // top edge back westward
  ["A3", "R31"],
  ["A3", "R30"],
  ["ALex", "R30"],
  ["ALex", "R28"],
  ["AMad", "R28"], // flat along 42nd, crossing Park at street level
  ["AMad", "R26"],
  ["A5", "R26"],
  ["A5", "R25"],
  ["A6", "R25"],
  ["A6", "R24"],
  ["A8", "R24"],
  ["A8", "R23"],
  ["A9", "R23"],  // knee notch (37th, 8th-9th)
  ["A9", "R24"],
  ["A10", "R24"],
  ["A10", "R26"],
  ["A11", "R26"], // tip top corner (40th & 11th)
  ["A11", "R23"], // blunt tip end cap
  ["A11", "R22"],
  ["A10", "R22"],
  ["A10", "R21"], // loop closes
  // ---- connector down to JUST (short tick on 10th) ----
  ["A10", "R17"],
  // ---- J (10th-9th x 26th-31st; rail runs a row lower on 25th) ----
  ["A9", "R17"],  // top bar
  ["A9", "R12"],  // stem (right side)
  ["A10", "R12"], // bottom bar
  ["A10", "R13"], // hook tick up
  ["A10", "R12"], // RT down
  ["A9", "R12"],  // RT east
  ["A9", "R11"],  // drop to rail (25th)
  ["A8", "R11"],  // rail east
  ["A8", "R12"],  // riser
  // ---- U (8th-7th) ----
  ["A8", "R17"],  // left stem
  ["A8", "R12"],  // RT down
  ["A7", "R12"],  // bottom
  ["A7", "R17"],  // right stem
  ["A7", "R12"],  // RT down
  ["A7", "R11"],  // drop to rail
  ["A6", "R11"],  // rail east
  ["A6", "R12"],  // riser
  // ---- S (6th-5th, drawn from bottom-left) ----
  ["A5", "R12"],  // bottom bar
  ["A5", "R15"],  // lower-right stem
  ["A6", "R15"],  // middle bar
  ["A6", "R17"],  // upper-left stem
  ["A5", "R17"],  // top bar
  // ---- T (Mad-Lex, stem on Park Ave South) ----
  ["AMad", "R17"],// connector along cap (short, letters kiss)
  ["ALex", "R17"],// full bar east
  ["APS", "R17"], // RT west to stem
  ["APS", "R12"], // stem (down) -> JUST ends here
  // ---- connector down to DO IT (short tick on Park Ave South) ----
  ["APS", "R9"],
  // ---- T of DO IT (Mad-Lex bar at 23rd, stem PAS 18th-23rd) ----
  ["AMad", "R9"], // bar west half (23rd — Madison's first block)
  ["APS", "R9"],  // RT east
  ["ALex", "R9"], // bar east half
  ["APS", "R9"],  // RT west
  ["APS", "R4"],  // stem down to 18th
  // ---- I (5th) ----
  ["A5", "R4"],   // connector along 18th
  ["A5", "R9"],   // stem up
  ["A5", "R4"],   // RT down
  // ---- O (8th-7th) ----
  ["A7", "R4"],   // connector (word space)
  ["A7", "R9"],   // right side up
  ["A8", "R9"],   // top
  ["A8", "R4"],   // left side down
  ["A7", "R4"],   // bottom (close)
  ["A8", "R4"],   // RT west
  // ---- D (10th-9th) ----
  ["A9", "R4"],   // connector
  ["A9", "R9"],   // right side up
  ["A10", "R9"],  // top
  ["A10", "R4"],  // left side down
  ["A9", "R4"],   // bottom (close) -> end of run
];

/**
 * NIKE v2 — block letters. Swoosh 43rd-54th; JUST (28th-40th) and DO IT
 * (14th-26th) as closed-outline block letters, 3 avenue-gaps wide each.
 * Counters in D/O open through the bottom bar (stencil slits) so every
 * letter is one closed loop. Adjacent letters share wall corridors; the
 * pen chains letters by retracing already-drawn edges (invisible).
 */
const NIKEBLOCK = [
  // ---- swoosh (43rd-54th), loop starts at belly SW corner 9th&43rd ----
  ["A9", "R29"],
  ["A7", "R29"], ["A7", "R30"], ["A6", "R30"], ["A6", "R31"], ["A5", "R31"],
  ["A5", "R33"], ["AMad", "R33"], ["AMad", "R35"],
  ["ALex", "R35"], ["ALex", "R36"], ["A3", "R36"],
  ["A3", "R38"], ["A2", "R38"], ["A2", "R40"],
  ["A3", "R40"], ["A3", "R39"], ["ALex", "R39"], ["ALex", "R37"],
  ["AMad", "R37"], ["AMad", "R35"], ["A5", "R35"], ["A5", "R34"],
  ["A6", "R34"], ["A6", "R33"], ["A8", "R33"], ["A8", "R32"], ["A9", "R32"],
  ["A9", "R33"], ["A10", "R33"], ["A10", "R35"], ["A11", "R35"],
  ["A11", "R32"], ["A11", "R31"], ["A10", "R31"], ["A10", "R30"],
  ["A9", "R30"], ["A9", "R29"],
  // ---- connector onto J's stem cap (3 rows) ----
  ["A9", "R26"],
  // ---- J: stem 9th-8th x 28th-40th, foot + hook bottom-left, no top bar ----
  ["A8", "R26"],  // stem top cap
  ["A8", "R14"],  // stem right wall down (shared with U)
  ["A11", "R14"], // baseline west
  ["A11", "R19"], // hook outer wall up (33rd, clear of 11th Ave gaps)
  ["A10", "R19"], // hook top
  ["A10", "R16"], // hook inner wall down
  ["A9", "R16"],  // foot top edge east
  ["A9", "R26"],  // stem left wall up -> close
  ["A8", "R26"],  // RT east along stem cap to U corner
  // ---- U [8..5]: strokes 8-7 / 6-5, counter open at top ----
  ["A8", "R14"],  // left outer wall (RT over J's stem wall)
  ["A5", "R14"],  // U bottom
  ["A5", "R26"],  // right outer wall up
  ["A6", "R26"],  // right stroke top cap
  ["A6", "R16"],  // counter right wall down
  ["A7", "R16"],  // counter bottom
  ["A7", "R26"],  // counter left wall up
  ["A8", "R26"],  // left stroke top cap -> close
  ["A8", "R14"],  // RT down shared wall
  ["A5", "R14"],  // RT east along U bottom to S corner
  // ---- S [5..Lex]: PS walls only 30th-32nd (below the Park rename) ----
  ["A5", "R16"],
  ["APS", "R16"],   // bottom bar top edge
  ["APS", "R18"],   // lower-right stroke left wall (30th-32nd)
  ["A5", "R18"],    // middle bar bottom edge
  ["A5", "R26"],    // left wall up
  ["ALex", "R26"],  // top bar top edge
  ["ALex", "R24"],
  ["AMad", "R24"],  // under top bar
  ["AMad", "R20"],  // upper-left stroke right wall
  ["ALex", "R20"],  // middle bar top edge
  ["ALex", "R14"],  // right wall down
  ["A5", "R14"],    // S bottom -> close
  // ---- T (JUST): bar [3..1] x 38th-40th, stem 3rd-2nd x 28th-38th ----
  ["ALex", "R14"],  // RT east along S bottom
  ["A3", "R14"],    // underline hop Lex->3rd (new ink)
  ["A3", "R26"],    // stem+bar left wall up
  ["A1", "R26"],    // bar top east
  ["A1", "R24"],    // bar east end cap
  ["A2", "R24"],    // bar underside west
  ["A2", "R14"],    // stem right wall down
  ["A3", "R14"],    // stem bottom -> close (JUST done)
  // ---- travel west along baseline (retrace) then drop to DO IT ----
  ["ALex", "R14"], ["A5", "R14"], ["A8", "R14"], ["A11", "R14"],
  ["A11", "R12"],   // connector onto D's top-left corner (new, 1 row)
  // ---- D [11..8] x 14th-26th: chamfered SW corner (aves converge at 14th),
  //      notch dodges the 11th Ave gap at 21st-22nd, counter on chamfer ----
  ["A8", "R12"],    // top bar east
  ["A8", "R0"],     // right wall down
  ["A10", "R0"],    // bottom bar west (stops short of the pinch)
  ["A10", "R2"],    // chamfer up
  ["A11", "R2"],    // chamfer out to 11th
  ["A11", "R7"],    // left wall up to 21st
  ["A10", "R7"],    // notch in
  ["A10", "R8"],    // notch up
  ["A11", "R8"],    // notch out
  ["A11", "R12"],   // left wall up -> close outer
  ["A11", "R8"], ["A10", "R8"], ["A10", "R7"], ["A11", "R7"], ["A11", "R2"],
  ["A10", "R2"],    // RT down left wall + notch + chamfer to counter anchor
  ["A10", "R10"],   // counter left wall up (new)
  ["A9", "R10"],    // counter top
  ["A9", "R2"],     // counter right wall down
  ["A10", "R2"],    // counter bottom -> close on chamfer corner
  ["A10", "R0"],    // RT chamfer down
  ["A8", "R0"],     // RT east along D bottom
  // ---- O [8..5]: bridged counter ----
  ["A5", "R0"],     // bottom bar east
  ["A5", "R12"],    // right wall up
  ["A8", "R12"],    // top bar west
  ["A8", "R0"],     // left wall down (RT over D right wall) -> close
  ["A7", "R0"],     // RT east along bottom to bridge point
  ["A7", "R2"],     // bridge up (new, 160 m)
  ["A7", "R10"],    // counter left wall
  ["A6", "R10"],    // counter top
  ["A6", "R2"],     // counter right wall
  ["A7", "R2"],     // counter bottom -> close
  ["A7", "R0"],     // RT bridge down
  ["A5", "R0"],     // RT east along O bottom
  // ---- word space hop (new ink, ~220 m along 14th) ----
  ["APS", "R0"],
  // ---- I [PS..3] x 14th-26th: narrow block ----
  ["APS", "R12"],
  ["A3", "R12"],
  ["A3", "R0"],
  ["APS", "R0"],    // close
  ["A3", "R0"],     // RT east along I bottom
  ["A3", "R10"],    // RT up I right wall to bar underside level
  // ---- T (DO IT): bar [3..1] x 24th-26th kissing I's head,
  //      stem 2nd-1st x 14th-24th, empty gap 3rd-2nd under bar ----
  ["A3", "R12"],    // RT up I wall (bar left cap shares it)
  ["A1", "R12"],    // bar top east
  ["A1", "R0"],     // bar cap + stem right wall down
  ["A2", "R0"],     // stem bottom west
  ["A2", "R10"],    // stem left wall up
  ["A3", "R10"],    // bar underside west -> close, END
];

/**
 * GAS logo v5 — block-silhouette grammar (nikeblock lessons applied).
 * Pump [11..8] x 22nd-46th: chamfered top, notch dodges 11th Ave 30-33 gap,
 * window = stencil counter bridged off the left shoulder.
 * Hose: out on 34th, loop down 6th/27th, rises on 7th CROSSING itself at
 * 7th&34th, nozzle on 44th into the left ear cup.
 * Person: single closed loop — head (Mad-Lex x 40-47, Park inside undrawn),
 * ear cups both sides, block torso [5..Lex] x 28-40, block legs with crotch
 * gap (5-Mad / PS-Lex x 23-28), block hanging arm (Lex-3 x 32-38).
 * Headphone band: riser 5th, across 49th, riser 3rd — arcs cup to cup.
 */
const GASBLOCK = [
  // ---- window counter (start at left-shoulder corner, bridge down) ----
  ["A10", "R30"],
  ["A10", "R28"],  // bridge (new, 160 m)
  ["A10", "R22"],  // window left wall
  ["A9", "R22"],   // window bottom
  ["A9", "R28"],   // window right wall
  ["A10", "R28"],  // window top -> close
  ["A10", "R30"],  // RT bridge up
  // ---- pump outline (chamfered top, notched left wall) ----
  ["A10", "R32"],  // left shoulder up
  ["A9", "R32"],   // top cap (46th)
  ["A9", "R30"],   // right shoulder down
  ["A8", "R30"],   // shoulder out to right wall
  ["A8", "R8"],    // right wall down (22nd)
  ["A11", "R8"],   // pump bottom
  ["A11", "R16"],  // left wall up to 30th
  ["A10", "R16"],  // notch in (11th Ave dead 30th-33rd)
  ["A10", "R19"],  // notch up
  ["A11", "R19"],  // notch out
  ["A11", "R30"],  // left wall up to 44th
  ["A10", "R30"],  // shoulder in -> close
  // ---- travel to hose port (retrace along shoulders + right wall) ----
  ["A10", "R32"], ["A9", "R32"], ["A9", "R30"], ["A8", "R30"],
  ["A8", "R20"],   // RT down right wall to port (34th)
  // ---- hose: out, loop, rise through itself, nozzle ----
  ["A6", "R20"],   // out east along 34th (crosses 7th)
  ["A6", "R13"],   // down 6th to 27th
  ["A7", "R13"],   // loop bottom west
  ["A7", "R30"],   // rise on 7th — CROSSES the out-line at 7th & 34th
  ["A5", "R30"],   // nozzle east on 44th -> lands on left ear cup wall
  // ---- person: one closed loop ----
  ["A5", "R31"],   // cup outer wall up (entry was mid-wall)
  ["AMad", "R31"], // left cup top
  ["AMad", "R33"], // head left edge upper
  ["ALex", "R33"], // head top (47th; Park crossed mid-edge)
  ["ALex", "R31"], // head right edge upper
  ["A3", "R31"],   // right cup top
  ["A3", "R28"],   // right cup outer wall
  ["ALex", "R28"], // right cup bottom
  ["ALex", "R26"], // head right edge lower (to shoulder, 40th)
  ["ALex", "R24"], // torso right wall to armpit
  ["A3", "R24"],   // arm top (38th)
  ["A3", "R18"],   // arm outer wall (down 3rd)
  ["ALex", "R18"], // arm bottom (32nd)
  ["ALex", "R14"], // torso right wall to hip (28th)
  ["ALex", "R9"],  // right leg outer wall (to 23rd)
  ["APS", "R9"],   // right leg bottom
  ["APS", "R14"],  // right leg inner wall up
  ["AMad", "R14"], // crotch bar (28th)
  ["AMad", "R9"],  // left leg inner wall down
  ["A5", "R9"],    // left leg bottom
  ["A5", "R14"],   // left leg outer wall up
  ["A5", "R26"],   // torso left wall (to shoulder, 40th)
  ["AMad", "R26"], // west shoulder in
  ["AMad", "R28"], // head left edge lower
  ["A5", "R28"],   // left cup bottom
  ["A5", "R30"],   // cup outer wall -> close at nozzle
  // ---- headphone band: arcs cup-to-cup over the head ----
  ["A5", "R31"],   // RT up cup wall
  ["A5", "R35"],   // band riser west (new, to 49th)
  ["A3", "R35"],   // band across 49th (Park crossed mid-edge, verified row)
  ["A3", "R31"],   // band riser east -> attaches at right cup top, END
];

const DESIGNS = { gasmega: GASMEGA, nike: NIKE, nikeblock: NIKEBLOCK, gasblock: GASBLOCK };

const net = await loadNetwork();
const { nodes, intersectionOf, corridorPath, walkPath } = net;

function resolve([colKey, rowKey]) {
  const id = intersectionOf(COLS[colKey], ROWS[rowKey]);
  if (!id) throw new Error(`no intersection: ${COLS[colKey]} & ${ROWS[rowKey]}`);
  return id;
}

function maxDeviation(pathIds, a, b) {
  const pa = nodes.get(a);
  const pb = nodes.get(b);
  const latM = 111320;
  const lonM = latM * Math.cos((pa[0] * Math.PI) / 180);
  const bx = (pb[1] - pa[1]) * lonM, by = (pb[0] - pa[0]) * latM;
  const len = Math.hypot(bx, by) || 1;
  let max = 0;
  for (const id of pathIds) {
    const p = nodes.get(id);
    const px = (p[1] - pa[1]) * lonM, py = (p[0] - pa[0]) * latM;
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / (len * len)));
    max = Math.max(max, Math.hypot(px - t * bx, py - t * by));
  }
  return max;
}

async function buildDesign(name, waypoints) {
  const outDir = path.join(process.cwd(), "tmp-designs", name);
  await fs.mkdir(outDir, { recursive: true });

  const legReports = [];
  const coordIds = [];
  for (let i = 1; i < waypoints.length; i++) {
    const [c0k, r0k] = waypoints[i - 1];
    const [c1k, r1k] = waypoints[i];
    const from = resolve(waypoints[i - 1]);
    const to = resolve(waypoints[i]);
    if (from === to) continue;
    const corridorName = c0k === c1k ? COLS[c0k] : r0k === r1k ? ROWS[r0k] : null;
    if (!corridorName) throw new Error(`diagonal leg: ${c0k}/${r0k} -> ${c1k}/${r1k}`);
    const pathLen = (ids) => {
      let m = 0;
      for (let k = 1; k < ids.length; k++) m += haversine(nodes.get(ids[k - 1]), nodes.get(ids[k]));
      return m;
    };
    let p = corridorPath(corridorName, from, to);
    let via = "corridor";
    const chordM = haversine(nodes.get(from), nodes.get(to));
    if (!p || pathLen(p) > chordM * 1.25) {
      const w = walkPath(from, to);
      if (w && (!p || pathLen(w) < pathLen(p))) { p = w; via = "walk-graph"; }
    }
    if (!p) throw new Error(`unroutable: ${corridorName} ${c0k}/${r0k} -> ${c1k}/${r1k}`);
    const dev = maxDeviation(p, from, to);
    let m = 0;
    for (let k = 1; k < p.length; k++) m += haversine(nodes.get(p[k - 1]), nodes.get(p[k]));
    legReports.push({
      leg: `${c0k}/${r0k} -> ${c1k}/${r1k}`, corridor: corridorName, via,
      meters: Math.round(m), chord: Math.round(chordM),
      maxDeviationM: Math.round(dev),
      detourRatio: Number((m / Math.max(chordM, 1)).toFixed(2)),
    });
    if (coordIds.length === 0) coordIds.push(...p);
    else coordIds.push(...p.slice(1));
  }

  const coords = coordIds.map((id) => nodes.get(id));
  let totalM = 0, maxHop = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1], coords[i]);
    totalM += d;
    maxHop = Math.max(maxHop, d);
  }
  const bad = legReports.filter((l) => l.maxDeviationM > 45 || l.detourRatio > 1.3);
  console.log(`[${name}] legs ${legReports.length}, ${(totalM / 1000).toFixed(1)} km, maxHop ${Math.round(maxHop)} m, fallback ${legReports.filter((l) => l.via !== "corridor").length}, problem legs ${bad.length}`);
  for (const l of bad) console.log("   PROBLEM", JSON.stringify(l));

  await fs.writeFile(path.join(outDir, "route.json"), JSON.stringify({
    km: Number((totalM / 1000).toFixed(2)), maxHopM: Math.round(maxHop), coords, legs: legReports,
  }, null, 2));

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PaceCasso" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${name} — Midtown mega</name><trkseg>
${coords.map(([lat, lon]) => `    <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"></trkpt>`).join("\n")}
  </trkseg></trk>
</gpx>`;
  await fs.writeFile(path.join(outDir, `${name}.gpx`), gpx);

  // upright silhouette
  {
    const latM = 111320;
    const c0 = coords[0];
    const lonM = latM * Math.cos((c0[0] * Math.PI) / 180);
    const th = (28.9 * Math.PI) / 180;
    const pts = coords.map(([lat, lon]) => {
      const x = (lon - c0[1]) * lonM, y = (lat - c0[0]) * latM;
      return [x * Math.cos(th) - y * Math.sin(th), -(x * Math.sin(th) + y * Math.cos(th))];
    });
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = 1000, H = 1000, pad = 60;
    const s = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / (maxY - minY));
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${(pad + (p[0] - minX) * s).toFixed(1)} ${(pad + (p[1] - minY) * s).toFixed(1)}`).join(" ");
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="white"/><path d="${d}" fill="none" stroke="black" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(outDir, "upright.png"));
  }

  // map render
  {
    const width = 1300, height = 1300, tileSize = 256;
    const lonToX = (lon, z) => ((lon + 180) / 360) * tileSize * 2 ** z;
    const latToY = (lat, z) => {
      const r = (lat * Math.PI) / 180;
      return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * tileSize * 2 ** z;
    };
    let zoom = 16;
    for (; zoom >= 11; zoom--) {
      const xs = coords.map(([, lon]) => lonToX(lon, zoom));
      const ys = coords.map(([lat]) => latToY(lat, zoom));
      if (Math.max(...xs) - Math.min(...xs) <= width * 0.88 &&
          Math.max(...ys) - Math.min(...ys) <= height * 0.88) break;
    }
    const xs = coords.map(([, lon]) => lonToX(lon, zoom));
    const ys = coords.map(([lat]) => latToY(lat, zoom));
    const vx = (Math.min(...xs) + Math.max(...xs)) / 2 - width / 2;
    const vy = (Math.min(...ys) + Math.max(...ys)) / 2 - height / 2;
    const screen = ([lat, lon]) => [lonToX(lon, zoom) - vx, latToY(lat, zoom) - vy];
    const pathD = coords.map((c, i) => {
      const [x, y] = screen(c);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    const tiles = [];
    for (let tx = Math.floor(vx / tileSize); tx <= Math.floor((vx + width) / tileSize); tx++) {
      for (let ty = Math.floor(vy / tileSize); ty <= Math.floor((vy + height) / tileSize); ty++) {
        try {
          const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
            headers: { "User-Agent": "pace-casso-gps-art-spike/1.0" },
          });
          if (!res.ok) continue;
          tiles.push({
            input: Buffer.from(await res.arrayBuffer()),
            left: Math.round(tx * tileSize - vx),
            top: Math.round(ty * tileSize - vy),
          });
        } catch { /* skip */ }
      }
    }
    const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <path d="${pathD}" fill="none" stroke="white" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
      <path d="${pathD}" fill="none" stroke="#fc4c02" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`);
    await sharp({ create: { width, height, channels: 4, background: "#eee" } })
      .composite([...tiles, { input: overlay, left: 0, top: 0 }])
      .png().toFile(path.join(outDir, "map.png"));
  }
  return { name, km: Number((totalM / 1000).toFixed(2)) };
}

const which = process.argv[2] ?? "all";
const names = which === "all" ? Object.keys(DESIGNS) : [which];
for (const n of names) {
  await buildDesign(n, DESIGNS[n]);
}
