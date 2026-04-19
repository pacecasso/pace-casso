import Link from "next/link";
import MarketingNav from "../../components/MarketingNav";

/**
 * Curated style references — shapes that tend to snap cleanly to city grids.
 * Each card shows an emoji icon matching the subject so the gallery reads at
 * a glance (same visual language as the starter shapes on source-choice).
 */
const CURATED_ROUTES = [
  {
    title: "Harbor Star",
    city: "San Francisco",
    distanceKm: 18.4,
    icon: "⭐",
    accent: "#ffb800",
    blurb:
      "High-contrast corners and long legs — ideal for testing how snapping hugs waterfront grids and steep blocks.",
  },
  {
    title: "Dragon Loop",
    city: "Seattle",
    distanceKm: 22.1,
    icon: "🐉",
    accent: "#1d6fd8",
    blurb:
      "One continuous curve with gentle bends; a great template for loops that need smooth direction changes.",
  },
  {
    title: "Teardrop",
    city: "Austin",
    distanceKm: 9.2,
    icon: "💧",
    accent: "#ef4444",
    blurb:
      "Compact out-and-back personality — fits smaller grids and shorter long-run days.",
  },
  {
    title: "Double Wave",
    city: "Miami",
    distanceKm: 14.0,
    icon: "🌊",
    accent: "#22c55e",
    blurb:
      "Parallel rhythms read well from above; useful when you want symmetry without a perfect mirror.",
  },
  {
    title: "Burst",
    city: "Chicago",
    distanceKm: 11.3,
    icon: "✨",
    accent: "#8b5cf6",
    blurb:
      "A tighter starburst for dense street meshes — watch how snapping prioritises walkable corridors.",
  },
  {
    title: "Crown circuit",
    city: "New York City",
    distanceKm: 16.8,
    icon: "👑",
    accent: "#0d0d0d",
    blurb:
      "Complex perimeter with many turns — stress-test the editor after snap, then tune waypoints by hand.",
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

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CURATED_ROUTES.map((item) => (
              <article
                key={item.title}
                className="pace-card-editorial group flex flex-col overflow-hidden shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
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
                </div>
              </article>
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
