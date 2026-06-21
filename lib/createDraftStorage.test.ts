import assert from "node:assert/strict";
import {
  clearCreateDraft,
  loadCreateDraft,
  reconcileDraft,
  saveCreateDraft,
} from "./createDraftStorage";

const store = new Map<string, string>();

const fakeLocalStorage = {
  getItem(key: string) {
    return store.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    store.set(key, value);
  },
  removeItem(key: string) {
    store.delete(key);
  },
};

(globalThis as unknown as { window: unknown }).window = {
  localStorage: fakeLocalStorage,
};
(globalThis as unknown as { localStorage: unknown }).localStorage =
  fakeLocalStorage;

clearCreateDraft();

saveCreateDraft({
  currentStep: 4,
  selectedCityId: "manhattan",
  sourceKind: "image",
  contourCoordinates: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  anchorLocation: {
    anchorLatLngs: [
      [40, -73],
      [40.001, -73.001],
      [40.002, -73.002],
      [40.003, -73.003],
    ],
    center: [40.0015, -73.0015],
    rotationDeg: 12,
    scale: 1.4,
    connectorSegmentIndices: [2, 0, 2, 999, -1, 1.5],
    preferredSnappedRoute: {
      coordinates: [
        [40, -73],
        [40.0005, -73.0005],
        [40.001, -73.001],
      ],
      blockWaypoints: [
        [40, -73],
        [40.001, -73.001],
      ],
      distanceMeters: -180,
    },
  },
  snappedRoute: null,
  editedRoute: {
    coordinates: [
      [40, -73],
      [40.0005, -73.0005],
      [40.001, -73.001],
    ],
    blockWaypoints: [
      [40, -73],
      [40.001, -73.001],
    ],
    preserveBlockWaypoints: true,
  },
  finalRoute: null,
  uploadedImageBase64: null,
});

const loaded = loadCreateDraft();
assert(loaded, "draft should load");
assert.deepEqual(loaded.anchorLocation?.connectorSegmentIndices, [0, 2]);
assert.deepEqual(loaded.anchorLocation?.preferredSnappedRoute?.coordinates, [
  [40, -73],
  [40.0005, -73.0005],
  [40.001, -73.001],
]);
assert.deepEqual(loaded.anchorLocation?.preferredSnappedRoute?.blockWaypoints, [
  [40, -73],
  [40.001, -73.001],
]);
assert.equal(
  loaded.anchorLocation?.preferredSnappedRoute?.distanceMeters,
  undefined,
);
assert.equal(loaded.editedRoute?.preserveBlockWaypoints, true);

const staleFinalWithoutSnap = reconcileDraft({
  version: 1,
  updatedAt: new Date().toISOString(),
  currentStep: 6,
  selectedCityId: "manhattan",
  sourceKind: "image",
  contourCoordinates: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  anchorLocation: {
    anchorLatLngs: [
      [40, -73],
      [40.001, -73.001],
    ],
    center: [40, -73],
    rotationDeg: 0,
    scale: 1,
  },
  snappedRoute: null,
  editedRoute: {
    coordinates: [
      [40, -73],
      [40.001, -73.001],
    ],
  },
  finalRoute: {
    coordinates: [
      [40, -73],
      [40.001, -73.001],
    ],
  },
  uploadedImageBase64: "data:image/png;base64,abc",
});
assert.equal(staleFinalWithoutSnap.currentStep, 4);
assert.equal(staleFinalWithoutSnap.editedRoute, null);
assert.equal(staleFinalWithoutSnap.finalRoute, null);

const staleSourceOnly = reconcileDraft({
  version: 1,
  updatedAt: new Date().toISOString(),
  currentStep: 5,
  selectedCityId: "manhattan",
  sourceKind: null,
  contourCoordinates: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  anchorLocation: {
    anchorLatLngs: [
      [40, -73],
      [40.001, -73.001],
    ],
    center: [40, -73],
    rotationDeg: 0,
    scale: 1,
  },
  snappedRoute: {
    coordinates: [
      [40, -73],
      [40.001, -73.001],
    ],
  },
  editedRoute: null,
  finalRoute: null,
  uploadedImageBase64: "data:image/png;base64,abc",
});
assert.equal(staleSourceOnly.currentStep, 1);
assert.equal(staleSourceOnly.contourCoordinates, null);
assert.equal(staleSourceOnly.anchorLocation, null);
assert.equal(staleSourceOnly.snappedRoute, null);
assert.equal(staleSourceOnly.uploadedImageBase64, null);

clearCreateDraft();
assert.equal(loadCreateDraft(), null);

console.log("createDraftStorage tests ok");
