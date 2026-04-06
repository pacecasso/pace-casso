/** User-facing step labels; internal step indices stay as in WorkflowController. */

export type StepNum = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const IMAGE_FLOW: StepNum[] = [0, 1, 2, 3, 4, 5, 6];

const IMAGE_LABELS = [
  "Pick city",
  "How you’ll draw",
  "Trace your shape",
  "Place on map",
  "Snap to streets",
  "Tune your route",
  "Export & share",
] as const;

const FREEHAND_ORDER: StepNum[] = [0, 1, 2, 4, 5, 6];

const FREEHAND_LABELS = [
  "Pick city",
  "How you’ll draw",
  "Draw on map",
  "Snap to streets",
  "Tune your route",
  "Export & share",
] as const;

export function getStepDisplay(
  currentStep: StepNum,
  sourceKind: "image" | "freehand" | null,
): { stepNum: number; total: number; label: string } {
  if (sourceKind === "freehand") {
    const idx = FREEHAND_ORDER.indexOf(currentStep);
    const i = idx === -1 ? 0 : idx;
    return {
      stepNum: i + 1,
      total: FREEHAND_LABELS.length,
      label: FREEHAND_LABELS[i] ?? FREEHAND_LABELS[0],
    };
  }

  const i = IMAGE_FLOW.indexOf(currentStep);
  const safe = i === -1 ? 0 : i;
  return {
    stepNum: safe + 1,
    total: IMAGE_LABELS.length,
    label: IMAGE_LABELS[safe] ?? IMAGE_LABELS[0],
  };
}
