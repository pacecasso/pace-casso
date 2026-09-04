export type SnapReadinessTone = "ready" | "check" | "blocked";

export type SnapReadinessVerdict = {
  tone: SnapReadinessTone;
  title: string;
  detail: string;
};

type Options = {
  hasRoute: boolean;
  cleanLineScore: number | null;
  interpretationScore: number | null;
  routeSource: "image" | "freehand";
  verifiedRoute?: boolean;
  draftRoute?: boolean;
};

export const MIN_CLEAN_ROUTE_SCORE = 35;
export const CHECK_CLEAN_ROUTE_SCORE = 55;
export const MIN_IMAGE_INTERPRETATION_SCORE = 50;
export const CHECK_IMAGE_INTERPRETATION_SCORE = 65;

export function classifySnapReadiness({
  hasRoute,
  cleanLineScore,
  interpretationScore,
  routeSource,
  verifiedRoute = false,
  draftRoute = false,
}: Options): SnapReadinessVerdict {
  if (!hasRoute) {
    return {
      tone: "blocked",
      title: "No snapped route yet",
      detail: "Wait for the street snap to finish, or retry if it failed.",
    };
  }

  if (draftRoute && !verifiedRoute) {
    return {
      tone: "check",
      title: "First draft — not yet recognized",
      detail:
        "Painted on real streets and runnable as-is, but no stranger named it at a glance. Tweak it in the editor, or go back and search again.",
    };
  }
  if (verifiedRoute) {
    return {
      tone: "ready",
      title: "Verified runnable GPS art",
      detail:
        "Blind judges recognized this route on real streets, so it keeps its exact block-by-block path.",
    };
  }
  if (
    cleanLineScore != null &&
    Number.isFinite(cleanLineScore) &&
    cleanLineScore < MIN_CLEAN_ROUTE_SCORE
  ) {
    return {
      tone: "blocked",
      title: "Route is not runnable art yet",
      detail:
        "The final street route breaks into too many retraces or tiny corrections. Retry this placement before tuning.",
    };
  }

  if (
    cleanLineScore != null &&
    Number.isFinite(cleanLineScore) &&
    cleanLineScore < CHECK_CLEAN_ROUTE_SCORE
  ) {
    return {
      tone: "check",
      title: "Route needs a look",
      detail:
        "Some streets retrace or use tiny corrective jogs. That can be valid GPS art, but check the editor before exporting.",
    };
  }

  if (
    routeSource === "image" &&
    interpretationScore != null &&
    Number.isFinite(interpretationScore) &&
    interpretationScore < MIN_IMAGE_INTERPRETATION_SCORE
  ) {
    return {
      tone: "blocked",
      title: "Shape does not read yet",
      detail:
        "The final street route no longer resembles the uploaded art. Try another placement before tuning.",
    };
  }

  if (
    routeSource === "image" &&
    interpretationScore != null &&
    Number.isFinite(interpretationScore) &&
    interpretationScore < CHECK_IMAGE_INTERPRETATION_SCORE
  ) {
    return {
      tone: "check",
      title: "Shape may not read",
      detail:
        "The snapped streets drift far from the artwork. Try another placement or tune the route before exporting.",
    };
  }

  return {
    tone: "ready",
    title: "Street snap looks usable",
    detail:
      "The route is walkable, reasonably clean, and ready for waypoint tuning.",
  };
}
