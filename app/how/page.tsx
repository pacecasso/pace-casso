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
              style={{ WebkitTextStroke: "2px var(--pace-ink)" }}
            >
              Repeat.
            </span>
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-pace-muted">
            PaceCasso turns a drawing into a runnable route. Pick a shape (photo
            or freehand), place it on a city map, snap it to real walkable
            streets, fine-tune the path, export GPX. Here&apos;s what happens at
            each step.
          </p>

          <ol className="mt-10 flex flex-col gap-5">
            <StepCard
              num="01"
              title="Pick your city"
              body="Choose where your route will live. The system uses the city's street grid layout to align letters and shapes cleanly. Manhattan is live today; more cities are coming."
            />
            <StepCard
              num="02"
              title="Pick a source — photo or freehand"
              body="Trace an image (a letter, animal, logo — whatever you want to 'run'), or freehand-draw directly on the map. Both paths lead to the same place."
            />
            <StepCard
              num="03a"
              title="Image path — trace a silhouette"
              body="Upload a photo or image. We auto-threshold it into black-and-white line art. Use the draw/erase tools to clean up stray marks or to draw a bridge between disconnected pieces. When a single continuous outline is showing, click Next."
              tip="Tip: shapes with an inner hole (like the eye of an R) are auto-connected to the outer boundary with a small bridge. But two totally separate shapes (e.g., two letters side by side) need a hand-drawn connector — use the draw tool for that."
            />
            <StepCard
              num="03b"
              title="Freehand path — sketch on the map"
              body="Toggle to draw mode and sketch the shape directly on the city map. Pan and zoom for precision. Your strokes get flattened into a single path automatically."
            />
            <StepCard
              num="04"
              title="Place your shape on the map"
              body={
                <>
                  Size, rotate, and drag the shape to where you want it. Two
                  auto-tools here:
                  <ul className="mt-2 ml-4 list-disc space-y-1">
                    <li>
                      <strong className="text-pace-ink">Auto-find placement</strong>
                      — Claude searches the whole city for the best 5 placements
                      and ranks them by how recognizable your shape will be once
                      snapped to streets.
                    </li>
                    <li>
                      <strong className="text-pace-ink">Refine around my placement</strong>
                      — after you&apos;ve dragged the shape roughly where you
                      want it, Refine searches tightly nearby (size ±30%,
                      rotation ±20°, position ±2 km) to polish your choice.
                    </li>
                  </ul>
                </>
              }
            />
            <StepCard
              num="05"
              title="Snap to streets"
              body="Mapbox routes your shape onto real walkable streets, turning your smooth outline into an etch-a-sketch version that follows avenues and blocks. You'll see a 'gestalt-style' match score — how recognizable the result still is after snapping."
            />
            <StepCard
              num="06"
              title="Fine-tune the route"
              body="Drag individual waypoints to fix ugly spots. Toggle 'Full snap' to see the original auto-snapped route under your edits for comparison. Add or delete waypoints to take a different street where you want."
            />
            <StepCard
              num="07"
              title="Export for your watch"
              body="Download GPX (for Garmin, Coros, Apple Watch, etc.), GeoJSON (for custom maps), or a plain-text cue list with turn-by-turn directions. Run it, share the art."
            />
          </ol>

          <div className="mt-12 flex flex-col items-center gap-4 border-t border-pace-line pt-10 sm:flex-row sm:justify-center">
            <Link href="/create" className="pace-btn-primary px-8">
              Start creating
            </Link>
            <Link
              href="/help"
              className="font-bebas text-sm tracking-[0.14em] text-pace-blue underline-offset-4 hover:underline"
            >
              Help &amp; troubleshooting
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}

function StepCard({
  num,
  title,
  body,
  tip,
}: {
  num: string;
  title: string;
  body: React.ReactNode;
  tip?: string;
}) {
  return (
    <li className="relative overflow-hidden border border-pace-line border-t-[3px] border-t-pace-yellow bg-pace-warm p-5 sm:p-6">
      <span
        className="pointer-events-none absolute right-4 top-2 font-pace-heading text-5xl leading-none text-pace-yellow/15"
        aria-hidden
      >
        {num}
      </span>
      <div className="relative flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-pace-yellow bg-pace-yellow/15 font-bebas text-xs text-pace-ink">
          {num}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-bebas text-base tracking-[0.1em] text-pace-ink">
            {title}
          </h2>
          <div className="mt-1 text-sm leading-relaxed text-pace-muted">
            {body}
          </div>
          {tip && (
            <p className="mt-3 rounded border-l-2 border-pace-blue bg-pace-blue/5 px-3 py-2 text-xs leading-relaxed text-pace-ink">
              {tip}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
