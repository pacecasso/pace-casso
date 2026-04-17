import assert from "node:assert";
import { simplifyAnchorPathForSnap } from "./simplifyAnchorPathForSnap";
import {
  describeSnapRoutingPlan,
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
}

console.log("simplifyAnchorPathForSnap + describeSnapRoutingPlan tests ok");
