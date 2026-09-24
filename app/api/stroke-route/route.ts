import { rateLimitAllow } from "../../../lib/mapboxRateLimit";
import { shieldExpensiveRoute, trustedClientIp } from "../../../lib/apiShield";
import { getStreetGraph, type LatLng } from "../../../lib/streetGraphTrace";
import {
  HUG_TOL_M,
  orderStrokes,
  routePlacement,
  setHugTolerance,
  type PainterGraph,
  type Stroke,
  type UnitPt,
} from "../../../lib/strokePainter";
import { trimClosingWalk } from "../../../lib/geoDraft";
import { supportsRouteFinding, walkGraphIdFor } from "../../../lib/cityPresets";
import { applyStrokeEdits, dropTinyStrokes, type StrokeEdit } from "../../../lib/strokeEdit";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Re-route an edited drawing on real streets.
 *
 * This is the step behind the only two routes Ralph has approved: an automatic
 * draft plus three or four stroke edits, re-routed (scripts/finisher-edit.ts,
 * Sep 8 and Sep 12). One routePlacement call, so it answers in a second or two
 * rather than the draft search's three minutes. Zero model calls, zero Mapbox
 * calls - editing must be free and instant or nobody will iterate.
 */
export async function POST(req: Request) {
  const shield = shieldExpensiveRoute(req, "stroke-route", 600);
  if (!shield.ok) {
    return Response.json({ error: shield.message }, { status: shield.status });
  }
  if (!rateLimitAllow(`stroke-route:${trustedClientIp(req)}`, 120)) {
    return Response.json({ error: "Rate limit" }, { status: 429 });
  }

  let body: {
    strokes?: unknown;
    edits?: unknown;
    center?: unknown;
    scale?: unknown;
    rot?: unknown;
    cityId?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cityId = typeof body.cityId === "string" ? body.cityId : "manhattan";
  if (!supportsRouteFinding(cityId)) {
    return Response.json({ ok: false, reason: "unsupported-city" });
  }

  const center = cleanLatLng(body.center);
  const scale = typeof body.scale === "number" && Number.isFinite(body.scale) ? body.scale : 0;
  const rot = typeof body.rot === "number" && Number.isFinite(body.rot) ? body.rot : 0;
  // Brooklyn drafts are seated far larger than Manhattan ever was (the cat at
  // 4,000-9,000 against Manhattan's 1,300-1,700), so the old 6,000 ceiling
  // rejected the very drawings this step exists to edit.
  if (!center || scale < 100 || scale > 12000) {
    return Response.json({ ok: false, reason: "bad-placement" }, { status: 400 });
  }

  const base = cleanStrokes(body.strokes);
  if (!base.length) {
    return Response.json({ ok: false, reason: "no-strokes" }, { status: 400 });
  }
  const edits = cleanEdits(body.edits);

  const edited = dropTinyStrokes(applyStrokeEdits(base, edits), scale, 250);
  if (!edited.length) {
    // every stroke was dropped: say so plainly rather than returning an empty route
    return Response.json({ ok: false, reason: "nothing-left" });
  }

  // the SAME graph the draft was seated on: a Brooklyn drawing re-routed on
  // Manhattan's graph has no streets under it at all
  const g = (await getStreetGraph(walkGraphIdFor(cityId))) as unknown as PainterGraph;
  // the painter's hug tolerance is a module global; set it only around the call
  const prevHug = HUG_TOL_M;
  let routed: ReturnType<typeof routePlacement>;
  try {
    setHugTolerance(90);
    routed = routePlacement(g, orderStrokes(edited), center, scale, rot, false);
  } finally {
    setHugTolerance(prevHug);
  }

  if (!routed || routed.chain.length < 8) {
    return Response.json({ ok: false, reason: "unroutable" });
  }

  // The draft trims the walk back to the start when it does not close the
  // outline; without the same trim here the distance jumps by about a
  // kilometre the moment the user touches anything - even an edit and an undo
  // that land back on the original drawing.
  const finished = trimClosingWalk(routed);

  return Response.json({
    ok: true,
    chain: finished.chain,
    km: finished.km,
    inkKm: finished.inkKm,
    maxGapM: finished.maxGap,
    dropped: finished.dropped,
    strokes: edited,
    strokeCount: edited.length,
  });
}

function cleanLatLng(raw: unknown): LatLng | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [a, b] = raw as [unknown, unknown];
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  return [a, b];
}

function cleanPts(raw: unknown): UnitPt[] {
  if (!Array.isArray(raw)) return [];
  const out: UnitPt[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const [x, y] = p as [unknown, unknown];
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // unit space with a little slack for strokes drawn past the edge
    if (Math.abs(x) > 4 || Math.abs(y) > 4) continue;
    out.push([x, y]);
    if (out.length >= 4000) break;
  }
  return out;
}

function cleanStroke(raw: unknown): Stroke | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { kind?: unknown; closed?: unknown; group?: unknown; pts?: unknown };
  const pts = cleanPts(r.pts);
  if (pts.length < 2) return null;
  const kind: Stroke["kind"] =
    r.kind === "outline" || r.kind === "hatch" || r.kind === "thin" ? r.kind : "thin";
  const stroke: Stroke = { kind, closed: Boolean(r.closed), pts };
  if (typeof r.group === "number" && Number.isFinite(r.group)) stroke.group = r.group;
  return stroke;
}

function cleanStrokes(raw: unknown): Stroke[] {
  if (!Array.isArray(raw)) return [];
  const out: Stroke[] = [];
  for (const s of raw) {
    const k = cleanStroke(s);
    if (k) out.push(k);
    if (out.length >= 200) break;
  }
  return out;
}

function cleanEdits(raw: unknown): StrokeEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: StrokeEdit[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as { op?: unknown; index?: unknown; stroke?: unknown; at?: unknown; order?: unknown };
    const index = typeof r.index === "number" && Number.isInteger(r.index) ? r.index : -1;
    if (r.op === "drop") {
      out.push({ op: "drop", index });
    } else if (r.op === "add") {
      const s = cleanStroke(r.stroke);
      if (s) out.push({ op: "add", stroke: s });
    } else if (r.op === "replace") {
      const s = cleanStroke(r.stroke);
      if (s) out.push({ op: "replace", index, stroke: s });
    } else if (r.op === "cut") {
      const at = cleanPts(r.at);
      if (at.length >= 2) out.push({ op: "cut", index, at: [at[0]!, at[1]!] });
    } else if (r.op === "sequence" && Array.isArray(r.order)) {
      const order = r.order.filter((n): n is number => typeof n === "number" && Number.isInteger(n));
      out.push({ op: "sequence", order });
    }
    if (out.length >= 200) break;
  }
  return out;
}
