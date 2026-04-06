import { MAPBOX_PUBLIC_TOKEN } from "../lib/mapboxToken";

/**
 * Fetch Mapbox walking step instructions for export (GPX waypoints, cue sheet).
 */

/** Mapbox Directions allows up to 25 coordinates per request. */
const MAPBOX_MAX_COORDS = 25;

/** Reverse geocodes per route (dense cities need many micro-step fixes). */
const MAX_REVERSE_GEOCODE_ENRICHMENTS = 220;

/** Parallel geocode batch size. */
const GEOCODE_CONCURRENCY = 6;

/** Copy a named street from a nearby cue if still vague (meters). */
const NEIGHBOR_STREET_RADIUS_M = 240;

/**
 * Along one named street, merge only this span at a time so long corridors
 * produce several steps instead of one giant "continue".
 */
const MAX_SAME_STREET_CHUNK_M = 230;

/**
 * Only when both cues are walk/continue-style on the same street: keep two lines
 * if they are this far apart. Mixed walk + turn pairs merge to one line below this.
 */
const MIN_PAIR_SEPARATION_ALONG_ONLY_M = 220;

/**
 * If the last waypoint is within this distance of the first, append the start so
 * Mapbox includes a closing leg (loop routes otherwise end at the last handle).
 */
const LOOP_CLOSE_THRESHOLD_M = 95;

export type WalkingCue = {
  lat: number;
  lng: number;
  instruction: string;
  street: string | null;
};

