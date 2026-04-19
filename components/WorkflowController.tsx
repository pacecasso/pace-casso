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

const CREATE_INTRO_STORAGE_KEY = "pacecasso-create-intro-dismissed-v1";
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
import SocialLinks from "./SocialLinks";

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
  /**
   * Original uploaded image as a data-URL. Populated by Step1ImageUpload and
   * forwarded to Step2MapAnchor for Claude vision rescoring. Persisted to
   * draft storage when small enough (~1.5 MB cap); if it's too large to fit
   * the image silently won't persist and vision degrades to snap-only order
   * on refresh. Typical downscaled JPEGs from Step1 are ~150–400 KB, well
   * inside the cap.
   */
  const [uploadedImageBase64, setUploadedImageBase64] = useState<string | null>(
    null,
  );
  const [anchorLocation, setAnchorLocation] = useState<AnchorLocation>(null);
  const [snappedRoute, setSnappedRoute] = useState<RouteLineString | null>(
    null,
  );
  const [editedRoute, setEditedRoute] = useState<RouteLineString | null>(null);
  const [finalRoute, setFinalRoute] = useState<RouteLineString | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [showCreateIntro, setShowCreateIntro] = useState(false);
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
      setUploadedImageBase64(d.uploadedImageBase64 ?? null);
    }
    setDraftHydrated(true);
  }, []);

  useEffect(() => {
    try {
      setShowCreateIntro(
        typeof window !== "undefined" &&
          window.localStorage.getItem(CREATE_INTRO_STORAGE_KEY) !== "1",
      );
    } catch {
      setShowCreateIntro(true);
    }
  }, []);

  const dismissCreateIntro = useCallback(() => {
    try {
      window.localStorage.setItem(CREATE_INTRO_STORAGE_KEY, "1");
    } catch {
      /* ignore quota / private mode */
    }
    setShowCreateIntro(false);
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
        uploadedImageBase64,
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
    uploadedImageBase64,
  ]);

  const resetWorkflowData = useCallback(() => {
    setContourCoordinates(null);
    setUploadedImageBase64(null);
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
    setUploadedImageBase64(null);
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
        <div className="pace-app-nav flex items-center justify-between gap-3">
          <Link
            href="/landing.html"
            className="inline-block shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow focus-visible:ring-offset-2"
            aria-label="PaceCasso home"
          >
            <BrandLogo className="h-[clamp(2.5rem,7vw,3.75rem)] w-auto max-w-[min(360px,60vw)] object-contain object-left" />
          </Link>
          <nav
            className="flex shrink-0 items-center gap-x-4 gap-y-1 sm:gap-x-6"
            aria-label="Marketing links"
          >
            <Link
              href="/gallery"
              className="pace-nav-link font-bebas text-xs tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow sm:text-sm"
            >
              Gallery
            </Link>
            <Link
              href="/how"
              className="pace-nav-link font-bebas text-xs tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow sm:text-sm"
            >
              How it works
            </Link>
            <Link
              href="/help"
              className="pace-nav-link hidden font-bebas text-xs tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow sm:inline sm:text-sm"
            >
              Help
            </Link>
          </nav>
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
                        ? "bg-pace-yellow shadow-[0_0_0_1px_rgba(255,184,0,0.4)]"
                        : i === stepNum - 1
                          ? "pace-step-active bg-pace-blue"
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
        {draftHydrated &&
        currentStep === 0 &&
        showCreateIntro ? (
          <div
            className="border-b-2 border-pace-yellow/50 bg-pace-white px-[clamp(1rem,4vw,2.5rem)] py-4 shadow-sm"
            role="region"
            aria-label="Getting started"
          >
            <div className="mx-auto flex max-w-5xl flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0 flex-1">
                <p className="font-bebas text-base tracking-[0.12em] text-pace-ink">
                  First time here?
                </p>
                <ul className="mt-2 space-y-1.5 pl-4 text-xs leading-relaxed text-pace-muted [list-style-type:disc]">
                  <li>
                    Pick a city preset, then choose{" "}
                    <strong className="text-pace-ink">trace a photo</strong> or{" "}
                    <strong className="text-pace-ink">draw freehand</strong> on
                    the map.
                  </li>
                  <li>
                    We snap your shape to runnable streets—you can refine
                    waypoints before you export.
                  </li>
                  <li>
                    Progress saves in{" "}
                    <strong className="text-pace-ink">this browser</strong> until
                    you use{" "}
                    <strong className="text-pace-ink">START OVER</strong> in the
                    header.
                  </li>
                </ul>
                <p className="mt-3 text-xs text-pace-muted">
                  <Link
                    href="/help"
                    className="font-semibold text-pace-blue underline-offset-2 hover:underline"
                  >
                    Help
                  </Link>{" "}
                  covers exports, Mapbox issues, and draft storage.
                </p>
              </div>
              <button
                type="button"
                onClick={dismissCreateIntro}
                className="shrink-0 rounded-lg border border-pace-line bg-pace-warm px-4 py-2 font-bebas text-sm tracking-[0.12em] text-pace-ink transition hover:border-pace-yellow hover:bg-pace-white"
              >
                Got it
              </button>
            </div>
          </div>
        ) : null}
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
            cityPreset={cityPreset}
            onPickAreaTemplate={(contour) => {
              setSourceKind("image");
              setContourCoordinates(contour as NormalizedPoint[]);
              setCurrentStep(3);
            }}
          />
        )}

        {currentStep === 2 && sourceKind === "image" && (
          <Step1ImageUpload
            onBack={goBackToSourcePicker}
            onComplete={(normalizedContour, imageBase64) => {
              setContourCoordinates(normalizedContour);
              setUploadedImageBase64(imageBase64);
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
            cityPreset={cityPreset}
            defaultCenter={cityPreset.defaultCenter}
            imageBase64={uploadedImageBase64}
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
            routeSource={sourceKind === "freehand" ? "freehand" : "image"}
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
            routeSource={sourceKind === "freehand" ? "freehand" : "image"}
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
              routeSource={sourceKind === "freehand" ? "freehand" : "image"}
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
        <SocialLinks />
        <span aria-hidden> · </span>
        Design. Run. Repeat.
      </footer>
    </main>
  );
}
