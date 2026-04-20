import assert from "node:assert";
import { simplifyAnchorPathForSnap } from "./simplifyAnchorPathForSnap";
import {
  describeSnapRoutingPlan,
  SNAP_WALKING_CHUNK_OVERLAP,
  SNAP_WALKING_CHUNK_SIZE,
} from "./snapWalkingRoute";

/** ≤56 vertices: unchanged for all source kinds (preserves silhouette corners for Mapbox). */
const denseOpenLine: [number, number][] = Array.from({ length: 45 }, (_, i) => [
  40.75 + i * 0.00004,
  -73.98,
]);

{
  const d = simplifyAnchorPathForSnap(denseOpenLine);
  const im = simplifyAnchorPathForSnap(denseOpenLine, { sourceKind: "image" });
  assert.strictEqual(d.length, denseOpenLine.length);
  assert.strictEqual(im.length, denseOpenLine.length);
}

{
  const planDefault = describeSnapRoutingPlan(denseOpenLine, {});
  const planImage = describeSnapRoutingPlan(denseOpenLine, { anchorSource: "image" });
  assert.strictEqual(planDefault.chunkWaypointCap, SNAP_WALKING_CHUNK_SIZE);
  assert.strictEqual(
    planImage.simplifiedVertexCount,
    planDefault.simplifiedVertexCount,
  );
  assert.strictEqual(
    planImage.mapboxChunkCount,
    planDefault.mapboxChunkCount,
  );
  assert.strictEqual(
    planDefault.chunkStride,
    SNAP_WALKING_CHUNK_SIZE - 1 - SNAP_WALKING_CHUNK_OVERLAP,
  );
  assert.strictEqual(planDefault.chunkOverlap, SNAP_WALKING_CHUNK_OVERLAP);
}

/**
 * Regression test for the "fish → blob" bug. A detailed closed-ring photo
 * silhouette (~400 anchors, ~1.6 km perimeter) must retain enough vertices for
 * Mapbox to render recognisable features (fins, tail). Default/freehand kept
 * collapsing the same input to ~12 anchors via a fixed 25 m DP tolerance;
 * `image` now uses an adaptive ~13 m tolerance so detail survives.
 */
function fishRing(): [number, number][] {
  // Parametric fish outline (ellipse + tail notch + fins + belly wiggle),
  // sampled densely in WGS84 so haversine distances are physically plausible.
  const centerLat = 40.755;
  const centerLng = -73.97;
  // Half-axes in metres: 300 m long × 120 m tall fish (perimeter ≈ 1.5–1.8 km
  // once we factor in fins and the tail notch).
  const semiMajorM = 300;
  const semiMinorM = 120;
  const metersPerDegLat = 111_320;
  const metersPerDegLng = metersPerDegLat * Math.cos((centerLat * Math.PI) / 180);

  const pts: [number, number][] = [];
  const N = 400;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    let rx = Math.cos(t) * semiMajorM;
    let ry = Math.sin(t) * semiMinorM;
    // Tail notch on the left (x negative, |x| near semiMajor)
    const tailBite = Math.max(0, -Math.cos(t) - 0.85) * 180;
    rx += tailBite;
    // Top dorsal fin around t ≈ π/2
    if (Math.sin(t) > 0.6) {
      ry += (Math.sin(t) - 0.6) * 220;
    }
    // Small belly wiggle for fine detail the simplifier shouldn't crush
    ry += Math.sin(t * 7) * 8;
    const dLat = ry / metersPerDegLat;
    const dLng = rx / metersPerDegLng;
    pts.push([centerLat + dLat, centerLng + dLng]);
  }
  // Close the ring
  pts.push(pts[0]!);
  return pts;
}

{
  const fish = fishRing();
  assert.ok(fish.length > 300, `fish ring should be dense, got ${fish.length}`);
  const def = simplifyAnchorPathForSnap(fish, { sourceKind: "default" });
  const img = simplifyAnchorPathForSnap(fish, { sourceKind: "image" });

  // Default is deliberately aggressive — will collapse a fish to a pentagon.
  // Image must keep meaningfully more vertices so silhouette detail survives.
  assert.ok(
    img.length >= def.length * 1.6,
    `image source should keep ≥1.6× default vertex count — got image=${img.length}, default=${def.length}`,
  );
  assert.ok(
    img.length >= 15,
    `image fish should retain ≥15 anchors for Mapbox; got ${img.length}`,
  );
  // And still cap below 110 so Mapbox chunking stays manageable
  assert.ok(
    img.length <= 110,
    `image source should cap at 100 points (plus closing vertex); got ${img.length}`,
  );
}

console.log("simplifyAnchorPathForSnap + describeSnapRoutingPlan tests ok");