function haversineMeters(
  a: [number, number],
  b: [number, number],
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Duplicate the first waypoint at the end when the polyline almost closes but
 * the last handle is not exactly on the start (typical for circle / loop routes).
 */
export function closeWaypointsIfNearlyLoop(
  waypoints: [number, number][],
  thresholdM: number = LOOP_CLOSE_THRESHOLD_M,
): [number, number][] {
  if (waypoints.length < 2) return waypoints;
  const first = waypoints[0];
  const last = waypoints[waypoints.length - 1];
  const gap = haversineMeters(
    [first[0], first[1]],
    [last[0], last[1]],
  );
  if (gap > thresholdM) return waypoints;
  /** Already ends on the start — avoid a zero-length duplicate tail. */
  if (gap < 4) return waypoints;
  return [...waypoints, [first[0], first[1]] as [number, number]];
}

/** OSM / Mapbox generic path labels — not useful as a "street name". */
function isGenericPathLabel(s: string | null | undefined): boolean {
  if (!s || !s.trim()) return true;
  const t = s.trim().toLowerCase();
  return (
    /^(walkway|footway|footpath|path|pedestrian|sidewalk|crosswalk|crossing|steps|stairs|track|cycleway|bridleway|corridor|platform)$/i.test(
      t,
    ) ||
    /^unnamed$/i.test(t) ||
    t === "walking path"
  );
}

/** Mapbox instruction text that lacks a real road name. */
function isVagueInstruction(s: string): boolean {
  const t = s.toLowerCase();
  if (isGenericPathLabel(s)) return true;
  return (
    /\b(the )?walkway\b/.test(t) ||
    /\b(the )?footway\b/.test(t) ||
    /\b(the )?path\b/.test(t) ||
    /\b(the )?crosswalk\b/.test(t) ||
    /\bpedestrian way\b/.test(t) ||
    /\bsidewalk\b/.test(t) ||
    /\bon the crosswalk\b/.test(t) ||
    /\bonto the crosswalk\b/.test(t)
  );
}

/** Bare turn with no street / destination. */
function isBareTurnOrFork(s: string): boolean {
  const t = s.trim();
  return (
    /^(turn\s+(?:sharp\s+)?(?:left|right))\.?$/i.test(t) ||
    /^(bear\s+(?:left|right))\.?$/i.test(t) ||
    /^(keep\s+(?:left|right))(\s+at\s+the\s+fork)?\.?$/i.test(t) ||
    /^continue\.?$/i.test(t)
  );
}

/** Mapbox sometimes emits only a cardinal with no street ("Walk northeast."). */
function isCardinalOnlyWalkInst(inst: string): boolean {
  return /^walk\s+(?:north|south|east|west|northeast|northwest|southeast|southwest)\.?$/i.test(
    inst.trim(),
  );
}

function modifierPhrase(mod?: string): string {
  if (!mod) return "";
  const map: Record<string, string> = {
    uturn: "Make a U-turn",
    "sharp right": "Turn sharp right",
    right: "Turn right",
    "slight right": "Bear right",
    straight: "Go straight",
    "slight left": "Bear left",
    left: "Turn left",
    "sharp left": "Turn sharp left",
  };
  return map[mod] ?? "";
}

type MapboxStepParsed = {
  maneuver?: {
    location?: [number, number];
    instruction?: string;
    type?: string;
    modifier?: string;
  };
  name?: string;
  ref?: string;
};

function pickReadableWayName(step: MapboxStepParsed): string | null {
  const name = typeof step.name === "string" ? step.name.trim() : "";
  const ref = typeof step.ref === "string" ? step.ref.trim() : "";
  const goodName = name && !isGenericPathLabel(name) ? name : "";
  const goodRef = ref && !isGenericPathLabel(ref) ? ref : "";
  if (goodRef && goodName) return `${goodName} (${goodRef})`;
  if (goodName) return goodName;
  if (goodRef) return goodRef;
  return null;
}

function buildInstructionFromStep(
  step: MapboxStepParsed,
  m: NonNullable<MapboxStepParsed["maneuver"]>,
): string {
  const mapboxInst =
    typeof m.instruction === "string" ? m.instruction.trim() : "";
  const way = pickReadableWayName(step);
  const type = m.type ?? "";
  const mod = m.modifier;

  if (
    mapboxInst &&
    !isVagueInstruction(mapboxInst) &&
    (way == null || mapboxInst.toLowerCase().includes(way.toLowerCase()))
  ) {
    return mapboxInst;
  }

  let core = "";
  switch (type) {
    case "depart":
      core = way
        ? `Head along ${way}`
        : mapboxInst || "Start walking";
      break;
    case "turn": {
      const mp = modifierPhrase(mod);
      core = mp || mapboxInst || "Turn";
      if (way) core = `${core} onto ${way}`;
      else if (mapboxInst && isVagueInstruction(mapboxInst)) core = mp || "Turn";
      break;
    }
    case "continue":
      core = way ? `Continue on ${way}` : mapboxInst || "Continue";
      break;
    case "new name":
      core = way ? `Continue on ${way}` : mapboxInst || "Continue";
      break;
    case "merge":
      core = way ? `Merge onto ${way}` : mapboxInst || "Merge";
      break;
    case "fork": {
      const mp = modifierPhrase(mod);
      core = mp
        ? `${mp}${way ? ` toward ${way}` : ""}`
        : mapboxInst || (way ? `Bear toward ${way}` : "Fork");
      break;
    }
    case "end of road":
      core = modifierPhrase(mod)
        ? `${modifierPhrase(mod)}${way ? ` onto ${way}` : ""}`
        : mapboxInst || "At end of road";
      break;
    case "roundabout":
    case "rotary":
      core = way ? `Enter roundabout toward ${way}` : mapboxInst || "Enter roundabout";
      break;
    case "exit roundabout":
    case "exit rotary":
      core = way ? `Exit onto ${way}` : mapboxInst || "Exit roundabout";
      break;
    case "arrive":
      core = mapboxInst || "Arrive at destination";
      break;
    default:
      core =
        mapboxInst ||
        (way ? `Continue on ${way}` : "Continue");
  }

  if (isVagueInstruction(core) && way) {
    core = core.replace(
      /\bthe walkway\b|\bwalkway\b|\bthe footway\b|\bfootway\b|\bthe path\b|\bpath\b|\bthe crosswalk\b|\bcrosswalk\b/gi,
      way,
    );
  }

  return core.trim() || (way ? `Continue on ${way}` : "Continue");
}

/** ~25 anchors along the dense path when block waypoints are missing. */
export function waypointsForDirectionsQuery(
  blockWaypoints: [number, number][] | undefined,
  coordinates: [number, number][],
): [number, number][] {
  let out: [number, number][];
  if (blockWaypoints && blockWaypoints.length >= 2) {
    out = blockWaypoints.map((p) => [p[0], p[1]] as [number, number]);
  } else if (coordinates.length < 2) {
    return [];
  } else if (coordinates.length <= MAPBOX_MAX_COORDS) {
    out = coordinates.map((p) => [p[0], p[1]] as [number, number]);
  } else {
    out = [];
    for (let k = 0; k < MAPBOX_MAX_COORDS; k++) {
      const t = k / (MAPBOX_MAX_COORDS - 1);
      const idx = Math.round(t * (coordinates.length - 1));
      out.push([coordinates[idx][0], coordinates[idx][1]] as [number, number]);
    }
  }
  return closeWaypointsIfNearlyLoop(out);
}

function mergeChunkCues(
  accumulator: WalkingCue[],
  chunk: WalkingCue[],
): WalkingCue[] {
  if (!chunk.length) return accumulator;
  if (!accumulator.length) return chunk.slice();
  const [first, ...rest] = chunk;
  const last = accumulator[accumulator.length - 1];
  if (
    haversineMeters([last.lat, last.lng], [first.lat, first.lng]) < 14
  ) {
    return [...accumulator, ...rest];
  }
  return [...accumulator, ...chunk];
}

function isArriveCue(c: WalkingCue): boolean {
  return /arrived at your destination|^arrive at destination|^arrive\.?$/i.test(
    c.instruction.trim(),
  );
}

async function fetchCuesForSlice(
  slice: [number, number][],
): Promise<WalkingCue[]> {
  if (slice.length < 2) return [];
  const coordStr = slice.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coordStr}?geometries=geojson&steps=true&overview=false&language=en&access_token=${MAPBOX_PUBLIC_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox ${res.status}`);
  const data = (await res.json()) as {
    routes?: {
      legs?: { steps?: MapboxStepParsed[] }[];
    }[];
  };
  const legs = data.routes?.[0]?.legs;
  if (!legs?.length) return [];

  const cues: WalkingCue[] = [];
  for (const leg of legs) {
    for (const step of leg.steps ?? []) {
      const m = step.maneuver;
      const loc = m?.location;
      if (!m || !loc || loc.length < 2) continue;
      /** Chunked requests make every leg end an "arrive" — not a real destination. */
      if (m.type === "arrive") continue;
      const [lng, lat] = loc;
      const instruction = buildInstructionFromStep(step, m);
      const street = pickReadableWayName(step);
      cues.push({ lat, lng, instruction, street });
    }
  }
  return cues;
}

type GeocodeFeature = {
  text?: string;
  place_type?: string[];
  context?: { id?: string; text?: string }[];
};

/**
 * Mapbox reverse geocode: `address` features often put the house number in `text`;
 * the street line lives on `context` entries with id `street.*`.
 */
function streetNameFromGeocodeFeature(f: GeocodeFeature): string | null {
  const types = f.place_type ?? [];
  if (types.includes("street")) {
    const text = typeof f.text === "string" ? f.text.trim() : "";
    if (text && !isGenericPathLabel(text)) return text;
  }
  if (types.includes("address")) {
    for (const ctx of f.context ?? []) {
      const id = typeof ctx.id === "string" ? ctx.id : "";
      if (!id.startsWith("street.")) continue;
      const t = typeof ctx.text === "string" ? ctx.text.trim() : "";
      if (t && !isGenericPathLabel(t)) return t;
    }
    const primary = typeof f.text === "string" ? f.text.trim() : "";
    if (
      primary &&
      !isGenericPathLabel(primary) &&
      !/^\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?$/i.test(primary)
    ) {
      return primary;
    }
  }
  return null;
}

async function reverseGeocodeStreetName(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    const url = new URL(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`,
    );
    url.searchParams.set("types", "address,street");
    url.searchParams.set("language", "en");
    url.searchParams.set("limit", "10");
    url.searchParams.set("access_token", MAPBOX_PUBLIC_TOKEN);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = (await res.json()) as { features?: GeocodeFeature[] };
    for (const f of data.features ?? []) {
      const st = streetNameFromGeocodeFeature(f);
      if (st) return st;
    }
    return null;
  } catch {
    return null;
  }
}

