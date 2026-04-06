"use client";

import type { ReactNode } from "react";

type Props = {
  label: string;
  title: string;
  titleColorClass?: string;
  description?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  centered?: boolean;
  /** Tighter spacing and type for dense create-flow steps */
  compact?: boolean;
  className?: string;
};

/**
 * Shared hero block for create flow — matches landing section-label + Anton headline rhythm.
 */
export default function CreateStepIntro({
  label,
  title,
  titleColorClass = "text-pace-blue",
  description,
  onBack,
  backLabel = "← Back",
  centered = true,
  compact = false,
  className = "",
}: Props) {
  return (
    <div
      className={`mx-auto max-w-2xl ${compact ? "mb-3" : "mb-8"} ${centered ? "text-center" : ""} ${className}`}
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className={`pace-link-back ${compact ? "mb-2" : "mb-4"}`}
        >
          {backLabel}
        </button>
      ) : null}
      <div
        className={`pace-section-label ${centered ? "mx-auto justify-center" : ""}`}
      >
        {label}
      </div>
      <h2
        className={`font-pace-heading uppercase leading-[0.98] tracking-wide ${compact ? "text-2xl sm:text-3xl" : "text-3xl sm:text-4xl"} ${titleColorClass}`}
      >
        {title}
      </h2>
      {description ? (
        <div
          className={`font-dm leading-relaxed text-pace-muted ${compact ? "mt-2 text-xs" : "mt-3 text-sm"}`}
        >
          {description}
        </div>
      ) : null}
    </div>
  );
}
