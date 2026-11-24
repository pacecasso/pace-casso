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
            There are two ways to make a route.{" "}
            <Link href="/draw" className="font-semibold text-pace-blue underline-offset-2 hover:underline">
              Draw my logo
            </Link>{" "}
            turns a picture you upload into a route for you (New York City only for now).{" "}
            <Link href="/create" className="font-semibold text-pace-blue underline-offset-2 hover:underline">
              Draw it yourself
            </Link>{" "}
            lets you sketch or place a shape on the map in {cityLabels.length} cities. Want a walkthrough?{" "}
            <Link href="/how" className="font-semibold text-pace-blue underline-offset-2 hover:underline">
              How It Works
            </Link>
            .
          </p>

          <h2 className="mt-10 font-pace-heading text-xl uppercase tracking-wide text-pace-blue">Draw my logo</h2>

          <Section title="How it works">
            <ol className="ml-4 list-decimal space-y-1">
              <li>Choose a picture: a logo, a drawing or a photo (PNG, JPG or WebP).</li>
              <li>
                In under a minute we show a simple line drawing of it. This is what goes on the streets, so check it:
                erase lines you do not want, add or fix one with the pen, and correct the name if we read it wrong.
              </li>
              <li>
                Press <strong className="text-pace-ink">Draw it</strong>. A minute or two later you get up to five
                routes at different sizes, each one continuous run on real streets.
              </li>
              <li>Download the GPX of the one you like, or a share picture of your logo beside its route.</li>
            </ol>
          </Section>

          <Section title="Why is the route with my name so long?">
            <p>
              A letter has to be several blocks tall before anyone can read it on a map, so a whole name usually needs
              a run of 40 km or more. For a run under 25 km we offer shorter versions: your picture on its own, your
              picture with your initials, or your initials in large letters. The ★ marks the best match you can run in
              one go. A shorter name, or a drawing with fewer lines, makes a shorter run.
            </p>
          </Section>

          <Section title="Some of my words are missing">
            <p>
              Words are drawn as one row of big block capitals, at most 12 letters. Small print, taglines and second
              lines are left out because they cannot be read at street size; the touch-up step tells you which words
              were left out. To choose a different word, type it in the name box there and press{" "}
              <strong className="text-pace-ink">Redraw with this name</strong>.
            </p>
          </Section>

          <Section title="Why is my route in Brooklyn or Queens?">
            <p>
              We search Manhattan, Brooklyn and Queens for the streets that fit your drawing best, and the best fit is
              often outside Manhattan. Each route has a <strong className="text-pace-ink">See where it starts</strong>{" "}
              link so you can check before you go.
            </p>
          </Section>

          <Section title="What pictures work best?">
            <p>
              Bold, simple shapes with a clear outline: one strong mark, a short name. Fine detail, thin lines, shading
              and long names do not survive the trip onto a street grid. Photos work when there is one clear subject.
            </p>
          </Section>

          <Section title="Getting the route onto your watch">
            <p>
              The <strong className="text-pace-ink">GPX</strong> button saves a file to your Downloads folder. In
              Strava, import it on the website under My Routes, Create New Route. In Garmin Connect, use Training,
              Courses, Import. Coros, Suunto, Polar and Apple Watch apps accept GPX as well. If nothing is saved, your
              browser may be blocking a second download from the page: look for a prompt in the address bar and allow
              it.
            </p>
          </Section>

          <Section title="What happens to my picture?">
            <p>
              Your picture is sent to our drawing computer to make the route. We keep a copy there so we can improve
              the drawings; it is not published or shared. The results page has its own link, which you can bookmark
              or share. There are no accounts.
            </p>
          </Section>

          <h2 className="mt-12 font-pace-heading text-xl uppercase tracking-wide text-pace-blue">Draw it yourself</h2>

          <Section title="Cities">
            <p>Available today: {cityLabels.join(", ")}. More cities are coming.</p>
          </Section>

          <Section title="Shapes in more than one piece">
            <p>
              A route is one continuous line, so your shape has to be one connected line too. Holes inside letters (the
              eye of an R, the loops of a B) are joined up for you. If your picture has two separate pieces, only the
              largest is kept: draw a thin line between them before you continue and both stay.
            </p>
          </Section>

          <Section title="Find a spot for me, or refine mine">
            <p>
              When you place your shape on the map, <strong className="text-pace-ink">Auto-find placement</strong>{" "}
              searches the whole city and shows the five best spots.{" "}
              <strong className="text-pace-ink">Refine around my placement</strong> searches only near where you have
              put the shape, at about the same size and angle. Either takes up to a minute.
            </p>
          </Section>

          <Section title="Why do my routes look jagged?">
            <p>
              Routes follow real streets, and streets are a grid, so a diagonal or a curve becomes a staircase of
              blocks. A bigger shape shows less of it, and so does turning the shape to line up with the streets
              (Manhattan&apos;s grid runs about 29° off north).
            </p>
          </Section>

          <Section title="If a route will not appear">
            <p>
              Press <strong className="text-pace-ink">Retry</strong>, check your connection, or wait a minute if you
              have been searching many times in a row.
            </p>
          </Section>

          <Section title="Your saved draft">
            <p>
              Your progress is saved in this browser only, so a refresh brings you back to where you were. A private
              window does not keep it. <strong className="text-pace-ink">Start over</strong> in the header clears it.
            </p>
          </Section>

          <Section title="Downloads">
            <p>
              The last step offers a GPX file for your watch, a GeoJSON file for mapping tools, and plain-text turn
              directions you can read on your phone.
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