function instructionAlreadyNamesStreet(inst: string, st: string): boolean {
  const il = inst.toLowerCase();
  const sl = st.trim().toLowerCase();
  if (!sl) return false;
  if (il.includes(sl)) return true;
  const main = inst.replace(/\s*—\s*.+$/s, "").trim().toLowerCase();
  return main.includes(sl);
}

/** For list / export: skip redundant " — Street" when the line already names it. */
export function shouldAppendStreetLabel(
  instruction: string,
  street: string | null | undefined,
): boolean {
  if (!street?.trim()) return false;
  if (isGenericPathLabel(street)) return false;
  return !instructionAlreadyNamesStreet(instruction, street.trim());
}

function stripRedundantEmDashSuffix(instruction: string): string {
  const m = instruction.match(/^(.+?)\s*—\s*(.+)$/);
  if (!m) return instruction;
  const main = m[1].trim();
  const suff = m[2].trim().replace(/\.+$/, "");
  const mainL = main.toLowerCase().replace(/\.+$/, "");
  const suffL = suff.toLowerCase();
  if (mainL.includes(suffL)) return main;
  const suffWords = suffL.split(/\s+/).filter((w) => w.length > 2);
  if (suffWords.length > 0 && suffWords.every((w) => mainL.includes(w)))
    return main;
  return instruction;
}

function normalizeStreetToken(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/\s*—\s*.+$/, "")
    .trim();
}

