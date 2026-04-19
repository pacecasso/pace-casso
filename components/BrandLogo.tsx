"use client";

import Image from "next/image";
import { useState } from "react";

/** Try these in order (Next.js only serves files under `public/`). */
const LOGO_URLS = [
  "/pacelogo.png",
  "/pacelogo/pacelogo.png",
  "/brand/logo.png",
] as const;

const DEFAULT_CLASS =
  "h-[clamp(5rem,16vw,8rem)] w-auto max-w-[min(560px,92vw)] object-contain object-left";

type Props = {
  className?: string;
};

/**
 * Renders the PNG immediately (same as landing) so there is no text flash on
 * navigation. Falls back to typographic lockup only if every URL fails.
 */
function TypographicLockup({ className }: { className?: string }) {
  return (
    <span
      className={`font-bebas inline-flex items-baseline text-[clamp(2rem,5vw,2.75rem)] leading-none tracking-[0.04em] ${className ?? ""}`}
      aria-label="PaceCasso"
    >
      <span className="text-pace-yellow">P</span>
      <span className="text-pace-ink">ACE</span>
      <span className="text-pace-blue">CASSO</span>
    </span>
  );
}

export default function BrandLogo({ className }: Props) {
  const [index, setIndex] = useState(0);
  const imgClass = className ?? DEFAULT_CLASS;

  if (index >= LOGO_URLS.length) {
    return <TypographicLockup className={imgClass} />;
  }

  return (
    <Image
      key={LOGO_URLS[index]}
      src={LOGO_URLS[index]}
      alt="PaceCasso"
      className={imgClass}
      width={480}
      height={114}
      priority
      onError={() => setIndex((i) => i + 1)}
    />
  );
}
