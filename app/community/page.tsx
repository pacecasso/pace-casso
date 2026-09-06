import Link from "next/link";
import MarketingNav from "../../components/MarketingNav";

/**
 * Community — honest today, not a "coming soon" wall. What exists now
 * (the verified gallery, sharing a finished run by email) and what is on
 * the roadmap, in plain words. No feature is implied that does not exist.
 */
export default function CommunityPage() {
  const mailto =
    "mailto:hello@pacecasso.com?subject=" +
    encodeURIComponent("My PaceCasso run") +
    "&body=" +
    encodeURIComponent(
      "City:\nWhat I drew:\nDistance:\n\nAttach your GPX or a screenshot of the finished run. Tell us if we may show it in the gallery with your first name.",
    );
  return (
    <>
      <MarketingNav />
      <main className="min-h-screen bg-pace-warm px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
        <div className="mx-auto max-w-3xl">
          <p className="font-bebas text-sm tracking-[0.2em] text-pace-yellow">Community</p>
          <h1 className="mt-1 font-pace-heading text-3xl uppercase tracking-wide text-pace-blue sm:text-4xl">
            Where miles make masterpieces
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-pace-muted">
            Every route in the gallery was drawn on real streets and then run.
            Share yours, borrow ideas, and help pick what we build next.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <section className="rounded-lg border border-pace-line bg-pace-white p-5">
              <h2 className="font-bebas text-xl tracking-[0.1em]">Share your run</h2>
              <p className="mt-2 text-sm leading-relaxed text-pace-muted">
                Ran a PaceCasso route? Send the GPX or a screenshot and we will
                add the best ones to the gallery, with your first name if you
                want it there.
              </p>
              <a href={mailto} className="pace-btn-primary mt-4 inline-block px-6">
                Send us your run
              </a>
            </section>

            <section className="rounded-lg border border-pace-line bg-pace-white p-5">
              <h2 className="font-bebas text-xl tracking-[0.1em]">Run a proven route</h2>
              <p className="mt-2 text-sm leading-relaxed text-pace-muted">
                The gallery holds routes that blind judges named correctly and
                that were checked block by block against walking directions.
                Download the GPX and run one today.
              </p>
              <Link href="/gallery" className="pace-btn-ghost mt-4 inline-block px-6">
                Open the gallery
              </Link>
            </section>
          </div>

          <section className="mt-8 rounded-lg border border-pace-line bg-pace-white p-5">
            <h2 className="font-bebas text-xl tracking-[0.1em]">What is here today, and what is next</h2>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-pace-muted">
              <li>
                <span className="font-semibold text-pace-ink">Today:</span> upload or draw a shape,
                get a route on Manhattan streets, tune it, export GPX, GeoJSON or turn cues. Your
                draft stays in this browser until you start over.
              </li>
              <li>
                <span className="font-semibold text-pace-ink">Next:</span> more cities with the
                automatic first draft, saved routes and share links, and a Strava-style route card
                you can post.
              </li>
              <li>
                <span className="font-semibold text-pace-ink">Have a request?</span> Email{" "}
                <a href="mailto:hello@pacecasso.com" className="text-pace-blue underline underline-offset-2">
                  hello@pacecasso.com
                </a>
                . Real runners decide the order.
              </li>
            </ul>
          </section>

          <div className="mt-10">
            <Link href="/create" className="pace-btn-primary px-8">
              Start creating
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
