"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RouteLineString } from "../lib/routeTypes";
import {
  clearCreateDraft,
  cityPresetFromDraftId,
  loadCreateDraft,
  reconcileDraft,
  saveCreateDraft,
} from "../lib/createDraftStorage";
import { getStepDisplay, type StepNum as DisplayStepNum } from "../lib/workflowStepDisplay";
import {
  CITY_PRESETS,
  DEFAULT_CITY_ID,
  type CityPreset,
} from "../lib/cityPresets";
import Step1ImageUpload, { NormalizedPoint } from "./Step1ImageUpload";
import Step2MapAnchor from "./Step2MapAnchor";
import Step3StreetSnap from "./Step3StreetSnap";
import Step4RouteEditor from "./Step4RouteEditor";
import Step5RouteComplete from "./Step5RouteComplete";
import StepCityGate from "./StepCityGate";
import StepFreehandMapDraw from "./StepFreehandMapDraw";
import StepSourceChoice from "./StepSourceChoice";
import BrandLogo from "./BrandLogo";

type StepNum = DisplayStepNum;

export type AnchorLocation = {
  anchorLatLngs: [number, number][];
  center: [number, number];
  rotationDeg: number;
  scale: number;
} | null;

export type { RouteLineString };

export default function WorkflowController() {
  const [currentStep, setCurrentStep] = useState<StepNum>(0);
  const [cityPreset, setCityPreset] = useState<CityPreset>(
    () => CITY_PRESETS[DEFAULT_CITY_ID],
  );
  const [selectedCityId, setSelectedCityId] = useState<string>(DEFAULT_CITY_ID);
  const [sourceKind, setSourceKind] = useState<"image" | "freehand" | null>(
    null,
  );
  const [contourCoordinates, setContourCoordinates] = useState<
    NormalizedPoint[] | null
  >(null);
  const [anchorLocation, setAnchorLocation] = useState<AnchorLocation>(null);
  const [snappedRoute, setSnappedRoute] = useState<RouteLineString | null>(
    null,
  );
  const [editedRoute, setEditedRoute] = useState<RouteLineString | null>(null);
  const [finalRoute, setFinalRoute] = useState<RouteLineString | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const stepTitleRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const raw = loadCreateDraft();
    if (raw) {
      const d = reconcileDraft(raw);
      setCurrentStep(d.currentStep as StepNum);
      setSelectedCityId(d.selectedCityId);
      setCityPreset(cityPresetFromDraftId(d.selectedCityId));
      setSourceKind(d.sourceKind);
      setContourCoordinates(
        d.contourCoordinates?.length
          ? (d.contourCoordinates as NormalizedPoint[])
          : null,
      );
      setAnchorLocation(
        d.anchorLocation
          ? {
              anchorLatLngs: d.anchorLocation.anchorLatLngs,
              center: d.anchorLocation.center,
              rotationDeg: d.anchorLocation.rotationDeg,
              scale: d.anchorLocation.scale,
            }
          : null,
      );
      setSnappedRoute(d.snappedRoute);
      setEditedRoute(d.editedRoute);
      setFinalRoute(d.finalRoute);
    }
    setDraftHydrated(true);
  }, []);

  useEffect(() => {
    if (!draftHydrated) return;
    const id = window.setTimeout(() => {
      const hasProgress =
        currentStep > 0 ||
        selectedCityId !== DEFAULT_CITY_ID ||
        sourceKind !== null ||
        (contourCoordinates != null && contourCoordinates.length > 0) ||
        anchorLocation !== null ||
        snappedRoute !== null ||
        editedRoute !== null ||
        finalRoute !== null;

      if (!hasProgress) {
        clearCreateDraft();
        return;
      }

      saveCreateDraft({
        currentStep,
        selectedCityId,
        sourceKind,
        contourCoordinates,
        anchorLocation: anchorLocation
          ? {
              anchorLatLngs: anchorLocation.anchorLatLngs,
              center: anchorLocation.center,
              rotationDeg: anchorLocation.rotationDeg,
              scale: anchorLocation.scale,
            }
          : null,
        snappedRoute,
        editedRoute,
        finalRoute,
      });
    }, 400);
    return () => window.clearTimeout(id);
  }, [
    draftHydrated,
    currentStep,
    selectedCityId,
    sourceKind,
    contourCoordinates,
    anchorLocation,
    snappedRoute,
    editedRoute,
    finalRoute,
  ]);

  const resetWorkflowData = useCallback(() => {
    setContourCoordinates(null);
    setAnchorLocation(null);
    setSnappedRoute(null);
    setEditedRoute(null);
    setFinalRoute(null);
    setSourceKind(null);
  }, []);

  const handleStartOver = useCallback(() => {
    clearCreateDraft();
    resetWorkflowData();
    setCurrentStep(0);
  }, [resetWorkflowData]);

  const handleSelectCityId = useCallback((id: string) => {
    setSelectedCityId(id);
    const p = CITY_PRESETS[id];
    if (p) setCityPreset(p);
  }, []);

  const goBackToSourcePicker = useCallback(() => {
    setContourCoordinates(null);
    setSourceKind(null);
    setCurrentStep(1);
  }, []);

  const { stepNum, total, label } = getStepDisplay(currentStep, sourceKind);

  const showHeaderStartOver =
    currentStep > 0 ||
    sourceKind !== null ||
    selectedCityId !== DEFAULT_CITY_ID ||
    contourCoordinates != null ||
    anchorLocation !== null ||
    snappedRoute != null ||
    editedRoute != null ||
    finalRoute != null;

  const stepRecap = useMemo(() => {
    if (currentStep < 1) return null;
    const parts: string[] = [cityPreset.label];
    if (sourceKind === "image") parts.push("Photo");
    else if (sourceKind === "freehand") parts.push("Freehand");
    const routeForDistance = finalRoute ?? editedRoute ?? snappedRoute;
    const dm = routeForDistance?.distanceMeters;
    if (dm != null && Number.isFinite(dm)) {
      parts.push(`${(dm / 1000).toFixed(1)} km`);
    }
    return parts.join(" · ");
  }, [
    currentStep,
    cityPreset.label,
    sourceKind,
    finalRoute,
    editedRoute,
    snappedRoute,
  ]);

  useLayoutEffect(() => {
    const scrollTop = () => {
      window.scrollTo(0, 0);
      const root = document.scrollingElement ?? document.documentElement;
      root.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    scrollTop();
    requestAnimationFrame(scrollTop);
    queueMicrotask(scrollTop);
  }, [currentStep, sourceKind]);

  useLayoutEffect(() => {
    const el = stepTitleRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [currentStep, sourceKind]);

  return (
    <main className="flex min-h-screen flex-col bg-pace-warm">
      <header className="sticky top-0 z-40 bg-pace-white">
        <div className="pace-app-nav flex flex-wrap items-center justify-between gap-4">
          <Link
            href="/landing.html"
            className="inline-block shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow focus-visible:ring-offset-2"
            aria-label="PaceCasso home"
          >
            <BrandLogo />
          </Link>
          <nav
            className="order-3 flex w-full flex-wrap items-center justify-center gap-x-8 gap-y-2 border-t border-pace-line pt-3 sm:order-none sm:w-auto sm:border-t-0 sm:pt-0 lg:flex-1 lg:justify-center"
            aria-label="Marketing links"
          >
            <Link
              href="/landing.html#gallery"
              className="pace-nav-link font-bebas text-sm tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
            >
              Gallery
            </Link>
            <Link
              href="/landing.html#how"
              className="pace-nav-link font-bebas text-sm tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
            >
              How it works
            </Link>
            <Link
              href="/landing.html#community"
              className="pace-nav-link font-bebas text-sm tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
            >
              Community
            </Link>
          </nav>
          <div className="hidden min-w-0 flex-col items-end gap-0.5 text-right lg:flex">
            <div className="flex items-center gap-2">
              <span className="h-px w-6 bg-pace-yellow" aria-hidden />
              <p className="pace-tagline-primary shrink-0 text-[9px]">
                DESIGN · RUN · REPEAT
              </p>
              <span className="h-px w-6 bg-pace-yellow" aria-hidden />
            </div>
            <p className="pace-tagline-secondary text-base leading-tight">
              Where miles make masterpieces.
            </p>
          </div>
        </div>

        <div className="border-b border-pace-line bg-pace-white px-[clamp(1rem,4vw,2.5rem)] py-1.5 sm:py-2">
          <div className="mx-auto flex max-w-5xl flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="pace-highlight flex min-w-0 flex-col gap-0.5">
              <div className="flex min-w-0 flex-row flex-wrap items-center gap-x-2 gap-y-0">
                <h2
                  ref={stepTitleRef}
                  tabIndex={-1}
                  className="font-bebas min-w-0 truncate text-sm tracking-[0.1em] text-pace-ink outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow focus-visible:ring-offset-2 sm:text-base"
                >
                  {label}
                </h2>
                <p className="shrink-0 text-[10px] font-medium tracking-wide text-pace-muted sm:text-xs">
                  Step {stepNum} of {total}
                </p>
              </div>
              {stepRecap ? (
                <p
                  className="font-dm min-w-0 truncate text-[10px] text-pace-muted sm:text-[11px]"
                  title={stepRecap}
                >
                  {stepRecap}
                </p>
              ) : null}
              <p className="font-dm text-[10px] leading-snug text-pace-muted/85 lg:hidden">
                Where miles make masterpieces.
              </p>
            </div>
            <div className="flex w-full min-w-0 flex-row flex-wrap items-center gap-2 sm:max-w-xl sm:flex-1 sm:justify-end sm:gap-2.5">
              <div
                className="flex min-w-0 flex-1 gap-1 sm:max-w-[min(100%,17.5rem)]"
                role="list"
                aria-label="Progress"
              >
                {Array.from({ length: total }, (_, i) => (
                  <div
                    key={i}
                    role="listitem"
                    className={`h-2.5 flex-1 rounded-full transition-all duration-300 sm:h-2 sm:max-w-8 ${
                      i < stepNum - 1
                        ? "bg-pace-yellow"
                        : i === stepNum - 1
                          ? "bg-pace-blue ring-1 ring-pace-blue/30"
                          : "bg-pace-line"
                    }`}
                  />
                ))}
              </div>
              {showHeaderStartOver ? (
                <button
                  type="button"
                  onClick={handleStartOver}
                  className="pace-start-over-header shrink-0 font-bebas text-[10px] tracking-[0.14em] text-pace-muted underline decoration-pace-line underline-offset-2 transition hover:text-pace-ink hover:decoration-pace-yellow sm:text-[11px]"
                  aria-label="Start over — clear saved draft and return to city selection"
                >
                  START OVER
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <section className="pace-create-surface flex flex-1 flex-col">
        {currentStep === 0 && (
          <StepCityGate
            selectedCityId={selectedCityId}
            onSelectCityId={handleSelectCityId}
            onContinue={() => setCurrentStep(1)}
          />
        )}

        {currentStep === 1 && (
          <StepSourceChoice
            onBack={() => setCurrentStep(0)}
            onChooseImage={() => {
              setSourceKind("image");
              setCurrentStep(2);
            }}
            onChooseFreehand={() => {
              setSourceKind("freehand");
              setCurrentStep(2);
            }}
          />
        )}

        {currentStep === 2 && sourceKind === "image" && (
          <Step1ImageUpload
            onBack={goBackToSourcePicker}
            onComplete={(normalizedContour) => {
              setContourCoordinates(normalizedContour);
              setCurrentStep(3);
            }}
          />
        )}

        {currentStep === 2 && sourceKind === "freehand" && (
          <StepFreehandMapDraw
            defaultCenter={cityPreset.defaultCenter}
            onBack={goBackToSourcePicker}
            onComplete={({ anchorLatLngs, contour, center }) => {
              setContourCoordinates(contour);
              setAnchorLocation({
                anchorLatLngs,
                center,
                rotationDeg: 0,
                scale: 1,
              });
              setCurrentStep(4);
            }}
          />
        )}

        {currentStep === 3 && contourCoordinates && sourceKind === "image" && (
          <Step2MapAnchor
            contour={contourCoordinates}
            defaultCenter={cityPreset.defaultCenter}
            onBack={() => setCurrentStep(2)}
            onComplete={({ anchorLatLngs, center, rotationDeg, scale }) => {
              setAnchorLocation({
                anchorLatLngs,
                center,
                rotationDeg,
                scale,
              });
              setCurrentStep(4);
            }}
          />
        )}

        {currentStep === 4 && anchorLocation && (
          <Step3StreetSnap
            anchorLocation={anchorLocation}
            onBack={() => {
              if (sourceKind === "freehand") {
                setSnappedRoute(null);
                setAnchorLocation(null);
                setContourCoordinates(null);
                setCurrentStep(2);
              } else {
                setCurrentStep(3);
              }
            }}
            onComplete={(snapped) => {
              setSnappedRoute(snapped);
              setCurrentStep(5);
            }}
          />
        )}

        {currentStep === 5 && anchorLocation && snappedRoute && (
          <Step4RouteEditor
            anchorLocation={anchorLocation}
            snappedRoute={snappedRoute}
            onBack={() => {
              setSnappedRoute(null);
              setCurrentStep(4);
            }}
            onComplete={(route) => {
              setEditedRoute(route);
              setFinalRoute(route);
              setCurrentStep(6);
            }}
          />
        )}

        {currentStep === 6 &&
          ((finalRoute ?? editedRoute) && anchorLocation ? (
            <Step5RouteComplete
              route={finalRoute ?? editedRoute!}
              anchorLocation={anchorLocation}
              onBackToFineTune={() => setCurrentStep(5)}
              onStartOver={handleStartOver}
            />
          ) : (
            <div className="flex min-h-[calc(100dvh-14rem)] flex-col items-center justify-center gap-6 px-4 text-center">
              <p className="max-w-sm text-sm leading-relaxed text-pace-muted">
                Something went wrong. Start again from the beginning.
              </p>
              <button
                type="button"
                className="pace-btn-primary px-8"
                onClick={handleStartOver}
              >
                Start over
              </button>
            </div>
          ))}
      </section>

      <footer className="mt-auto border-t border-pace-line bg-pace-warm px-[clamp(1.25rem,4vw,2.5rem)] py-8 pb-[max(2rem,env(safe-area-inset-bottom))] text-center text-xs text-pace-muted font-dm">
        <Link
          href="/landing.html"
          className="font-bebas tracking-[0.18em] text-pace-yellow transition hover:text-pace-ink"
        >
          PaceCasso
        </Link>
        <span aria-hidden> · </span>
        <Link
          href="/help"
          className="font-bebas tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
        >
          Help
        </Link>
        <span aria-hidden> · </span>
        <Link
          href="/privacy"
          className="font-bebas tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
        >
          Privacy
        </Link>
        <span aria-hidden> · </span>
        <Link
          href="/contact"
          className="font-bebas tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
        >
          Contact
        </Link>
        <span aria-hidden> · </span>
        Design. Run. Repeat.
      </footer>
    </main>
  );
}
