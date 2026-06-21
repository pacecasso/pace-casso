import assert from "node:assert";
import {
  analyzeOneLinePath,
  connectorSegmentPairs,
} from "./oneLinePathAnalysis";

{
  const denseWithConnector = [
    { x: 0, y: 0 },
    { x: 0.02, y: 0 },
    { x: 0.04, y: 0 },
    { x: 0.06, y: 0 },
    { x: 0.7, y: 0.6 },
    { x: 0.72, y: 0.6 },
    { x: 0.74, y: 0.6 },
  ];
  const analysis = analyzeOneLinePath(denseWithConnector);
  assert.equal(analysis.connectorCount, 1);
  assert.deepEqual(analysis.connectorSegmentIndices, [3]);
  assert(analysis.longestConnectorRatio > 20);
}

{
  const square = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: 0, y: 0 },
  ];
  const analysis = analyzeOneLinePath(square);
  assert.equal(analysis.connectorCount, 0);
  assert.equal(analysis.isClosed, true);
}

{
  const openLine = [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 1, y: 0 },
  ];
  const analysis = analyzeOneLinePath(openLine);
  assert.equal(analysis.connectorCount, 0);
  assert.equal(analysis.isClosed, false);
}

{
  const malformed = [
    { x: 0, y: 0 },
    { x: Number.POSITIVE_INFINITY, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ];
  const analysis = analyzeOneLinePath(malformed);
  assert.equal(analysis.connectorCount, 0);
  assert.equal(Number.isFinite(analysis.longestConnectorRatio), true);
  assert.equal(analysis.isClosed, false);
}

{
  const outOfRangeEndpoint = [
    { x: -0.1, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: -0.1, y: 0 },
  ];
  const analysis = analyzeOneLinePath(outOfRangeEndpoint);
  assert.equal(analysis.isClosed, false);
}

{
  const points = ["a", "b", "c", "d"];
  assert.deepEqual(connectorSegmentPairs(points, [1, 9]), [["b", "c"]]);
}

console.log("oneLinePathAnalysis tests ok");
