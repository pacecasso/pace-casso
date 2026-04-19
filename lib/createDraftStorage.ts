import type { RouteLineString } from "./routeTypes";
import type { CityPreset } from "./cityPresets";
import { CITY_PRESETS, DEFAULT_CITY_ID } from "./cityPresets";

export type NormalizedPointDraft = { x: number; y: number };

export type AnchorLocationDraft = {
  anchorLatLngs: [number, number][];
  center: [number, number];
  rotationDeg: number;
  scale: number;
};

export type CreateDraftV1 = {
  version: 1;
  updatedAt: string;
  currentStep: number;
  selectedCityId: string;
  sourceKind: "image" | "freehand" | null;
  contourCoordinates: NormalizedPointDraft[] | null;
  anchorLocation: AnchorLocationDraft | null;
  snappedRoute: RouteLineString | null;
  editedRoute: RouteLineString | null;
  finalRoute: RouteLineString | null;
  /** Downscaled uploaded image as a data URL. Persisted so the Claude vision
   *  auto-placement still works after a page refresh. Skipped if too large to
   *  fit localStorage comfortably. */
  uploadedImageBase64: string | null;
};

/** Cap in characters (~1 MB). localStorage quota is typically 5 MB per origin,
 *  but we leave headroom for the rest of the draft + other localStorage uses. */
const MAX_PERSISTED_IMAGE_CHARS = 1_500_000;

const KEY = "pacecasso-create-draft-v1";

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidNormalizedPoint(v: unknown): v is NormalizedPointDraft {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return isFiniteNum(p.x) && isFiniteNum(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
}

function isValidLatLng(v: unknown): v is [number, number] {
  if (!Array.isArray(v) || v.length < 2) return false;
  return isFiniteNum(v[0]) && isFiniteNum(v[1]) && v[0] >= -90 && v[0] <= 90 && v[1] >= -180 && v[1] <= 180;
}

function isValidRouteCoords(coords: unknown): coords is [number, number][] {
  return Array.isArray(coords) && coords.length >= 2 && coords.every(isValidLatLng);
}

export function loadCreateDraft(): CreateDraftV1 | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const d = parsed as Partial<CreateDraftV1>;
    if (d.version !== 1) return null;
    if (typeof d.currentStep !== "number" || d.currentStep < 0 || d.currentStep > 6) {
      return null;
    }
    if (
      d.sourceKind !== null &&
      d.sourceKind !== "image" &&
      d.sourceKind !== "freehand"
    ) {
      return null;
    }
    const cityId =
      typeof d.selectedCityId === "string" && CITY_PRESETS[d.selectedCityId]
        ? d.selectedCityId
        : DEFAULT_CITY_ID;
    return {
      version: 1,
      updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : new Date().toISOString(),
      currentStep: d.currentStep,
      selectedCityId: cityId,
      sourceKind: d.sourceKind ?? null,
      contourCoordinates:
        Array.isArray(d.contourCoordinates) &&
        d.contourCoordinates.length >= 2 &&
        d.contourCoordinates.every(isValidNormalizedPoint)
          ? (d.contourCoordinates as NormalizedPointDraft[])
          : null,
      anchorLocation: (() => {
        const al = d.anchorLocation as AnchorLocationDraft | undefined;
        if (!al || typeof al !== "object") return null;
        if (!isValidRouteCoords(al.anchorLatLngs)) return null;
        if (!isValidLatLng(al.center)) return null;
        if (!isFiniteNum(al.rotationDeg) || !isFiniteNum(al.scale)) return null;
        return al;
      })(),
      snappedRoute:
        d.snappedRoute &&
        typeof d.snappedRoute === "object" &&
        isValidRouteCoords(d.snappedRoute.coordinates)
          ? d.snappedRoute
          : null,
      editedRoute:
        d.editedRoute &&
        typeof d.editedRoute === "object" &&
        isValidRouteCoords(d.editedRoute.coordinates)
          ? d.editedRoute
          : null,
      finalRoute:
        d.finalRoute &&
        typeof d.finalRoute === "object" &&
        isValidRouteCoords(d.finalRoute.coordinates)
          ? d.finalRoute
          : null,
      uploadedImageBase64:
        typeof d.uploadedImageBase64 === "string" &&
        d.uploadedImageBase64.startsWith("data:image/") &&
        d.uploadedImageBase64.length <= MAX_PERSISTED_IMAGE_CHARS * 1.2
          ? d.uploadedImageBase64
          : null,
    };
  } catch {
    return null;
  }
}

export function reconcileDraft(d: CreateDraftV1): CreateDraftV1 {
  let { currentStep, sourceKind, contourCoordinates, anchorLocation, snappedRoute } =
    { ...d };

  if (sourceKind === "image") {
    if (currentStep >= 3 && (!contourCoordinates || contourCoordinates.length < 2)) {
      currentStep = Math.min(currentStep, 2);
    }
    if (currentStep >= 4 && !anchorLocation) {
      currentStep = 3;
    }
  }
  if (sourceKind === "freehand") {
    if (currentStep >= 4 && !anchorLocation) {
      currentStep = 2;
    }
  }
  if (currentStep >= 5 && !snappedRoute) {
    currentStep = 4;
  }
  if (currentStep >= 6 && !d.finalRoute && !d.editedRoute) {
    currentStep = 5;
  }

  return {
    ...d,
    currentStep,
    contourCoordinates,
    anchorLocation,
    snappedRoute,
  };
}

export function saveCreateDraft(
  draft: Omit<CreateDraftV1, "version" | "updatedAt">,
): void {
  if (typeof window === "undefined") return;
  try {
    // Drop the image if it's too big to persist comfortably — the draft should
    // still save (route state, etc.). On refresh the user will just lose the
    // image and vision will quietly disable for that shape.
    const safeImage =
      draft.uploadedImageBase64 &&
      draft.uploadedImageBase64.length <= MAX_PERSISTED_IMAGE_CHARS
        ? draft.uploadedImageBase64
        : null;

    const payload: CreateDraftV1 = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...draft,
      uploadedImageBase64: safeImage,
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* quota or private mode — try again without the image if it was present */
    if (draft.uploadedImageBase64) {
      try {
        const payload: CreateDraftV1 = {
          version: 1,
          updatedAt: new Date().toISOString(),
          ...draft,
          uploadedImageBase64: null,
        };
        localStorage.setItem(KEY, JSON.stringify(payload));
      } catch {
        /* give up */
      }
    }
  }
}

export function clearCreateDraft(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function cityPresetFromDraftId(id: string): CityPreset {
  return CITY_PRESETS[id] ?? CITY_PRESETS[DEFAULT_CITY_ID];
}
