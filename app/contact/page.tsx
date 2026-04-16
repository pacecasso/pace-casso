import MarketingNav from "../../components/MarketingNav";

export default function ContactPage() {
  return (
    <>
      <MarketingNav />
      <main className="min-h-screen bg-pace-warm px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
        <div className="mx-auto max-w-2xl">
          <h1 className="font-pace-heading text-2xl uppercase tracking-wide text-pace-blue sm:text-3xl">
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
        </div>
      </main>
    </>
  );
}
