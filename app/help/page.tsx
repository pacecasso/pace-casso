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
            Common questions for the{" "}
            <Link
              href="/create"
              className="font-semibold text-pace-blue underline-offset-2 hover:underline"
            >
              create flow
            </Link>
            . Want a step-by-step walkthrough?{" "}
            <Link
              href="/how"
              className="font-semibold text-pace-blue underline-offset-2 hover:underline"
            >
              How It Works
            </Link>
            .
          </p>

          <Section title="Connecting disconnected shapes (R, A, B, P, etc.)">
            <p>
              A walking route is a single continuous path — so the shape you
              trace has to be one connected line. Some letters have inner holes
              (the eye of an R, the loops of a B, the counter of an A) — the
              system automatically <strong className="text-pace-ink">bridges the inner hole
              to the outer boundary</strong> with a tiny connector, so you
              don&apos;t have to.
            </p>
            <p className="mt-3">
              If your image has <strong className="text-pace-ink">two entirely
              separate pieces</strong> (e.g., two side-by-side letters, or a
              shape that broke into fragments during line-art extraction), only
              the largest piece will survive. To include both, use the{" "}
              <strong className="text-pace-ink">draw tool</strong> in Step 1 to
              sketch a thin connector line between the two pieces before you
              click Next — the pipeline then sees one connected shape.
            </p>
          </Section>

          <Section title="Auto-find placement vs. Refine">
            <p>
              On the <em>Place on map</em> step you have two buttons:
            </p>
            <ul className="mt-2 ml-4 list-disc space-y-1">
              <li>
                <strong className="text-pace-ink">Auto-find placement</strong> —
                Claude searches the whole city (25 positions × 5–12 rotations ×
                5–7 scales), snaps each candidate to streets, renders a small
                map of each, and ranks the best 5 using vision. Ignores wherever
                you have the shape currently.
              </li>
              <li>
                <strong className="text-pace-ink">Refine around my placement</strong> —
                searches tightly near where you&apos;ve dragged the shape (±2
                km), at similar size (±30%) and rotation (±20°). Use this once
                you&apos;ve manually put the shape roughly where you want it.
              </li>
            </ul>
            <p className="mt-3">
              Both take ~30–60 seconds because Mapbox snaps 20 candidates and
              Claude Opus analyzes them. Claude&apos;s picks appear as 5
              thumbnails in the sidebar — click any to try it.
            </p>
          </Section>

          <Section title="Saved draft (browser only)">
            <p>
              Your wizard progress is saved in this browser under the key{" "}
              <code className="rounded bg-pace-panel px-1 py-0.5 text-xs text-pace-ink ring-1 ring-pace-line">
                pacecasso-create-draft-v1
              </code>{" "}
              in{" "}
              <code className="rounded bg-pace-panel px-1 text-xs ring-1 ring-pace-line">
                localStorage
              </code>
              . Refreshing typically restores where you left off, including your
              uploaded image (when small enough to fit localStorage). Private or
              incognito windows won&apos;t persist the draft. Click{" "}
              <strong className="text-pace-ink">START OVER</strong> in the
              header to clear it. Your image is never uploaded to our servers.
            </p>
          </Section>

          <Section title="Snapping errors &amp; rate limits">
            <p>
              Snapping uses the Mapbox Directions API. If you see errors or
              empty routes, hit <strong className="text-pace-ink">Retry</strong>,
              check your network, or wait a minute if you&apos;ve been clicking
              Auto-find rapidly (Mapbox rate-limits free-tier tokens at 300
              requests/min; each auto-find uses ~20 of those).
            </p>
            <p className="mt-3">
              A missing or invalid{" "}
              <code className="rounded bg-pace-panel px-1 text-xs ring-1 ring-pace-line">
                NEXT_PUBLIC_MAPBOX_TOKEN
              </code>{" "}
              in production will block all snapping. If you&apos;re running
              locally, check{" "}
              <code className="rounded bg-pace-panel px-1 text-xs ring-1 ring-pace-line">
                .env.local
              </code>
              .
            </p>
          </Section>

          <Section title="Claude vision / auto-find not running">
            <p>
              Auto-find uses Claude to classify your shape and rank candidates.
              If{" "}
              <code className="rounded bg-pace-panel px-1 text-xs ring-1 ring-pace-line">
                ANTHROPIC_API_KEY
              </code>{" "}
              isn&apos;t set on the server, auto-find silently falls back to
              showing 5 diverse snap candidates ordered by survival — the
              sidebar header will say &quot;Candidates&quot; instead of
              &quot;Claude&apos;s top picks.&quot; The results will be less
              tuned to your shape.
            </p>
          </Section>

          <Section title="GPX &amp; export">
            <p>
              The final step offers three downloads:
            </p>
            <ul className="mt-2 ml-4 list-disc space-y-1">
              <li>
                <strong className="text-pace-ink">GPX</strong> — the universal
                format. Import via your watch brand&apos;s app (often under
                &quot;Courses&quot; or &quot;Routes&quot;). Garmin, Coros,
                Suunto, Apple Watch, Polar all accept GPX.
              </li>
              <li>
                <strong className="text-pace-ink">GeoJSON</strong> — for custom
                maps, sharing, or importing into mapping tools.
              </li>
              <li>
                <strong className="text-pace-ink">Plain-text cues</strong> —
                turn-by-turn directions you can read on your phone while running
                if your watch doesn&apos;t show them.
              </li>
            </ul>
            <p className="mt-3">
              Turn-by-turn may render differently on different watches — some
              show them as on-course waypoints, others only as a list.
            </p>
          </Section>

          <Section title="Cities &amp; coverage">
            <p>
              Available today: {cityLabels.join(", ")}. Each preset defines a
              map bounding box and the dominant street-grid bearings (Manhattan
              runs ~29° off true north — that&apos;s why letters often look
              best slightly tilted). More cities coming.
            </p>
          </Section>

          <Section title="Why do my routes look 'jagged'?">
            <p>
              Because they are. Walking routes follow real streets, and real
              streets are a grid — so any diagonal or curve in your original
              shape becomes a staircase of blocks. That&apos;s the etch-a-sketch
              aesthetic. If your shape looks unrecognizable, try:
            </p>
            <ul className="mt-2 ml-4 list-disc space-y-1">
              <li>Scaling up (bigger routes = less zigzag relative to strokes).</li>
              <li>
                Rotating to align with the street grid (29° on Manhattan).
              </li>
              <li>
                Clicking <em>Refine around my placement</em> after nudging it to
                a neighborhood with a cleaner grid.
              </li>
            </ul>
          </Section>

          <Section title="Accounts, sync, social">
            <p>
              Coming in a later release. Today everything is browser-local — no
              accounts, no cloud sync, no sharing built in. If you clear the
              browser draft, you lose the route.
            </p>
          </Section>
        </div>
      </main>
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10 border-t border-pace-line pt-8">
      <h2 className="font-bebas text-lg tracking-[0.12em] text-pace-ink">
        {title}
      </h2>
      <div className="mt-2 text-sm leading-relaxed text-pace-muted">
        {children}
      </div>
    </section>
  );
}
