/// <reference lib="webworker" />

import { extractNormalizedContourFromLineMask } from "../lib/extractNormalizedContourFromLineMask";
import { describeLineMaskHealth } from "../lib/lineMaskHealth";
import type {
  PhotoContourWorkerRequest,
  PhotoContourWorkerResponse,
} from "../lib/photoContourWorkerMessages";

self.onmessage = (ev: MessageEvent<PhotoContourWorkerRequest>) => {
  const { id, mask, level, boxSize } = ev.data;
  try {
    const u8 = new Uint8Array(mask);
    const health = describeLineMaskHealth(u8, boxSize, boxSize);
    const contour = extractNormalizedContourFromLineMask(
      u8,
      level,
      boxSize,
      boxSize,
    );
    const msg: PhotoContourWorkerResponse = {
      id,
      ok: true,
      contour,
      healthHint: health.hint,
    };
    self.postMessage(msg);
  } catch (err) {
    const msg: PhotoContourWorkerResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(msg);
  }
};