/** Named road from cue metadata or parsed from instruction (for merging micro-steps). */
function effectiveStreetKey(c: WalkingCue): string | null {
  if (c.street && !isGenericPathLabel(c.street)) {
    return normalizeStreetToken(c.street);
  }
  const inst = c.instruction.trim();
  const turnOnto = inst.match(
    /^turn\s+(?:sharp\s+)?(?:left|right)\s+onto\s+(.+?)(?:\.|\s*—|\s*$)/i,
  );
  if (turnOnto) {
    const raw = turnOnto[1].trim();
    if (!isGenericPathLabel(raw)) return normalizeStreetToken(raw);
  }
  const bearOnto = inst.match(
    /^bear\s+(?:left|right)\s+onto\s+(.+?)(?:\.|\s*—|\s*$)/i,
  );
  if (bearOnto) {
    const raw = bearOnto[1].trim();
    if (!isGenericPathLabel(raw)) return normalizeStreetToken(raw);
  }
  const cont = inst.match(
    /^continue\s+(?:on\s+)?(.+?)(?:\.|\s*—|\s*$)/i,
  );
  if (cont) {
    const raw = cont[1].trim();
    if (!isGenericPathLabel(raw)) return normalizeStreetToken(raw);
  }
  const walk = inst.match(
    /^walk\s+(?:north|south|east|west|northeast|northwest|southeast|southwest)(?:\s+on\s+)?(.+?)(?:\.|\s*—|\s*$)/i,
  );
  if (walk) {
    const raw = walk[1].trim();
    if (!/^the\s+(walkway|footway|path|crosswalk)\b/i.test(raw) &&
        !isGenericPathLabel(raw)) {
      return normalizeStreetToken(raw);
    }
  }
  return null;
}

function normalizeInstructionLoose(inst: string): string {
  return inst
    .replace(/\s*—\s*.+$/s, "")
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isAlongStreetLine(inst: string): boolean {
  const t = inst.trim();
  if (/^turn\s+/i.test(t)) return false;
  if (/^bear\s+/i.test(t)) return false;
  if (/^keep\s+/i.test(t)) return false;
  return (
    /^walk\s+/i.test(t) ||
    /^continue\b/i.test(t) ||
    /^go\s+straight/i.test(t) ||
    /^merge\s+/i.test(t) ||
    /^head\s+along\b/i.test(t)
  );
}

function isBareTurnOnly(inst: string): boolean {
  return /^turn\s+(?:sharp\s+)?(?:left|right)\.?$/i.test(inst.trim());
}

function isBareBearOnly(inst: string): boolean {
  return /^bear\s+(?:left|right)\.?$/i.test(inst.trim());
}

function bareTurnKey(inst: string): string {
  return inst.trim().toLowerCase().replace(/\.+$/, "");
}

function isDuplicateTurnOnto(inst: string, key: string): boolean {
  const m = inst.match(
    /^turn\s+(?:sharp\s+)?(?:left|right)\s+onto\s+(.+?)(?:\.|\s*—|\s*$)/i,
  );
  if (!m) return false;
  return normalizeStreetToken(m[1]) === key;
}

function parseTurnOrBearOntoKey(inst: string): string | null {
  const main = inst.replace(/\s*—\s*.+$/s, "").trim();
  const m = main.match(
    /^(turn\s+(?:sharp\s+)?(?:left|right)|bear\s+(?:left|right))\s+onto\s+(.+?)\.?$/i,
  );
  if (!m) return null;
  const raw = m[2].trim();
  if (isGenericPathLabel(raw)) return null;
  return normalizeStreetToken(raw);
}

/**
 * Drop spurious "onto X" steps: already on X, or another turn onto the same X
 * within a short distance (Mapbox emits left/right/left on one corridor).
 */
function pruneSpuriousOntoSameStreet(cues: WalkingCue[]): WalkingCue[] {
  const MAX_D = 340;
  const out: WalkingCue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    const onto = parseTurnOrBearOntoKey(c.instruction);
    if (prev && onto) {
      const d = haversineMeters([prev.lat, prev.lng], [c.lat, c.lng]);
      if (d <= MAX_D) {
        const prevOnto = parseTurnOrBearOntoKey(prev.instruction);
        if (prevOnto !== null && prevOnto === onto) continue;
        const pk = effectiveStreetKey(prev);
        if (pk === onto) continue;
        if (instructionAlreadyNamesStreet(prev.instruction, onto)) continue;
      }
    }
    out.push(c);
  }
  return out;
}

/** Repeat prune + dedupe until stable — each drop can expose a new redundant pair. */
function polishOntoRepeats(cues: WalkingCue[]): WalkingCue[] {
  let cur = cues;
  for (let i = 0; i < 6; i++) {
    const pruned = pruneSpuriousOntoSameStreet(cur);
    const next = dedupeConsecutiveDuplicateInstructions(pruned);
    if (next.length === cur.length) break;
    cur = next;
  }
  return cur;
}

