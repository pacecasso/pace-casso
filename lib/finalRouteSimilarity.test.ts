import assert from "node:assert";
import {
  scoreFinalRouteSimilarity,
  type FinalRoutePoint,
} from "./finalRouteSimilarity";

function taperedSwoosh(samplesPerSide = 36): FinalRoutePoint[] {
  const upper: FinalRoutePoint[] = [];
  const lower: FinalRoutePoint[] = [];
  for (let index = 0; index <= samplesPerSide; index++) {
    const t = index / samplesPerSide;
    upper.push({
      x: t,
      y: 0.5 - 0.25 * t - 0.08 * Math.sin(Math.PI * t),
    });
    lower.push({
      x: t,
      y: 0.62 - 0.37 * t + 0.1 * Math.sin(Math.PI * t),
    });
  }
  return [...upper, ...lower.reverse(), upper[0]!];
}

function gridQuantize(points: readonly FinalRoutePoint[], step = 0.035): FinalRoutePoint[] {
  const output: FinalRoutePoint[] = [];
  const push = (point: FinalRoutePoint) => {
    const previous = output[output.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) output.push(point);
  };
  for (let index = 0; index < points.length; index++) {
    const source = points[index]!;
    const previousSource = points[index - 1] ?? source;
    const subdivisions = Math.max(
      1,
      Math.ceil(Math.hypot(source.x - previousSource.x, source.y - previousSource.y) / (step * 0.5)),
    );
    for (let part = index === 0 ? subdivisions : 1; part <= subdivisions; part++) {
      const fraction = part / subdivisions;
      const dense = {
        x: previousSource.x + (source.x - previousSource.x) * fraction,
        y: previousSource.y + (source.y - previousSource.y) * fraction,
      };
      const target = {
        x: Math.round(dense.x / step) * step,
        y: Math.round(dense.y / step) * step,
      };
      const previous = output[output.length - 1];
      if (previous && previous.x !== target.x && previous.y !== target.y) {
        push({ x: target.x, y: previous.y });
      }
      push(target);
    }
  }
  return output;
}

function heart(samples = 96): FinalRoutePoint[] {
  const output: FinalRoutePoint[] = [];
  for (let index = 0; index <= samples; index++) {
    const angle = (index / samples) * Math.PI * 2;
    output.push({
      x: 16 * Math.sin(angle) ** 3,
      y:
        13 * Math.cos(angle) -
        5 * Math.cos(2 * angle) -
        2 * Math.cos(3 * angle) -
        Math.cos(4 * angle),
    });
  }
  return output;
}

