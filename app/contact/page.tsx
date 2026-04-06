import Link from "next/link";

export default function ContactPage() {
  return (
    <main className="min-h-screen bg-pace-warm px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
      <div className="mx-auto max-w-2xl">
        <p className="font-bebas text-xs tracking-[0.18em] text-pace-yellow">
          PaceCasso
        </p>
        <h1 className="font-pace-heading mt-1 text-2xl uppercase tracking-wide text-pace-blue sm:text-3xl">
          Contact
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-pace-muted">
          For product questions or partnerships:{" "}
          <a
            href="mailto:hello@pacecasso.com"
            className="font-semibold text-pace-blue underline-offset-2 hover:underline"
          >
            hello@pacecasso.com
          </a>
        </p>
        <p className="mt-12 text-center text-xs text-pace-muted">
          <Link
            href="/landing.html"
            className="font-bebas tracking-[0.14em] text-pace-yellow hover:text-pace-ink"
          >
            ← Back to site
          </Link>
        </p>
      </div>
    </main>
  );
}
