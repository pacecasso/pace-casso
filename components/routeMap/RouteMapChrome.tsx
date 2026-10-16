"use client";

/**
 * Floating map controls in the onthegomap layout: small white pills in the
 * map corners instead of a wall of sidebar buttons, a big distance readout
 * bottom-right (tap to switch km / mi), and a right-click / long-press menu.
 */

import { useEffect, useRef, type ReactNode } from "react";
import {
  estimateSeconds,
  formatDuration,
  KM_PER_MI,
  type RunnerProfile,
} from "../../lib/runnerProfile";

const sw = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export const Icons = {
  clear: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  undo: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </svg>
  ),
  redo: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 000 12h3" />
    </svg>
  ),
  reverse: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <path d="M7 4L3 8l4 4" />
      <path d="M3 8h14" />
      <path d="M17 20l4-4-4-4" />
      <path d="M21 16H7" />
    </svg>
  ),
  outBack: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <path d="M4 9h13a3 3 0 010 6H7" />
      <path d="M10 12l-3 3 3 3" />
    </svg>
  ),
  loop: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4" />
    </svg>
  ),
  walk: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <circle cx="13" cy="4" r="1.6" fill="currentColor" />
      <path d="M9 21l2.5-6 2.5 2v4" />
      <path d="M7 12l3-4 4 1 2 3h3" />
      <path d="M11.5 15L10 8" />
    </svg>
  ),
  ruler: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <path d="M5 19L19 5" />
      <circle cx="5" cy="19" r="1.8" fill="currentColor" />
      <circle cx="19" cy="5" r="1.8" fill="currentColor" />
    </svg>
  ),
  fit: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  ),
  locate: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  ),
  dots: (
    <svg viewBox="0 0 24 24" width="18" height="18" {...sw}>
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  ),
};

/** Floating white pill; position with `className` (absolute + corner). */
export function MapPill({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`pointer-events-auto absolute z-[1000] flex items-center gap-0.5 rounded-lg bg-white/95 p-0.5 shadow-[0_1px_4px_rgba(0,0,0,0.3)] backdrop-blur-sm ${className}`}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function PillButton({
  label,
  onClick,
  disabled,
  active,
  children,
  shortcut,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 min-w-9 items-center justify-center rounded-md px-2 transition ${
        active
          ? "bg-pace-ink/10 text-pace-ink"
          : "text-pace-ink/80 hover:bg-pace-ink/5 hover:text-pace-ink"
      } disabled:cursor-default disabled:text-pace-ink/25 disabled:hover:bg-transparent`}
    >
      {children}
    </button>
  );
}

/** Big bottom-right distance readout; tap toggles km / mi. */
export function DistanceBadge({
  meters,
  profile,
  onToggleUnit,
  busy,
  className = "",
}: {
  meters: number;
  profile: RunnerProfile;
  onToggleUnit: () => void;
  busy?: boolean;
  className?: string;
}) {
  const km = meters / 1000;
  const value = profile.unit === "mi" ? km / KM_PER_MI : km;
  const shown = value < 10 ? value.toFixed(2) : value.toFixed(1);
  const time = km > 0 ? formatDuration(estimateSeconds(km, profile.paceSecPerKm)) : "";
  return (
    <button
      type="button"
      onClick={onToggleUnit}
      onPointerDown={(e) => e.stopPropagation()}
      title={`Switch to ${profile.unit === "mi" ? "km" : "miles"}`}
      className={`pointer-events-auto absolute bottom-3 right-3 z-[1000] rounded-xl bg-white/95 px-3 pb-1 pt-1.5 text-right shadow-[0_1px_4px_rgba(0,0,0,0.3)] backdrop-blur-sm ${className}`}
    >
      <span className="block font-bebas text-[2.6rem] leading-[0.9] tracking-wide text-pace-ink sm:text-5xl">
        {shown}
        <span className="ml-1 text-[1.6rem] sm:text-3xl">{profile.unit}</span>
      </span>
      <span className="block font-dm text-[10px] font-medium text-pace-muted">
        {busy ? "routing…" : time ? `≈ ${time} at your pace` : `tap for ${profile.unit === "mi" ? "km" : "mi"}`}
      </span>
    </button>
  );
}

export type ContextMenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  checked?: boolean;
};

/** Right-click / long-press menu, positioned in map-container pixels. */
export function RouteContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  // Keep the menu inside the map: flip left / up near the far edges.
  const parent = ref.current?.parentElement;
  const w = parent?.clientWidth ?? 9999;
  const h = parent?.clientHeight ?? 9999;
  const left = x + 200 > w ? Math.max(4, x - 200) : x + 4;
  const top = y + items.length * 40 + 8 > h ? Math.max(4, y - items.length * 40 - 8) : y + 4;

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute z-[1100] w-[196px] overflow-hidden rounded-lg bg-white py-1 shadow-[0_4px_16px_rgba(0,0,0,0.25)]"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left font-dm text-sm text-pace-ink hover:bg-pace-ink/5 disabled:text-pace-ink/30"
        >
          <span className="flex w-[18px] justify-center text-pace-ink/70">
            {it.checked ? "✓" : it.icon}
          </span>
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** True when a keyboard event is aimed at a text field (skip shortcuts). */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}