function star(): FinalRoutePoint[] {
  const output: FinalRoutePoint[] = [];
  for (let index = 0; index < 10; index++) {
    const radius = index % 2 === 0 ? 1 : 0.42;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    output.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  output.push(output[0]!);
  return output;
}

const intended = taperedSwoosh();
const quantized = gridQuantize(intended);
const trueScore = scoreFinalRouteSimilarity(intended, quantized);

assert.ok(trueScore.score >= 82, `grid swoosh should score >=82, got ${trueScore.score}`);
assert.ok(
  trueScore.diagnostics.lineCoverage >= 80,
  `grid swoosh line coverage should stay high, got ${trueScore.diagnostics.lineCoverage}`,
);

const rectangle: FinalRoutePoint[] = [
  { x: 0, y: 0.25 },
  { x: 1, y: 0.25 },
  { x: 1, y: 0.65 },
  { x: 0, y: 0.65 },
  { x: 0, y: 0.25 },
];
const bowtie: FinalRoutePoint[] = [
  { x: 0, y: 0.25 },
  { x: 1, y: 0.65 },
  { x: 1, y: 0.25 },
  { x: 0, y: 0.65 },
  { x: 0, y: 0.25 },
];
const doubleTriangle: FinalRoutePoint[] = [
  { x: 0, y: 0.45 },
  { x: 0.45, y: 0.2 },
  { x: 0.45, y: 0.7 },
  { x: 0, y: 0.45 },
  { x: 1, y: 0.45 },
  { x: 0.55, y: 0.2 },
  { x: 0.55, y: 0.7 },
  { x: 1, y: 0.45 },
  { x: 0, y: 0.45 },
];
const collapsedLine: FinalRoutePoint[] = [
  { x: 0, y: 0.45 },
  { x: 1, y: 0.45 },
];
const landmarks = intended.filter((_, index) => index % 9 === 0).slice(0, 8);
const scrambledOrder: FinalRoutePoint[] = [
  landmarks[0]!,
  landmarks[4]!,
  landmarks[1]!,
  landmarks[6]!,
  landmarks[2]!,
  landmarks[7]!,
  landmarks[3]!,
  landmarks[5]!,
  landmarks[0]!,
];
const connectorSlash: FinalRoutePoint[] = [
  ...quantized.slice(0, -1),
  { x: 0.82, y: 0.66 },
  quantized[0]!,
];

const adversaries = {
  rectangle,
  bowtie,
  doubleTriangle,
  collapsedLine,
  scrambledOrder,
  connectorSlash,
};

for (const [name, candidate] of Object.entries(adversaries)) {
  const result = scoreFinalRouteSimilarity(intended, candidate);
  assert.ok(
    result.score <= trueScore.score - 20,
    `${name} should trail true grid swoosh by >=20; true=${trueScore.score}, ${name}=${result.score}`,
  );
}

assert.ok(
  scoreFinalRouteSimilarity(intended, [...intended].reverse()).score >= 99,
  "a complete traversal reversal must remain equivalent",
);

const shiftedClosedStart = [...intended.slice(23, -1), ...intended.slice(0, 23), intended[23]!];
assert.ok(
  scoreFinalRouteSimilarity(intended, shiftedClosedStart).score >= 99,
  "closed contours must be invariant to cyclic starting point",
);

const intendedHeart = heart();
const intendedStar = star();
const heartGrid = scoreFinalRouteSimilarity(intendedHeart, gridQuantize(intendedHeart, 1.1));
const starGrid = scoreFinalRouteSimilarity(intendedStar, gridQuantize(intendedStar, 0.07));
assert.ok(heartGrid.score >= 80, `grid heart should score >=80, got ${heartGrid.score}`);
assert.ok(starGrid.score >= 80, `grid star should score >=80, got ${starGrid.score}`);
assert.ok(
  scoreFinalRouteSimilarity(intendedHeart, intendedStar).score <= heartGrid.score - 25,
  "star must not be accepted as a heart",
);
assert.ok(
  scoreFinalRouteSimilarity(intendedStar, intendedHeart).score <= starGrid.score - 25,
  "heart must not be accepted as a star",
);

const artifactHeavyRoute: FinalRoutePoint[] = [
  ...quantized.slice(0, -1),
  { x: 1.05, y: 0.25 },
  { x: 1.15, y: 0.25 },
  { x: 1.15, y: 0.35 },
  { x: 1.05, y: 0.35 },
  { x: 1.05, y: 0.25 },
  { x: 0.5, y: 0.2 },
  { x: 0.8, y: 0.7 },
  { x: 0.25, y: 0.62 },
  { x: 0.35, y: 0.62 },
  { x: 0.35, y: 0.72 },
  { x: 0.25, y: 0.72 },
  { x: 0.25, y: 0.62 },
  quantized[0]!,
];
const artifactScore = scoreFinalRouteSimilarity(intended, artifactHeavyRoute);
assert.ok(
  artifactScore.score <= trueScore.score - 35,
  `artifact-heavy route should be rejected; true=${trueScore.score}, artifact=${artifactScore.score}`,
);
assert.ok(
  artifactScore.diagnostics.cleanliness <= 35,
  `artifact-heavy route should expose low cleanliness, got ${artifactScore.diagnostics.cleanliness}`,
);
console.log("finalRouteSimilarity tests ok", {
  swoosh: trueScore.score,
  adversaries: Object.fromEntries(
    Object.entries(adversaries).map(([name, candidate]) => [
      name,
      scoreFinalRouteSimilarity(intended, candidate).score,
    ]),
  ),
  heart: heartGrid.score,
  star: starGrid.score,
});