/** Remove back-to-back identical lines (e.g. three "Turn left onto 5th Avenue"). */
function dedupeConsecutiveDuplicateInstructions(cues: WalkingCue[]): WalkingCue[] {
  const MAX_D = 280;
  const out: WalkingCue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (
      prev &&
      haversineMeters([prev.lat, prev.lng], [c.lat, c.lng]) < MAX_D &&
      normalizeInstructionLoose(prev.instruction) ===
        normalizeInstructionLoose(c.instruction)
    ) {
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Bare left/right between two walkway segments is usually path jitter. */
function collapseBareTurnBetweenWalkways(cues: WalkingCue[]): WalkingCue[] {
  const MAX_EDGE = 100;
  const out: WalkingCue[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const prev = out[out.length - 1];
    const next = cues[i + 1];
    if (
      (isBareTurnOnly(c.instruction) || isBareBearOnly(c.instruction)) &&
      prev &&
      next &&
      stillGenericPathInstruction(prev.instruction) &&
      stillGenericPathInstruction(next.instruction) &&
      haversineMeters([prev.lat, prev.lng], [c.lat, c.lng]) < MAX_EDGE &&
      haversineMeters([c.lat, c.lng], [next.lat, next.lng]) < MAX_EDGE
    ) {
      continue;
    }
    out.push(c);
  }
  return out;
}

/** Still using OSM generic path wording after enrichment (common in dense cities). */
function stillGenericPathInstruction(inst: string): boolean {
  const t = inst.trim().toLowerCase();
  return /\b(walkway|footway|footpath)\b/.test(t);
}

/**
 * Collapse Mapbox micro-steps: same instruction, same-street "walk/continue" runs,
 * repeated turn-onto same road, stacked bare turns, and generic walkway chains.
 */
function collapseRedundantCues(cues: WalkingCue[]): WalkingCue[] {
  const MAX_SAME_TEXT_M = 240;
  const MAX_SAME_STREET_SOFT_M = 160;
  const MAX_DUP_TURN_ONTO_M = 200;
  const MAX_BARE_TURN_REPEAT_M = 90;
  const MAX_PREFIX_DUP_M = 50;
  const MAX_GENERIC_WALKWAY_CHAIN_M = 260;

  const out: WalkingCue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(c);
      continue;
    }
    const d = haversineMeters([prev.lat, prev.lng], [c.lat, c.lng]);

    const nPrev = normalizeInstructionLoose(prev.instruction);
    const nCur = normalizeInstructionLoose(c.instruction);
    if (nPrev === nCur && d < MAX_SAME_TEXT_M) continue;

    if (
      d < MAX_PREFIX_DUP_M &&
      nPrev.length > 14 &&
      nCur.length > 14 &&
      (nPrev.startsWith(nCur) || nCur.startsWith(nPrev))
    ) {
      continue;
    }

    if (
      isBareTurnOnly(prev.instruction) &&
      isBareTurnOnly(c.instruction) &&
      bareTurnKey(prev.instruction) === bareTurnKey(c.instruction) &&
      d < MAX_BARE_TURN_REPEAT_M
    ) {
      continue;
    }

    const kPrev = effectiveStreetKey(prev);
    const kCur = effectiveStreetKey(c);
    if (
      kPrev &&
      kCur &&
      kPrev === kCur &&
      d < MAX_SAME_STREET_SOFT_M &&
      isAlongStreetLine(prev.instruction) &&
      isAlongStreetLine(c.instruction)
    ) {
      continue;
    }

    if (
      kPrev &&
      kCur &&
      kPrev === kCur &&
      d < MAX_DUP_TURN_ONTO_M &&
      isDuplicateTurnOnto(prev.instruction, kPrev) &&
      isDuplicateTurnOnto(c.instruction, kCur)
    ) {
      continue;
    }

    if (
      stillGenericPathInstruction(prev.instruction) &&
      stillGenericPathInstruction(c.instruction) &&
      d < MAX_GENERIC_WALKWAY_CHAIN_M
    ) {
      continue;
    }

    out.push(c);
  }
  return out;
}

