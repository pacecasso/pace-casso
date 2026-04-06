"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-pace-warm px-4 text-center font-dm">
      <div className="max-w-md space-y-2">
        <h1 className="font-bebas text-2xl tracking-wide text-pace-ink">
          Something went wrong
        </h1>
        <p className="text-sm leading-relaxed text-pace-muted">
          An unexpected error occurred. You can try again or return home.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-lg border border-pace-line bg-pace-white px-5 py-2.5 text-sm font-semibold text-pace-ink shadow-sm transition hover:border-pace-yellow"
        >
          Try again
        </button>
        <Link
          href="/landing.html"
          className="rounded-lg bg-pace-yellow px-5 py-2.5 text-sm font-semibold text-pace-ink transition hover:opacity-90"
        >
          Home
        </Link>
      </div>
    </main>
  );
}
