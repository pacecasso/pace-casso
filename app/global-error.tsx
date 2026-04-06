"use client";

import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({
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
    <html lang="en">
      <body className="min-h-screen bg-[#f7f4ee] px-4 py-16 font-sans text-[#0d0d0d] antialiased">
        <div className="mx-auto max-w-md text-center">
          <h1 className="text-2xl font-bold tracking-tight">
            Something went wrong
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-[#666666]">
            Please try again. If the problem continues, refresh the page.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-8 rounded-lg bg-[#ffb800] px-6 py-3 text-sm font-semibold text-[#0d0d0d]"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
