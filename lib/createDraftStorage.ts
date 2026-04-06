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
};

const KEY = "pacecasso-create-draft-v1";

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
      contourCoordinates: Array.isArray(d.contourCoordinates)
        ? d.contourCoordinates
        : null,
      anchorLocation:
        d.anchorLocation &&
        typeof d.anchorLocation === "object" &&
        Array.isArray((d.anchorLocation as AnchorLocationDraft).anchorLatLngs)
          ? (d.anchorLocation as AnchorLocationDraft)
          : null,
      snappedRoute:
        d.snappedRoute &&
        typeof d.snappedRoute === "object" &&
        Array.isArray(d.snappedRoute.coordinates)
          ? d.snappedRoute
          : null,
      editedRoute:
        d.editedRoute &&
        typeof d.editedRoute === "object" &&
        Array.isArray(d.editedRoute.coordinates)
          ? d.editedRoute
          : null,
      finalRoute:
        d.finalRoute &&
        typeof d.finalRoute === "object" &&
        Array.isArray(d.finalRoute.coordinates)
          ? d.finalRoute
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
    const payload: CreateDraftV1 = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...draft,
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* quota or private mode */
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
