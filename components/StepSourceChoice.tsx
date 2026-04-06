"use client";

import { ImageIcon, PencilLine } from "lucide-react";
import CreateStepIntro from "./CreateStepIntro";

type Props = {
  onBack: () => void;
  onChooseImage: () => void;
  onChooseFreehand: () => void;
};

export default function StepSourceChoice({
  onBack,
  onChooseImage,
  onChooseFreehand,
}: Props) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 px-3 py-2 sm:gap-5 sm:py-3">
      <CreateStepIntro
        compact
        label="Choose a path"
        title="How do you want to draw?"
        onBack={onBack}
        backLabel="← Change city"
        description={
          <>
            <strong className="text-pace-ink">From a photo</strong> — trace a
            shape, then drop it on the map.{" "}
            <strong className="text-pace-ink">Freehand</strong> — draw right on
            the map, then we snap it to streets.
          </>
        }
      />

      <div className="grid w-full max-w-2xl gap-3 sm:grid-cols-2 sm:gap-4">
        <button
          type="button"
          onClick={onChooseImage}
          className="pace-card-editorial group flex flex-col items-center gap-3 p-4 text-center shadow-sm transition hover:border-pace-blue hover:shadow-md active:scale-[0.99] sm:p-5"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-pace-blue/30 bg-pace-blue/10 text-pace-blue transition group-hover:bg-pace-blue/15 sm:h-12 sm:w-12">
            <ImageIcon className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden />
          </span>
          <span>
            <span className="font-bebas block text-base tracking-[0.1em] text-pace-ink sm:text-lg">
              From a photo
            </span>
            <span className="mt-0.5 block text-[11px] leading-snug text-pace-muted sm:text-xs">
              Trace an image, place on map
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onChooseFreehand}
          className="pace-card-editorial group flex flex-col items-center gap-3 border-t-pace-yellow bg-gradient-to-b from-pace-yellow/12 to-white p-4 text-center shadow-sm transition hover:shadow-md active:scale-[0.99] sm:p-5"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-pace-yellow bg-pace-yellow/20 text-pace-ink transition group-hover:bg-pace-yellow/30 sm:h-12 sm:w-12">
            <PencilLine className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden />
          </span>
          <span>
            <span className="font-bebas block text-base tracking-[0.1em] text-pace-ink sm:text-lg">
              Draw on the map
            </span>
            <span className="mt-0.5 block text-[11px] leading-snug text-pace-muted sm:text-xs">
              Sketch your route by hand
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
