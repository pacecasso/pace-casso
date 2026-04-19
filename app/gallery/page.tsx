import Link from "next/link";
import MarketingNav from "../../components/MarketingNav";

/** Curated style references (illustrative distances)—same shapes as the marketing landing gallery. */
const CURATED_ROUTES = [
  {
    title: "Harbor Star",
    city: "San Francisco",
    distanceKm: 18.4,
    stroke: "#ffb800",
    strokeWidth: 2.2,
    path: "M100 20 L130 85 L200 90 L145 135 L160 200 L100 165 L40 200 L55 135 L0 90 L70 85 Z",
    viewBox: "0 0 200 200" as const,
    blurb:
      "High-contrast corners and long legs—ideal for testing how snapping hugs waterfront grids and steep blocks.",
  },
  {
    title: "Dragon Loop",
    city: "Seattle",
    distanceKm: 22.1,
    stroke: "#1d6fd8",
    strokeWidth: 2,
    path: "M20 100 C40 40 80 20 120 40 C160 60 180 100 160 140 C140 180 80 190 40 160 C20 140 15 120 20 100",
    viewBox: "0 0 200 200" as const,
    blurb:
      "One continuous curve with gentle bends; great template for loops that need smooth direction changes.",
  },
  {
    title: "Teardrop",
    city: "Austin",
    distanceKm: 9.2,
    stroke: "#ef4444",
    strokeWidth: 2,
    path: "M100 30 Q140 80 100 130 Q60 80 100 30",
    viewBox: "0 0 200 200" as const,
    blurb:
      "Compact out-and-back personality—fits smaller grids and shorter long-run days.",
  },
  {
    title: "Double Wave",
    city: "Miami",
    distanceKm: 14.0,
    stroke: "#22c55e",
    strokeWidth: 2,
    path: "M10 100 Q50 60 90 100 T170 100 M10 120 Q50 160 90 120 T170 120",
    viewBox: "0 0 200 200" as const,
    blurb:
      "Parallel rhythms read well from above; useful when you want symmetry without a perfect mirror.",
  },
  {
    title: "Burst",
    city: "Chicago",
    distanceKm: 11.3,
    stroke: "#8b5cf6",
    strokeWidth: 2,
    path: "M100 30 L115 75 L160 75 L125 105 L140 150 L100 125 L60 150 L75 105 L40 75 L85 75 Z",
    viewBox: "0 0 200 200" as const,
    blurb:
      "A tighter starburst for dense street meshes—watch how snapping prioritizes walkable corridors.",
  },
  {
    title: "Crown circuit",
    city: "New York City",
    distanceKm: 16.8,
    stroke: "#0d0d0d",
    strokeWidth: 2.2,
    path: "M200.00,30.00 L232.54,132.43 L332.91,94.01 L273.12,183.31 L365.74,237.83 L258.64,246.76 L273.76,353.16 L200.00,275.00 L126.24,353.16 L141.36,246.76 L34.26,237.83 L126.88,183.31 L67.09,94.01 L167.46,132.43 Z",
    viewBox: "0 0 400 400" as const,
    pathTransform: "translate(200 200) scale(0.52) translate(-200 -200)",
    blurb:
      "Complex perimeter with many turns—stress-test the editor after snap, then tune waypoints by hand.",
  },
] as const;

function RoutePreview({
  viewBox,
  pathTransform,
  stroke,
  strokeWidth,
  path,
}: {
  viewBox: string;
  pathTransform?: string;
  stroke: string;
  strokeWidth: number;
  path: string;
}) {
  const pathEl = (
    <path
      d={path}
      stroke={stroke}
      strokeWidth={strokeWidth}
      fill="none"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  );

  return (
    <div className="relative aspect-[4/3] w-full bg-pace-panel">
      <div
        className="absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(var(--pace-line) 1px, transparent 1px), linear-gradient(90deg, var(--pace-line) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
        aria-hidden
      />
      <svg
        viewBox={viewBox}
        fill="none"
        className="absolute inset-[12%] h-[76%] w-[76%]"
        aria-hidden
      >
        {pathTransform ? (
          <g transform={pathTransform}>{pathEl}</g>
        ) : (
          pathEl
        )}
      </svg>
    </div>
  );
}

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
            Curated style references for GPS route art—bold shapes that tend to
            snap cleanly to real streets. Distances are illustrative; your
            exported route length comes from the map and the snap engine.
          </p>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CURATED_ROUTES.map((item) => (
              <article
                key={item.title}
                className="pace-card-editorial flex flex-col overflow-hidden shadow-sm transition hover:shadow-md"
              >
                <RoutePreview
                  viewBox={item.viewBox}
                  pathTransform={"pathTransform" in item ? item.pathTransform : undefined}
                  stroke={item.stroke}
                  strokeWidth={item.strokeWidth}
                  path={item.path}
                />
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
