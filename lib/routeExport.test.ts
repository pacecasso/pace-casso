import assert from "node:assert/strict";
import {
  cuesToPlainText,
  routeToGeoJSONFeature,
  routeToGeoJSONFeatureCollection,
  routeToGpx,
  safeExportWalkingCues,
  safeDistanceMeters,
  safeRouteBlockWaypoints,
  safeRouteCoords,
  safeRouteDistanceMeters,
  type ExportWalkingCue,
} from "./routeExport";
import type { RouteLineString } from "./routeTypes";

const route: RouteLineString = {
  coordinates: [
    [40, -73],
    [Number.NaN, -72.999],
    [91, -72.997],
    [40.002, -181],
    [40.001, -72.998],
  ],
  distanceMeters: 250,
  blockWaypoints: [
    [40, -73],
    [Number.NaN, -72.999],
    [-91, -72.997],
    [40.002, 181],
    [40.001, -72.998],
  ],
};

const cues = [
  {
    lat: 40,
    lng: -73,
    instruction: " Turn <left> & continue ",
    street: " Main & 1st ",
  },
  {
    lat: Number.NaN,
    lng: -73,
    instruction: "Bad cue",
    street: "Nowhere",
  },
  {
    lat: 95,
    lng: -73,
    instruction: "Out of range cue",
    street: "Nowhere",
  },
  {
    lat: 40.001,
    lng: -72.998,
    instruction: "Finish strong",
    street: null,
  },
  {
    lat: 40.002,
    lng: -72.997,
    instruction: "",
    street: "Blank instruction",
  },
  {
    lat: 40.003,
    lng: -72.996,
    instruction: undefined,
    street: "Bad instruction",
  },
  {
    lat: 40.004,
    lng: -72.995,
    instruction: "Continue",
    street: "   ",
  },
] as unknown as ExportWalkingCue[];

assert.deepEqual(safeRouteCoords(route), [
  [40, -73],
  [40.001, -72.998],
]);
assert.deepEqual(safeRouteBlockWaypoints(route), [
  [40, -73],
  [40.001, -72.998],
]);
assert.deepEqual(safeExportWalkingCues(cues).map((c) => c.instruction), [
  "Turn <left> & continue",
  "Finish strong",
  "Continue",
]);
assert.deepEqual(safeExportWalkingCues(cues).map((c) => c.street), [
  "Main & 1st",
  null,
  null,
]);
assert.equal(safeDistanceMeters(250), 250);
assert.equal(safeDistanceMeters(-1), null);
assert.equal(safeDistanceMeters(Number.POSITIVE_INFINITY), null);
assert.equal(safeRouteDistanceMeters(route), 250);
assert.equal(
  safeRouteDistanceMeters({
    coordinates: [[Number.NaN, -73]],
    distanceMeters: 250,
  }),
  null,
  "positive distance metadata without usable geometry should not be trusted",
);

const feature = routeToGeoJSONFeature(route, {
  artworkConnectorCount: 2,
  artworkMatchScore: 87.6,
});
assert.equal(feature.properties.pathVertexCount, 2);
assert.equal(feature.properties.waypointCount, 2);
assert.equal(typeof feature.properties.cleanLineScore, "number");
assert.equal(feature.properties.artworkConnectorCount, 2);
assert.equal(feature.properties.artworkMatchScore, 88);
assert.equal(feature.properties.distanceMeters, 250);
assert.deepEqual(feature.geometry.coordinates, [
  [-73, 40],
  [-72.998, 40.001],
]);

const badDistanceFeature = routeToGeoJSONFeature({
  ...route,
  distanceMeters: -25,
});
assert(
  typeof badDistanceFeature.properties.distanceMeters === "number" &&
    badDistanceFeature.properties.distanceMeters > 0,
  "bad distance metadata should fall back to measured route geometry",
);

const zeroDistanceFeature = routeToGeoJSONFeature({
  ...route,
  distanceMeters: 0,
});
assert(
  typeof zeroDistanceFeature.properties.distanceMeters === "number" &&
    zeroDistanceFeature.properties.distanceMeters > 0,
  "zero distance metadata should fall back to measured route geometry",
);

const fc = routeToGeoJSONFeatureCollection(route, cues, {
  artworkConnectorCount: 2,
  artworkMatchScore: 87.6,
});
assert.equal(fc.features.length, 4, "invalid cue points should be dropped");
assert.equal(
  (fc.features[1] as { properties: { name: string } }).properties.name,
  "Cue 1",
);
assert.equal(
  (fc.features[2] as { properties: { name: string } }).properties.name,
  "Cue 2",
);
assert.equal(
  (fc.features[3] as { properties: { name: string } }).properties.name,
  "Cue 3",
);

const gpx = routeToGpx(route, cues, () => true, {
  artworkConnectorCount: 2,
  artworkMatchScore: 87.6,
});
assert(!gpx.includes("NaN"), "GPX must not contain invalid coordinates");
assert(!gpx.includes("91.0000000"), "GPX must not contain invalid latitudes");
assert(!gpx.includes("181.0000000"), "GPX must not contain invalid longitudes");
assert(!gpx.includes("Out of range cue"));
assert(!gpx.includes("Blank instruction"));
assert(!gpx.includes("Bad instruction"));
assert(gpx.includes("Finish strong"));
assert(gpx.includes("Turn &lt;left&gt; &amp; continue"));
assert(gpx.includes("<desc>Main &amp; 1st</desc>"));
assert(gpx.includes("Clean line score:"));
assert(gpx.includes("Artwork match score: 88%"));
assert(gpx.includes("Artwork connector strokes: 2"));

assert.equal(
  cuesToPlainText(cues, () => true),
  "1. Turn <left> & continue (Main & 1st)\n2. Finish strong\n3. Continue",
);
assert(!cuesToPlainText(cues).includes("Bad cue"));
assert(!cuesToPlainText(cues).includes("Out of range cue"));
assert(!cuesToPlainText(cues).includes("Blank instruction"));

console.log("routeExport tests ok");
