import Link from "next/link";
import MarketingNav from "../../components/MarketingNav";
import { CURATED_MANHATTAN_RUNS } from "../../lib/curatedManhattanRuns";

/**
 * Curated style references — shapes that tend to snap cleanly to city grids.
 * Each card shows an emoji icon matching the subject so the gallery reads at
 * a glance (same visual language as the starter shapes on source-choice).
 */
/**
 * Cities must match lib/cityPresets.ts, and every icon must trace to a
 * single connected blob in emojiToContour (multi-part glyphs fragment —
 * only the largest piece survives the trace).
 */
const CURATED_ROUTES = [
  {
    title: "Lightning Bolt",
    city: "Chicago",
    distanceKm: 11.3,
    icon: "⚡",
    accent: "#ffb800",
    blurb:
      "High-contrast corners and long diagonal legs — a natural fit for Chicago's dead-straight mile grid.",
  },
  {
    title: "Big Heart",
    city: "Manhattan",
    distanceKm: 12.5,
    icon: "❤️",
    accent: "#ef4444",
    blurb:
      "The classic. Domed lobes and a pointed tip read from any altitude — Manhattan's dense grid keeps the curves smooth.",
  },
  {
    title: "Teardrop",
    city: "Brooklyn",
    distanceKm: 9.2,
    icon: "💧",
    accent: "#1d6fd8",
    blurb:
      "Compact out-and-back personality — fits Brooklyn's tighter blocks and shorter long-run days.",
  },
  {
    title: "Crescent Moon",
    city: "San Francisco",
    distanceKm: 10.4,
    icon: "🌙",
    accent: "#8b5cf6",
    blurb:
      "One continuous curve with a dramatic inner sweep; the hills add elevation drama to a simple silhouette.",
  },
  {
    title: "Capital Star",
    city: "Washington DC",
    distanceKm: 14.6,
    icon: "⭐",
    accent: "#0d0d0d",
    blurb:
      "Five points, ten corners — DC's diagonal avenues were made for this. Stress-test the editor on the tips.",
  },
  {
    title: "Fish Run",
    city: "Manhattan",
    distanceKm: 8.8,
    icon: "🐟",
    accent: "#22c55e",
    blurb:
      "Body plus tail fin in one line — a friendly first project that survives street snapping almost anywhere.",
  },
] as const;

export default function GalleryPage() {
  return (
    <>
      <MarketingNav />
      <main className="min-h-screen bg-pace-warm px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
        <div className="mx-auto max-w-5xl">
          <h1 className="font-pace-heading text-3xl uppercase tracking-wide text-pace-blue sm:text-4xl">
            Gallery
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-pace-muted">
            Curated style references for GPS route art — bold shapes that tend
            to snap cleanly to real streets. Distances are illustrative; your
            exported route length comes from the map and the snap engine.
          </p>

          <p className="mt-2 max-w-2xl text-xs text-pace-muted">
            Click any card to send the shape straight into the create flow —
            pick a city and drop into placement without tracing a thing.
          </p>

          <h2 className="mt-10 font-pace-heading text-2xl uppercase tracking-wide text-pace-ink">
            NYC · run-ready routes
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-pace-muted">
            Real Manhattan routes drawn street by street on the actual grid —
            every block verified walkable against live walking directions.
            Download the GPX and run the picture today.
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CURATED_MANHATTAN_RUNS.map((run) => (
              <a
                key={run.id}
                href={`/api/curated-gpx/${run.id}`}
                download
                className="pace-card-editorial group flex flex-col overflow-hidden shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow focus-visible:ring-offset-2"
                title={`Download ${run.title} as GPX`}
              >
                <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-white">
                  <div
                    className="absolute inset-0 opacity-[0.2]"
                    style={{
                      backgroundImage:
                        "linear-gradient(var(--pace-line) 1px, transparent 1px), linear-gradient(90deg, var(--pace-line) 1px, transparent 1px)",
                      backgroundSize: "24px 24px",
                    }}
                    aria-hidden
                  />
                  <span
                    aria-hidden
                    className="relative select-none text-[5rem] leading-none drop-shadow-sm transition group-hover:scale-110 sm:text-[5.5rem]"
                  >
                    {run.icon}
                  </span>
                </div>
                <div className="border-t border-pace-line p-4">
                  <h3 className="font-bebas text-lg tracking-[0.08em] text-pace-ink">
                    {run.title}
                  </h3>
                  <p className="mt-0.5 font-bebas text-[11px] tracking-[0.14em] text-pace-yellow">
                    {run.area} · {run.distanceKm} km
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-pace-muted">
                    {run.blurb}
                  </p>
                  <p className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-pace-blue">
                    Download GPX →
                  </p>
                </div>
              </a>
            ))}
          </div>

          <h2 className="mt-12 font-pace-heading text-2xl uppercase tracking-wide text-pace-ink">
            Style references
          </h2>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CURATED_ROUTES.map((item) => (
              <Link
                key={item.title}
                href={`/create?shape=${encodeURIComponent(item.icon)}`}
                className="pace-card-editorial group flex flex-col overflow-hidden shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow focus-visible:ring-offset-2"
                title={`Design a ${item.title} route`}
              >
                <div
                  className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden"
                  style={{
                    background: `linear-gradient(135deg, ${item.accent}14, #fff 70%)`,
                  }}
                >
                  <div
                    className="absolute inset-0 opacity-[0.2]"
                    style={{
                      backgroundImage:
                        "linear-gradient(var(--pace-line) 1px, transparent 1px), linear-gradient(90deg, var(--pace-line) 1px, transparent 1px)",
                      backgroundSize: "24px 24px",
                    }}
                    aria-hidden
                  />
                  <span
                    aria-hidden
                    className="relative select-none text-[5rem] leading-none drop-shadow-sm transition group-hover:scale-110 sm:text-[5.5rem]"
                  >
                    {item.icon}
                  </span>
                </div>
                <div className="border-t border-pace-line p-4">
                  <h2 className="font-bebas text-lg tracking-[0.08em] text-pace-ink">
                    {item.title}
                  </h2>
                  <p className="mt-0.5 font-bebas text-[11px] tracking-[0.14em] text-pace-yellow">
                    {item.city} · {item.distanceKm} km
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-pace-muted">
                    {item.blurb}
                  </p>
                  <p className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-pace-blue">
                    Design this →
                  </p>
                </div>
              </Link>
            ))}
          </div>

          <div className="mt-12 flex flex-col items-center gap-4 border-t border-pace-line pt-10 text-center">
            <p className="max-w-md text-sm text-pace-muted">
              Ready to draw your design on real streets?
            </p>
            <Link href="/create" className="pace-btn-primary px-8">
              Start creating
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
