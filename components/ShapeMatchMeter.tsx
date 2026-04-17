"use client";

type Props = {
  /** 0–100 when known; null shows pending state */
  percent: number | null;
  label: string;
  title?: string;
  /** Shown next to label when percent is null */
  pendingText?: string;
};

export default function ShapeMatchMeter({
  percent,
  label,
  title,
  pendingText = "—",
}: Props) {
  const display = percent != null ? `${percent}%` : pendingText;
  const width = percent != null ? `${percent}%` : "0%";

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
    </div>
  );
}
