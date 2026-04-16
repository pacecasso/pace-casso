import Link from "next/link";
import MarketingNav from "../../components/MarketingNav";

export default function CommunityPage() {
  return (
    <>
      <MarketingNav />
      <main className="min-h-screen bg-pace-warm px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
        <div className="mx-auto max-w-2xl">
          <p className="font-bebas text-xs tracking-[0.22em] text-pace-yellow">
            Join the movement
          </p>
          <h1 className="font-pace-heading mt-1 text-2xl uppercase tracking-wide text-pace-blue sm:text-3xl">
            Community
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-pace-muted">
            PaceCasso is for runners who turn streets into art. This hub is where
            we&apos;ll gather inspiration, spotlights, and ways to connect as the
            product grows.
          </p>

          <section className="mt-10 border-t border-pace-line pt-8">
            <h2 className="font-bebas text-lg tracking-[0.12em] text-pace-ink">
              Share your art
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-pace-muted">
              Export a GPX, run your line, then share the map—Strava, Instagram,
              your club chat. Tag what you create so others can find it; a
              dedicated showcase and handles are on the roadmap.
            </p>
          </section>

          <section className="mt-10 border-t border-pace-line pt-8">
            <h2 className="font-bebas text-lg tracking-[0.12em] text-pace-ink">
              Gallery &amp; inspiration
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-pace-muted">
              Browse the{" "}
              <Link
                href="/gallery"
                className="font-semibold text-pace-blue underline-offset-2 hover:underline"
              >
                route gallery
              </Link>{" "}
              for ideas—bold shapes and clean traces read best once snapped to
              real roads.
            </p>
          </section>

          <section className="mt-10 border-t border-pace-line pt-8">
            <h2 className="font-bebas text-lg tracking-[0.12em] text-pace-ink">
              What&apos;s next
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-pace-muted">
              Accounts, profiles, saved routes across devices, and community
              challenges aren&apos;t here yet—they may ship in a later release.
              For now, the create flow stays in your browser; check{" "}
              <Link
                href="/help"
                className="font-semibold text-pace-blue underline-offset-2 hover:underline"
              >
                Help
              </Link>{" "}
              for how drafts and export work today.
            </p>
          </section>

          <div className="mt-12 flex justify-center border-t border-pace-line pt-10">
            <Link href="/create" className="pace-btn-primary px-8">
              Start creating
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
