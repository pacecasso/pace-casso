import type { NormalizedContourPoint } from "./extractNormalizedContourFromLineMask";

export type PhotoContourWorkerRequest = {
  id: number;
  mask: ArrayBuffer;
  level: number;
  boxSize: number;
  source?: "line-art" | "silhouette-outline";
};

export type PhotoContourWorkerResponse =
  | {
      id: number;
      ok: true;
      contour: NormalizedContourPoint[] | null;
      healthHint: string;
    }
  | { id: number; ok: false; error: string };
