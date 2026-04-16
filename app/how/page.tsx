import Link from "next/link";
import MarketingNav from "../../components/MarketingNav";

export default function HowPage() {
  return (
    <>
      <MarketingNav />
      <main className="min-h-screen bg-pace-white px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-3">
            <span className="h-0.5 w-9 bg-pace-yellow" aria-hidden />
            <p className="font-bebas text-sm tracking-[0.22em] text-pace-yellow">
              Process
            </p>
          </div>
          <h1 className="font-pace-heading mt-2 text-3xl uppercase leading-[1.05] tracking-tight text-pace-ink sm:text-4xl md:text-5xl">
            Design. <span className="text-pace-yellow">Run.</span>{" "}
            <span
              className="text-transparent"
              style={{
                WebkitTextStroke: "2px var(--pace-ink)",
              }}
            >
              Repeat.
            </span>
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-pace-muted">
            PaceCasso turns your sketch into a runnable route: pick a city,
            trace or draw a shape, snap it to walkable streets, tune the line,
            then export GPX or GeoJSON for your watch and favorite tools.
          </p>

          <div className="mt-12 grid gap-6 sm:grid-cols-1 md:grid-cols-3 md:gap-5">
            <article className="relative overflow-hidden border border-pace-line border-t-[3px] border-t-pace-yellow bg-pace-warm p-6 pt-8">
              <span
                className="pointer-events-none absolute right-3 top-1 font-pace-heading text-6xl leading-none text-pace-yellow/15"
                aria-hidden
              >
                01
              </span>
              <div className="mb-4 flex h-[52px] w-[52px] items-center justify-center border-2 border-pace-yellow bg-pace-yellow/15 font-bebas text-lg text-pace-ink">
                01
              </div>
              <h2 className="font-bebas text-lg tracking-[0.1em] text-pace-ink">
                Design your route
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-pace-muted">
                Sketch on the map or trace a shape. We snap your line to real
                streets so every mile is runnable. Export it to your watch and
                get running.
              </p>
            </article>
            <article className="relative overflow-hidden border border-pace-line border-t-[3px] border-t-pace-yellow bg-pace-warm p-6 pt-8">
              <span
                className="pointer-events-none absolute right-3 top-1 font-pace-heading text-6xl leading-none text-pace-yellow/15"
                aria-hidden
              >
                02
              </span>
              <div className="mb-4 flex h-[52px] w-[52px] items-center justify-center border-2 border-pace-yellow bg-pace-yellow/15 font-bebas text-lg text-pace-ink">
                02
              </div>
              <h2 className="font-bebas text-lg tracking-[0.1em] text-pace-ink">
                Go run it
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-pace-muted">
                Your watch records the art, pace, and distance. Then a new
                masterpiece has been run.
              </p>
            </article>
            <article className="relative overflow-hidden border border-pace-line border-t-[3px] border-t-pace-yellow bg-pace-warm p-6 pt-8 md:col-span-1">
              <span
                className="pointer-events-none absolute right-3 top-1 font-pace-heading text-6xl leading-none text-pace-yellow/15"
                aria-hidden
              >
                03
              </span>
              <div className="mb-4 flex h-[52px] w-[52px] items-center justify-center border-2 border-pace-yellow bg-pace-yellow/15 font-bebas text-lg text-pace-ink">
                03
              </div>
              <h2 className="font-bebas text-lg tracking-[0.1em] text-pace-ink">
                Share your art
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-pace-muted">
                Post the map, inspire the crew. Your run is the paintbrush; the
                city is the canvas. Design. Run. Repeat.
              </p>
            </article>
          </div>

          <div className="mt-12 flex flex-col items-center gap-4 border-t border-pace-line pt-10 sm:flex-row sm:justify-center">
            <Link href="/create" className="pace-btn-primary px-8">
              Start creating
            </Link>
            <Link
              href="/help"
              className="font-bebas text-sm tracking-[0.14em] text-pace-blue underline-offset-4 hover:underline"
            >
              Help &amp; tips
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
