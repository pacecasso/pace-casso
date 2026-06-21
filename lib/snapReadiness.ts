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
};

export function classifySnapReadiness({
  hasRoute,
  cleanLineScore,
  interpretationScore,
  routeSource,
}: Options): SnapReadinessVerdict {
  if (!hasRoute) {
    return {
      tone: "blocked",
      title: "No snapped route yet",
      detail: "Wait for the street snap to finish, or retry if it failed.",
    };
  }

  if (
    cleanLineScore != null &&
    Number.isFinite(cleanLineScore) &&
    cleanLineScore < 55
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
    interpretationScore > 0 &&
    interpretationScore < 45
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
