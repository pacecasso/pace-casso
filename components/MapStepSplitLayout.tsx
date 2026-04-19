"use client";

import type { ReactNode } from "react";

type Props = {
  railCollapsed: boolean;
  onToggleRail: () => void;
  sidebar: ReactNode;
  map: ReactNode;
  /** Pinned below scrollable sidebar (e.g. Back + primary CTA always visible on mobile). */
  sidebarFooter?: ReactNode;
};

/**
 * Map-heavy create steps: scrollable controls rail + map column.
 * On lg+, rail can collapse for maximum map area.
 */
export default function MapStepSplitLayout({
  railCollapsed,
  onToggleRail,
  sidebar,
  map,
  sidebarFooter,
}: Props) {
  const asideMobileMaxH = sidebarFooter
    ? "max-lg:max-h-[48vh]"
    : "max-lg:max-h-[42vh]";
  const mapMobileMinH = sidebarFooter
    ? "max-lg:min-h-[min(38vh,17rem)]"
    : "max-lg:min-h-[min(45vh,20rem)]";

  return (
    <div className="pace-map-step-root">
      <aside
        className={`order-1 flex min-h-0 flex-col overflow-hidden border-b-2 border-pace-yellow bg-pace-white shadow-sm ${asideMobileMaxH} lg:order-none lg:w-[min(100%,22rem)] lg:max-h-none lg:shrink-0 lg:overflow-hidden lg:border-b-0 lg:border-r lg:border-pace-line lg:px-4 lg:py-3 lg:shadow-none xl:w-96 lg:transition-[width,opacity,padding,border-width] lg:duration-200 ${
          railCollapsed
            ? "lg:w-0 lg:max-w-0 lg:overflow-hidden lg:border-0 lg:px-0 lg:py-0 lg:opacity-0 lg:pointer-events-none"
            : ""
        }`}
      >
        <div className="mb-2 hidden shrink-0 items-center justify-end lg:flex">
          {!railCollapsed ? (
            <button
              type="button"
              onClick={onToggleRail}
              className="min-h-[32px] rounded-md border border-pace-line bg-pace-panel px-3 py-1.5 font-dm text-[11px] font-medium text-pace-muted transition hover:bg-pace-line/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow"
            >
              Hide panel
            </button>
          ) : null}
        </div>
        <div
          className={`min-h-0 flex-1 overflow-y-auto px-[clamp(1rem,4vw,2.5rem)] py-3 lg:px-0 lg:py-0 ${sidebarFooter ? "pb-2" : ""}`}
        >
          {sidebar}
        </div>
        {sidebarFooter ? (
          <div className="shrink-0 border-t border-pace-line bg-pace-white px-[clamp(1rem,4vw,2.5rem)] pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-4px_12px_rgba(0,0,0,0.04)] lg:border-pace-line lg:px-0 lg:pb-0 lg:pt-3 lg:shadow-none">
            {sidebarFooter}
          </div>
        ) : null}
      </aside>

      <div
        className={`relative order-2 flex min-h-0 flex-1 border-t border-pace-line ${mapMobileMinH} lg:min-h-0 lg:border-t-0 lg:border-l lg:border-pace-line`}
      >
        {railCollapsed ? (
          <button
            type="button"
            onClick={onToggleRail}
            className="absolute left-3 top-3 z-[1000] hidden rounded-md border border-pace-line bg-pace-white/95 px-2.5 py-1.5 font-dm text-xs font-semibold text-pace-ink shadow-md backdrop-blur-sm lg:inline-flex"
          >
            Show panel
          </button>
        ) : null}
        {map}
      </div>
    </div>
  );
}
