import assert from "node:assert";
import {
  axisAlign,
  guessMatches,
  localSvg,
  parseJsonLoose,
  simulateStreets,
  strokeStats,
  toLatLngFrom,
  toLocalFrom,
  toMeters,
  type Pt,
} from "./artistLoopCore";

// --- frame round-trip -------------------------------------------------------
{
  const origin: [number, number] = [40.75, -73.99];
  const pts: Pt[] = [
    [0, 0],
    [1200, 0],
    [1200, 800],
    [-300, 2400],
  ];
  for (const p of pts) {
    const back = toLocalFrom(origin, toLatLngFrom(origin, p));
    assert.ok(
      Math.abs(back[0] - p[0]) < 0.5 && Math.abs(back[1] - p[1]) < 0.5,
      `frame round-trip drifted: ${p} -> ${back}`,
    );
  }
}

// --- axisAlign: collapses a wobbly long edge, leaves curves alone ----------
{
  // A 600 m "vertical" edge wobbling ±40 m in x — the artist meant a straight
  // avenue line. All x values must collapse to one shared mean.
  const wobbly: Pt[] = [
    [0, 0],
    [35, 200],
    [-40, 400],
    [20, 600],
  ];
  const aligned = axisAlign(wobbly);
  const xs = new Set(aligned.map((p) => p[0].toFixed(3)));
  assert.strictEqual(xs.size, 1, "wobbly long edge should collapse to one x");

  // A genuine diagonal (both axes moving beyond the band) must be untouched.
  const diagonal: Pt[] = [
    [0, 0],
    [300, 300],
    [600, 600],
  ];
  assert.deepStrictEqual(axisAlign(diagonal), diagonal);
}

// --- strokeStats: square has 4 strokes, straight line has 1 ----------------
{
  const square = [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.9 },
    { x: 0.1, y: 0.9 },
    { x: 0.1, y: 0.1 },
  ];
  const s = strokeStats(square);
  assert.strictEqual(s.strokes, 4);
  assert.ok(Math.abs(s.perimeter - 3.2) < 1e-9);

  const line = [
    { x: 0, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 0.5 },
  ];
  assert.strictEqual(strokeStats(line).strokes, 1);
}

// --- toMeters: scale caps and floors ---------------------------------------
{
  // A complex spiky contour (lion-mane style: many >35° turns) must be pushed
  // to the cap (≤2.45 km wide, ≤3.3 km tall, ≤32 km route) — never shrunk to
  // an illegible box.
  const complex: { x: number; y: number }[] = [];
  for (let i = 0; i <= 100; i++) {
    const a = (i / 100) * 2 * Math.PI;
    const r = i % 2 === 0 ? 0.45 : 0.33;
    complex.push({ x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) });
  }
  const big = toMeters(complex);
  assert.ok(big.widthM <= 2450 + 1e-6, `width cap: ${big.widthM}`);
  assert.ok(big.heightM <= 3300 + 1e-6, `height cap: ${big.heightM}`);
  assert.ok(big.routeKm <= 32 + 1e-6, `route cap: ${big.routeKm}`);
  assert.ok(
    Math.max(big.widthM, big.heightM) >= 900 - 1e-6,
    `never sub-kilometre: ${big.widthM}x${big.heightM}`,
  );

  // A simple closed square stays modest but still readable (route ≥ 4 km).
  const square = [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.9 },
    { x: 0.1, y: 0.9 },
    { x: 0.1, y: 0.1 },
  ];
  const modest = toMeters(square);
  assert.ok(modest.routeKm >= 4 - 1e-6, `route floor: ${modest.routeKm}`);
  assert.ok(modest.widthM <= 2450 + 1e-6);
}

// --- simulateStreets: quantizes to 274 m columns / 80 m rows ---------------
{
  const sim = simulateStreets([
    [0, 0],
    [548, 160],
  ]);
  for (const [x, y] of sim) {
    assert.strictEqual(x % 274, 0, `x not on avenue column: ${x}`);
    assert.strictEqual(y % 80, 0, `y not on street row: ${y}`);
  }
  const last = sim[sim.length - 1]!;
  assert.deepStrictEqual(last, [548, 160]);
  // consecutive duplicates removed
  for (let i = 1; i < sim.length; i++) {
    assert.notDeepStrictEqual(sim[i], sim[i - 1]);
  }
}

// --- guessMatches: token match, generic-word filter, plural folding --------
{
  const acceptable = ["gas pump", "fuel pump", "person at pump"];
  assert.ok(guessMatches("a gas pump", acceptable));
  assert.ok(guessMatches("fuel pumps", acceptable), "plural should fold");
  assert.ok(!guessMatches("nothing recognizable", acceptable));
  assert.ok(!guessMatches("a dog", acceptable));
  // "head" alone is generic — must NOT count as recognizing "head with headphones"
  assert.ok(!guessMatches("dog head", ["head with headphones"]));
  assert.ok(guessMatches("headphones", ["head with headphones"]));
}

// --- parseJsonLoose: fences and truncation repair --------------------------
{
  const fenced = '```json\n{"a": 1}\n```';
  assert.deepStrictEqual(parseJsonLoose(fenced), { a: 1 });

  // truncated mid-array: cut back to last complete point and close brackets
  const truncated = '{"label":"x","points":[{"x":0.1,"y":0.2},{"x":0.3,"y":0.4},{"x":0.5';
  const repaired = parseJsonLoose(truncated) as {
    label: string;
    points: { x: number; y: number }[];
  };
  assert.strictEqual(repaired.label, "x");
  assert.strictEqual(repaired.points.length, 2);
  assert.deepStrictEqual(repaired.points[1], { x: 0.3, y: 0.4 });
}

// --- localSvg: contains both paths and sane dimensions ---------------------
{
  const svg = localSvg([
    { pts: [[0, 0], [1000, 0]], color: "#111", width: 7 },
    { pts: [[0, 500], [1000, 500]], color: "#f00", width: 4 },
  ]);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes('stroke="#111"'));
  assert.ok(svg.includes('stroke="#f00"'));
  assert.ok(!svg.includes("NaN"));
}

console.log("artistLoopCore tests passed");
