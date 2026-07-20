import Link from "next/link";
import MarketingNav from "../../components/MarketingNav";

export default function CommunityPage() {
  return (
    <>
      <MarketingNav />
      <main className="min-h-screen bg-pace-warm px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
        <div className="mx-auto flex min-h-[50vh] max-w-2xl flex-col items-center justify-center text-center">
          <h1 className="font-pace-heading text-2xl uppercase tracking-wide text-pace-blue sm:text-3xl">
            Community
          </h1>
          <p className="mt-4 font-bebas text-xl tracking-[0.16em] text-pace-yellow">
            Coming soon
          </p>
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
