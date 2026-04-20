import assert from "node:assert";
import {
  formatDistance,
  formatDuration,
  formatPace,
  formatRouteStats,
  parsePace,
  estimateSeconds,
  DEFAULT_RUNNER_PROFILE,
} from "./runnerProfile";

// formatDistance
assert.strictEqual(formatDistance(11.4, "km"), "11.4 km");
assert.strictEqual(formatDistance(11.4, "mi"), "7.1 mi"); // 11.4 / 1.609344 ≈ 7.08
assert.strictEqual(formatDistance(0, "km"), "— km");
assert.strictEqual(formatDistance(NaN, "mi"), "— mi");

// formatDuration
assert.strictEqual(formatDuration(0), "—");
assert.strictEqual(formatDuration(24 * 60), "24 min");
assert.strictEqual(formatDuration(60 * 60 + 24 * 60), "1h 24m");
assert.strictEqual(formatDuration(2 * 60 * 60 + 5 * 60), "2h 05m");

// formatPace
assert.strictEqual(formatPace(360, "km"), "6:00 /km");
// 6:00/km → 360s/km * 1.609344 ≈ 579s/mi → 9:39/mi
assert.strictEqual(formatPace(360, "mi"), "9:39 /mi");

// parsePace
assert.strictEqual(parsePace("6:00", "km"), 360);
assert.strictEqual(parsePace("06:30", "km"), 390);
// 10:00/mi → 600s/mi / 1.609344 ≈ 373s/km
const mi10 = parsePace("10:00", "mi")!;
assert.ok(mi10 >= 372 && mi10 <= 374, `10:00/mi ≈ 373s/km, got ${mi10}`);
assert.strictEqual(parsePace("not a pace", "km"), null);
assert.strictEqual(parsePace("6:99", "km"), null); // 99 > 59 seconds
// Extreme values clamp — 1:00/km (elite) clamps up to 2:00/km
const fast = parsePace("1:00", "km")!;
assert.ok(fast >= 120, `pace should clamp to floor, got ${fast}`);

// estimateSeconds
assert.strictEqual(estimateSeconds(10, 360), 3600); // 10km × 6:00/km = 1h
assert.strictEqual(estimateSeconds(0, 360), 0);
assert.strictEqual(estimateSeconds(NaN, 360), 0);

// formatRouteStats round-trip
assert.strictEqual(
  formatRouteStats(10, DEFAULT_RUNNER_PROFILE),
  "10.0 km · 1h 00m",
);
assert.strictEqual(
  formatRouteStats(11.4, { paceSecPerKm: 360, unit: "mi" }),
  "7.1 mi · 1h 08m",
);

console.log("runnerProfile tests ok");
