type Props = {
  label?: string;
  className?: string;
};

/** Shown while Leaflet / map chunks load via next/dynamic. */
export default function MapChunkFallback({
  label = "Loading map…",
  className = "",
}: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={`flex h-full min-h-[280px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-pace-line bg-gradient-to-br from-pace-panel via-pace-warm/40 to-pace-panel px-4 text-center font-dm text-sm text-pace-muted ${className}`}
    >
      <span className="relative flex h-10 w-10 items-center justify-center" aria-hidden>
        <span className="absolute h-8 w-8 animate-ping rounded-full bg-pace-yellow/25" />
        <span className="relative h-8 w-8 animate-pulse rounded-full bg-pace-line" />
      </span>
      <span className="font-medium text-pace-ink">{label}</span>
      <span className="max-w-[16rem] text-xs leading-relaxed text-pace-muted">
        Hang tight—this usually takes just a moment.
      </span>
    </div>
  );
}
