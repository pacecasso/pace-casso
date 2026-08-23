import fs from "node:fs/promises";

const file = process.argv[2];
const maxJumpM = Number(process.argv[3] ?? 120);
if (!file) {
  console.error("usage: node scripts/verify-route-proof.mjs <route.gpx> [maxJumpM]");
  process.exit(2);
}

function parseTrackSegments(xml) {
  const segments = [];
  const segRe = /<trkseg>([\s\S]*?)<\/trkseg>/g;
  let segMatch;
  while ((segMatch = segRe.exec(xml))) {
    const pts = [];
    const ptRe = /<trkpt lat="([^"]+)" lon="([^"]+)"/g;
    let ptMatch;
    while ((ptMatch = ptRe.exec(segMatch[1]))) {
      pts.push([Number(ptMatch[1]), Number(ptMatch[2])]);
    }
    if (pts.length) segments.push(pts);
  }
  return segments;
}

function meters(a, b) {
  const latM = 111320;
  const lngM = latM * Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * latM, (b[1] - a[1]) * lngM);
}

function km(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += meters(points[i - 1], points[i]);
  return total / 1000;
}

const xml = await fs.readFile(file, "utf8");
const segments = parseTrackSegments(xml);
const flattened = segments.flat();
const jumps = [];
let previous = null;
for (let s = 0; s < segments.length; s++) {
  const segment = segments[s];
  if (previous) {
    const transferM = meters(previous, segment[0]);
    if (transferM > maxJumpM) {
      jumps.push({ kind: "transfer", segment: s + 1, meters: transferM });
    }
  }
  for (let i = 1; i < segment.length; i++) {
    const stepM = meters(segment[i - 1], segment[i]);
    if (stepM > maxJumpM) jumps.push({ kind: "step", segment: s + 1, index: i, meters: stepM });
  }
  previous = segment[segment.length - 1];
}

jumps.sort((a, b) => b.meters - a.meters);
const summary = {
  file,
  segments: segments.length,
  points: flattened.length,
  km: Number(km(flattened).toFixed(2)),
  maxJumpM,
  jumpsOverLimit: jumps.length,
  worstJumpM: jumps[0] ? Number(jumps[0].meters.toFixed(1)) : 0,
  verdict: jumps.length ? "FAIL" : "PASS",
};
console.log(JSON.stringify(summary, null, 2));
if (jumps.length) {
  console.log("worst jumps:");
  for (const j of jumps.slice(0, 10)) {
    console.log(`${j.kind} segment=${j.segment}${j.index ? ` index=${j.index}` : ""} ${j.meters.toFixed(1)}m`);
  }
  process.exit(1);
}