function applyStreetToCue(c: WalkingCue, street: string): WalkingCue {
  const st = street.trim();
  let instruction = c.instruction;

  if (isVagueInstruction(instruction)) {
    instruction = instruction.replace(
      /\bthe walkway\b|\bon the walkway\b|\bwalkway\b|\bthe footway\b|\bon the footway\b|\bfootway\b|\bthe path\b|\bon the path\b|\bpath\b|\bthe crosswalk\b|\bon the crosswalk\b|\bcrosswalk\b|\bpedestrian way\b|\bsidewalk\b/gi,
      st,
    );
  }

  if (isCardinalOnlyWalkInst(instruction)) {
    const m = instruction.trim().match(/^walk\s+(\w+)/i);
    const card = m ? m[1].toLowerCase() : "forward";
    const inst2 = `Walk ${card} on ${st}`;
    return { ...c, instruction: stripRedundantEmDashSuffix(inst2), street: st };
  }

  if (
    !instructionAlreadyNamesStreet(instruction, st) &&
    !/^arrive\b/i.test(instruction)
  ) {
    const turn = instruction.match(
      /^(turn\s+(?:sharp\s+)?(?:left|right)|bear\s+(?:left|right)|head\s+\w+)/i,
    );
    if (turn) {
      instruction = `${turn[0]} onto ${st}`;
    } else if (isBareTurnOrFork(instruction)) {
      instruction = `${instruction.replace(/\.$/, "")} onto ${st}`;
    } else {
      instruction = `${instruction} — ${st}`;
    }
  }

  instruction = stripRedundantEmDashSuffix(instruction.trim());
  return { ...c, instruction, street: st };
}

function cueNeedsStreetEnrichment(c: WalkingCue): boolean {
  if (isGenericPathLabel(c.street)) return true;
  if (isVagueInstruction(c.instruction)) return true;
  if (isBareTurnOrFork(c.instruction)) return true;
  if (isCardinalOnlyWalkInst(c.instruction)) return true;
  return false;
}

function enrichmentSortKey(c: WalkingCue): number {
  const inst = c.instruction.toLowerCase();
  if (/\bwalkway\b|\bfootway\b|\bfootpath\b/.test(inst)) return 0;
  if (isCardinalOnlyWalkInst(c.instruction)) return 1;
  if (isVagueInstruction(c.instruction)) return 2;
  if (isBareTurnOrFork(c.instruction)) return 3;
  return 4;
}

async function enrichCuesWithStreets(cues: WalkingCue[]): Promise<WalkingCue[]> {
  const needIdx = cues
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => cueNeedsStreetEnrichment(c))
    .sort((a, b) => enrichmentSortKey(a.c) - enrichmentSortKey(b.c))
    .slice(0, MAX_REVERSE_GEOCODE_ENRICHMENTS);

  const streetByIndex = new Map<number, string>();

  for (let b = 0; b < needIdx.length; b += GEOCODE_CONCURRENCY) {
    const batch = needIdx.slice(b, b + GEOCODE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ c, i }) => {
        const st = await reverseGeocodeStreetName(c.lat, c.lng);
        return { i, st };
      }),
    );
    for (const { i, st } of results) {
      if (st) streetByIndex.set(i, st);
    }
  }

  return cues.map((c, i) => {
    const st = streetByIndex.get(i);
    if (!st) return c;
    return applyStreetToCue(c, st);
  });
}

/** Borrow nearest non-generic street from another cue (after geocode pass). */
function fillFromNeighborStreets(cues: WalkingCue[]): WalkingCue[] {
  const goodStreets = cues
    .map((c, i) => ({ c, i }))
    .filter(
      ({ c }) => c.street && !isGenericPathLabel(c.street),
    );

  return cues.map((c, i) => {
    if (
      !isVagueInstruction(c.instruction) &&
      !isBareTurnOrFork(c.instruction) &&
      !isCardinalOnlyWalkInst(c.instruction)
    )
      return c;
    if (c.street && !isGenericPathLabel(c.street)) return c;

    let best: string | null = null;
    let bestD = Infinity;
    const here: [number, number] = [c.lat, c.lng];
    for (const { c: o } of goodStreets) {
      if (!o.street) continue;
      const d = haversineMeters(here, [o.lat, o.lng]);
      if (d < bestD && d <= NEIGHBOR_STREET_RADIUS_M) {
        bestD = d;
        best = o.street;
      }
    }
    if (!best) return c;
    return applyStreetToCue(c, best);
  });
}

function dedupeNearDuplicates(cues: WalkingCue[]): WalkingCue[] {
  const out: WalkingCue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.instruction === c.instruction &&
      haversineMeters([prev.lat, prev.lng], [c.lat, c.lng]) < 6
    ) {
      continue;
    }
    out.push(c);
  }
  return out;
}

