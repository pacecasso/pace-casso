import Link from "next/link";
import MarketingNav from "../../components/MarketingNav";
import CuratedRunCard from "../../components/CuratedRunCard";
import { CURATED_MANHATTAN_RUNS } from "../../lib/curatedManhattanRuns";
import { VERIFIED_ROUTE_BANK_GALLERY_RUNS } from "../../lib/verifiedRouteBankGallery";

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
            Real routes in New York and Washington, DC — drawn street by
            street, checked block by block against live walking directions,
            and blind-verified: independent judges named each shape without
            being told what it was. Tap one to see it on the map and download
            the GPX.
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...CURATED_MANHATTAN_RUNS, ...VERIFIED_ROUTE_BANK_GALLERY_RUNS].map(
              (run) => (
                <CuratedRunCard key={run.id} run={run} />
              ),
            )}
          </div>

          <p className="mt-3 text-[10px] tracking-wide text-pace-muted">
            Map imagery © OpenStreetMap contributors · © CARTO
          </p>

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
