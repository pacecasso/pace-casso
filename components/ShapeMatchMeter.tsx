"use client";

type Props = {
  /** 0–100 when known; null shows pending state */
  percent: number | null;
  label: string;
  title?: string;
  /** Shown next to label when percent is null */
  pendingText?: string;
  /** Optional second row (e.g. tight point-to-line fit vs interpretation). */
  secondaryPercent?: number | null;
  secondaryLabel?: string;
  secondaryTitle?: string;
};

export default function ShapeMatchMeter({
  percent,
  label,
  title,
  pendingText = "—",
  secondaryPercent,
  secondaryLabel = "Tight fit",
  secondaryTitle,
}: Props) {
  const display = percent != null ? `${percent}%` : pendingText;
  const width = percent != null ? `${percent}%` : "0%";

  const showSecondary =
    secondaryPercent != null && secondaryPercent !== undefined;

  return (
    <div className="min-w-0 w-full">
      <div className="mb-1 flex items-center justify-between gap-2 font-bebas text-[10px] tracking-[0.12em] text-pace-muted">
        <span>{label}</span>
        <span className="tabular-nums text-pace-ink">{display}</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-pace-line"
        title={title}
      >
        <div
          className={`h-full rounded-full bg-gradient-to-r from-pace-yellow via-emerald-400 to-emerald-500 ${
            percent != null ? "transition-[width] duration-300" : ""
          }`}
          style={{ width }}
        />
      </div>
      {showSecondary ? (
        <div className="mt-2">
          <div className="mb-0.5 flex items-center justify-between gap-2 font-bebas text-[9px] tracking-[0.1em] text-pace-muted/90">
            <span>{secondaryLabel}</span>
            <span className="tabular-nums text-pace-muted">
              {secondaryPercent}%
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-pace-line/80"
            title={secondaryTitle}
          >
            <div
              className="h-full rounded-full bg-pace-blue/50 transition-[width] duration-300"
              style={{ width: `${secondaryPercent}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
