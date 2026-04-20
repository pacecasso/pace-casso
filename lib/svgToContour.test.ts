import assert from "node:assert";
import { downsampleContour } from "./svgToContour";

/**
 * `svgFileToContourAndPreview` itself needs a browser DOM (SVGGeometryElement
 * sampling lives there). The pure pieces — downsampling + normalization math —
 * are what we cover here. End-to-end sampling is exercised via the live app.
 */

{
  const ring = Array.from({ length: 500 }, (_, i) => ({
    x: Math.cos((i / 500) * Math.PI * 2),
    y: Math.sin((i / 500) * Math.PI * 2),
  }));
  const down = downsampleContour(ring, 120);
  assert.ok(
    down.length >= 120 && down.length <= 122,
    `expected ~120 points after downsample, got ${down.length}`,
  );
  // Still round-trips the shape — no coordinate drift
  for (const p of down) {
    const r = Math.hypot(p.x, p.y);
    assert.ok(
      Math.abs(r - 1) < 0.0001,
      `downsampled point should still be unit-circle, got r=${r}`,
    );
  }
}

{
  const short = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
  const r = downsampleContour(short, 50);
  assert.strictEqual(r, short, "no-op when already under cap");
}

{
  // Edge: maxN < 2 should not crash, returns input
  const ring = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
  ];
  const r = downsampleContour(ring, 1);
  assert.strictEqual(r, ring, "returns input when cap is degenerate");
}

console.log("svgToContour tests ok");