function pickDisplayStreet(run: WalkingCue[], key: string): string {
  let best = "";
  for (const c of run) {
    const s = c.street?.trim();
    if (s && !isGenericPathLabel(s) && s.length > best.length) best = s;
  }
  if (best) return best;
  return key
    .split(/\s+/)
    .map((w) => {
      if (!w) return w;
      if (/^\d/.test(w)) return w;
      return w[0].toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

function instructionMainPart(inst: string): string {
  return inst.replace(/\s*—\s*.+$/s, "").trim();
}

function finalizeCue(c: WalkingCue): WalkingCue {
  return {
    ...c,
    instruction: stripRedundantEmDashSuffix(c.instruction),
  };
}

/** Cues with no resolved street (walkway, bare turn, bare cardinal) — often High Line / plaza geometry. */
function isUnnamedSegmentCue(c: WalkingCue): boolean {
  if (effectiveStreetKey(c) !== null) return false;
  const inst = c.instruction;
  if (stillGenericPathInstruction(inst)) return true;
  if (isBareTurnOnly(inst) || isBareBearOnly(inst)) return true;
  if (isCardinalOnlyWalkInst(inst)) return true;
  return false;
}

/**
 * Replace long runs of walkway + bare turns with one step (e.g. Hudson Yards / elevated paths).
 */
function mergeAnonymousCorridorRuns(cues: WalkingCue[]): WalkingCue[] {
  const MAX_RUN_SPAN_M = 1600;
  const MIN_MERGE_LEN = 2;

  const out: WalkingCue[] = [];
  let i = 0;
  while (i < cues.length) {
    if (!isUnnamedSegmentCue(cues[i])) {
      out.push(finalizeCue(cues[i]));
      i++;
      continue;
    }
    const anchor = cues[i];
    let j = i + 1;
    while (j < cues.length && isUnnamedSegmentCue(cues[j])) {
      const span = haversineMeters(
        [anchor.lat, anchor.lng],
        [cues[j].lat, cues[j].lng],
      );
      if (span > MAX_RUN_SPAN_M) break;
      j++;
    }
    const run = cues.slice(i, j);
    if (run.length < MIN_MERGE_LEN) {
      for (const x of run) out.push(finalizeCue(x));
    } else {
      const spanM = haversineMeters(
        [run[0].lat, run[0].lng],
        [run[run.length - 1].lat, run[run.length - 1].lng],
      );
      const roughly =
        spanM >= 120 ? ` (≈${Math.round(spanM)} m)` : "";
      out.push(
        finalizeCue({
          lat: run[0].lat,
          lng: run[0].lng,
          instruction: `Follow the pedestrian path${roughly}`,
          street: null,
        }),
      );
    }
    i = j;
  }
  return out;
}

/** Opposite "Walk …" micro-steps on the same block → one Continue on … */
function mergeTightSameStreetWalkPairs(cues: WalkingCue[]): WalkingCue[] {
  const MAX_D = 260;
  let cur = cues;
  for (let iter = 0; iter < 8; iter++) {
    const out: WalkingCue[] = [];
    let i = 0;
    let changed = false;
    while (i < cur.length) {
      const c = cur[i];
      const next = cur[i + 1];
      if (!next) {
        out.push(c);
        i++;
        continue;
      }
      const k0 = effectiveStreetKey(c);
      const k1 = effectiveStreetKey(next);
      const d = haversineMeters([c.lat, c.lng], [next.lat, next.lng]);
      if (
        k0 &&
        k0 === k1 &&
        d < MAX_D &&
        /^walk\s+/i.test(c.instruction.trim()) &&
        /^walk\s+/i.test(next.instruction.trim())
      ) {
        const street = pickDisplayStreet([c, next], k0);
        out.push(
          finalizeCue({
            lat: c.lat,
            lng: c.lng,
            instruction: `Continue on ${street}`,
            street,
          }),
        );
        i += 2;
        changed = true;
        continue;
      }
      out.push(c);
      i++;
    }
    if (!changed) return out;
    cur = out;
  }
  return cur;
}

/**
 * Pick one instruction for a same-street chunk: first real corner onto this street,
 * else head-along, else generic continue.
 */
function bestInstructionForSameStreetChunk(
  chunk: WalkingCue[],
  key: string,
  streetDisplay: string,
): string {
  for (const c of chunk) {
    const inst = instructionMainPart(c.instruction);
    const turnOrBear = inst.match(
      /^(turn\s+(?:sharp\s+)?(?:left|right)|bear\s+(?:left|right))\s+onto\s+(.+?)\.?$/i,
    );
    if (turnOrBear && normalizeStreetToken(turnOrBear[2]) === key) {
      return stripRedundantEmDashSuffix(inst);
    }
  }
  const firstInst = instructionMainPart(chunk[0].instruction);
  const head = firstInst.match(/^head\s+along\s+(.+?)\.?$/i);
  if (head && normalizeStreetToken(head[1]) === key) {
    return stripRedundantEmDashSuffix(firstInst);
  }
  return `Continue on ${streetDisplay}`;
}

/**
 * Collapse Mapbox micro-steps on the same named street, but chunk by distance so
 * long routes keep multiple cues; keep sparse pairs when they are far apart.
 */
function mergeConsecutiveSameStreetRuns(cues: WalkingCue[]): WalkingCue[] {
  if (cues.length <= 1) return cues;

  const out: WalkingCue[] = [];
  let i = 0;

  while (i < cues.length) {
    const key = effectiveStreetKey(cues[i]);

    if (!key) {
      out.push(finalizeCue(cues[i]));
      i++;
      continue;
    }

    let j = i + 1;
    while (j < cues.length && effectiveStreetKey(cues[j]) === key) {
      j++;
    }

    const run = cues.slice(i, j);
    if (run.length === 1) {
      out.push(finalizeCue(run[0]));
      i = j;
      continue;
    }

    let start = 0;
    while (start < run.length) {
      let end = start + 1;
      const anchor = run[start];
      while (end < run.length) {
        const d = haversineMeters(
          [anchor.lat, anchor.lng],
          [run[end].lat, run[end].lng],
        );
        if (d > MAX_SAME_STREET_CHUNK_M) break;
        end++;
      }
      const chunk = run.slice(start, end);
      const streetDisplay = pickDisplayStreet(chunk, key);

      if (chunk.length === 1) {
        out.push(finalizeCue(chunk[0]));
      } else if (chunk.length === 2) {
        const d = haversineMeters(
          [chunk[0].lat, chunk[0].lng],
          [chunk[1].lat, chunk[1].lng],
        );
        const along0 = isAlongStreetLine(chunk[0].instruction);
        const along1 = isAlongStreetLine(chunk[1].instruction);
        const bothAlong = along0 && along1;
        if (bothAlong && d > MIN_PAIR_SEPARATION_ALONG_ONLY_M) {
          out.push(finalizeCue(chunk[0]));
          out.push(finalizeCue(chunk[1]));
        } else {
          const instruction = bestInstructionForSameStreetChunk(
            chunk,
            key,
            streetDisplay,
          );
          out.push({
            lat: chunk[0].lat,
            lng: chunk[0].lng,
            instruction,
            street: streetDisplay,
          });
        }
      } else {
        const instruction = bestInstructionForSameStreetChunk(
          chunk,
          key,
          streetDisplay,
        );
        out.push({
          lat: chunk[0].lat,
          lng: chunk[0].lng,
          instruction,
          street: streetDisplay,
        });
      }
      start = end;
    }

    i = j;
  }

  return out;
}

/**
 * Returns ordered turn-by-turn cues for the given path (chunked for Mapbox limits).
 */
export async function fetchWalkingTurnCues(
  waypoints: [number, number][],
): Promise<WalkingCue[]> {
  if (waypoints.length < 2) return [];

  let all: WalkingCue[] = [];
  let startIdx = 0;

  while (startIdx < waypoints.length - 1) {
    const endIdx = Math.min(
      startIdx + MAPBOX_MAX_COORDS - 1,
      waypoints.length - 1,
    );
    const slice = waypoints.slice(startIdx, endIdx + 1);
    const chunk = await fetchCuesForSlice(slice);
    all = mergeChunkCues(all, chunk);
    if (endIdx >= waypoints.length - 1) break;
    startIdx = endIdx;
  }

  let merged = all.filter((c) => !isArriveCue(c));
  merged = await enrichCuesWithStreets(merged);
  merged = fillFromNeighborStreets(merged);
  merged = fillFromNeighborStreets(merged);
  merged = merged.map((c) => ({
    ...c,
    instruction: stripRedundantEmDashSuffix(c.instruction),
  }));
  merged = dedupeNearDuplicates(merged);
  merged = collapseRedundantCues(merged);
  merged = dedupeNearDuplicates(merged);
  merged = mergeConsecutiveSameStreetRuns(merged);
  merged = fillFromNeighborStreets(merged);
  merged = collapseBareTurnBetweenWalkways(merged);
  merged = collapseBareTurnBetweenWalkways(merged);
  merged = mergeTightSameStreetWalkPairs(merged);
  merged = mergeAnonymousCorridorRuns(merged);
  merged = mergeAnonymousCorridorRuns(merged);
  merged = polishOntoRepeats(merged);
  merged = mergeTightSameStreetWalkPairs(merged);
  merged = merged.map((c) => ({
    ...c,
    instruction: stripRedundantEmDashSuffix(c.instruction),
  }));
  merged = dedupeNearDuplicates(merged);

  return merged;
}
