import MarketingNav from "../../components/MarketingNav";

export default function PrivacyPage() {
  return (
    <>
      <MarketingNav />
      <main className="min-h-screen bg-pace-warm px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
        <div className="mx-auto max-w-2xl">
          <h1 className="font-pace-heading text-2xl uppercase tracking-wide text-pace-blue sm:text-3xl">
            Privacy
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-pace-muted">
            A full privacy policy will be published before we collect personal data
            or run accounts at scale. For now, the app stores your create-flow
            draft in your browser only; we do not upload your traced photo to our
            servers.
          </p>
        </div>
      </main>
    </>
  );
}
