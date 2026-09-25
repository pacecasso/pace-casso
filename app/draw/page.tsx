import { Suspense } from "react";
import MarketingNav from "../../components/MarketingNav";
import DrawFlow from "../../components/DrawFlow";

export default function DrawPage() {
  return (
    <>
      <MarketingNav />
      <main className="min-h-screen bg-pace-warm px-[clamp(1rem,4vw,2.5rem)] py-10 font-dm text-pace-ink">
        <div className="mx-auto max-w-5xl">
          <Suspense fallback={null}>
            <DrawFlow />
          </Suspense>
        </div>
      </main>
    </>
  );
}
