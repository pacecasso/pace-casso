import Link from "next/link";
import MarketingNav from "../../components/MarketingNav";
import { CITY_PRESETS } from "../../lib/cityPresets";

export default function HelpPage() {
  const cityLabels = Object.values(CITY_PRESETS).map((p) => p.label);

  return (
    <>
      <MarketingNav />
      <main className="min-h-screen bg-pace-warm px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
        <div className="mx-auto max-w-2xl">
          <h1 className="font-pace-heading text-2xl uppercase tracking-wide text-pace-blue sm:text-3xl">
            Help
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-pace-muted">
            Quick answers for the{" "}
            <Link
              href="/create"
              className="font-semibold text-pace-blue underline-offset-2 hover:underline"
            >
              create flow
            </Link>
            . Nothing here is legal advice; see your device maker&apos;s docs for
            watch import steps.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-pace-muted">
            Accounts, cloud sync, and saving routes across devices are not
            available yet—they may come in a later release.
          </p>

          <section className="mt-10 border-t border-pace-line pt-8">
            <h2 className="font-bebas text-lg tracking-[0.12em] text-pace-ink">
              Saved draft (browser)
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-pace-muted">
              Your wizard progress is stored in this browser only, under the key{" "}
              <code className="rounded bg-pace-panel px-1 py-0.5 text-xs text-pace-ink ring-1 ring-pace-line">
                pacecasso-create-draft-v1
              </code>{" "}
              in{" "}
              <code className="rounded bg-pace-panel px-1 text-xs ring-1 ring-pace-line">
                localStorage
              </code>
              . Refreshing usually restores where you left off. Use{" "}
              <strong className="text-pace-ink">START OVER</strong> in the header
              to clear it. Private/incognito windows or clearing site data remove
              the draft. We do not upload your traced photo to our servers.
            </p>
          </section>

          <section className="mt-10 border-t border-pace-line pt-8">
            <h2 className="font-bebas text-lg tracking-[0.12em] text-pace-ink">
              Mapbox &amp; snapping errors
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-pace-muted">
              Snapping uses the Mapbox Directions API. If you see errors or empty
              routes, try <strong className="text-pace-ink">Retry</strong>, check
              your network, or wait a moment if rate limits apply. A missing or
              invalid token in production will block directions—set{" "}
              <code className="rounded bg-pace-panel px-1 text-xs ring-1 ring-pace-line">
                NEXT_PUBLIC_MAPBOX_TOKEN
              </code>{" "}
              on your deployment when you move off the dev fallback.
            </p>
          </section>

          <section className="mt-10 border-t border-pace-line pt-8">
            <h2 className="font-bebas text-lg tracking-[0.12em] text-pace-ink">
              GPX &amp; export
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-pace-muted">
              On the final step you can download GPX, GeoJSON, and a plain-text
              cue list. Import the GPX in your watch brand&apos;s app (often
              under course or route import). Turn-by-turn may appear as waypoints
              in some apps only—the on-screen tips explain more.
            </p>
          </section>

          <section className="mt-10 border-t border-pace-line pt-8">
            <h2 className="font-bebas text-lg tracking-[0.12em] text-pace-ink">
              Cities &amp; coverage
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-pace-muted">
              Presets today: {cityLabels.join(", ")}. Each preset sets the default
              map center and a rough bounds note on the city step. More cities can
              be added in the product over time.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
