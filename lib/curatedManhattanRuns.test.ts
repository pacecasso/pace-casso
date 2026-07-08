import assert from "node:assert";
import {
  CURATED_MANHATTAN_RUNS,
  curatedRunToGpx,
  getCuratedRun,
} from "./curatedManhattanRuns";

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const la1 = (a[0] * Math.PI) / 180;
  const la2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ids unique, all fields present
{
  const ids = new Set(CURATED_MANHATTAN_RUNS.map((r) => r.id));
  assert.strictEqual(ids.size, CURATED_MANHATTAN_RUNS.length, "duplicate run ids");
  for (const run of CURATED_MANHATTAN_RUNS) {
    assert.ok(run.title.length > 0, `${run.id}: title`);
    assert.ok(run.icon.length > 0, `${run.id}: icon`);
    assert.ok(run.area.includes("·"), `${run.id}: area format`);
    assert.ok(run.blurb.length > 20, `${run.id}: blurb`);
    assert.ok(run.coords.length >= 10, `${run.id}: too few coords`);
  }
}

// every point inside Manhattan bounds; every hop runnable (no teleports)
for (const run of CURATED_MANHATTAN_RUNS) {
  let total = 0;
  for (let i = 0; i < run.coords.length; i++) {
    const [lat, lng] = run.coords[i]!;
    assert.ok(lat > 40.69 && lat < 40.88, `${run.id}: lat out of Manhattan (${lat})`);
    assert.ok(lng > -74.03 && lng < -73.9, `${run.id}: lng out of Manhattan (${lng})`);
    if (i > 0) {
      const hop = haversineMeters(run.coords[i - 1]!, run.coords[i]!);
      assert.ok(hop < 350, `${run.id}: hop ${Math.round(hop)} m at index ${i}`);
      total += hop;
    }
  }
  // stated distance within 5% of polyline length
  const km = total / 1000;
  assert.ok(
    Math.abs(km - run.distanceKm) / run.distanceKm < 0.05,
    `${run.id}: distanceKm ${run.distanceKm} vs computed ${km.toFixed(2)}`,
  );
}

// lookup + GPX rendering
{
  const heart = getCuratedRun("les-heart");
  assert.ok(heart, "les-heart missing");
  assert.strictEqual(getCuratedRun("nope"), undefined);
  const gpx = curatedRunToGpx(heart!);
  assert.ok(gpx.startsWith('<?xml version="1.0"'), "gpx header");
  assert.ok(gpx.includes("<trkpt"), "gpx points");
  const ptCount = (gpx.match(/<trkpt/g) ?? []).length;
  assert.strictEqual(ptCount, heart!.coords.length, "gpx point count");
}

console.log("curatedManhattanRuns tests passed");
