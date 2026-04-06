"use client";

import Script from "next/script";

/** Set NEXT_PUBLIC_PLAUSIBLE_DOMAIN in production (e.g. pacecasso.com). No script when unset. */
export default function PlausibleAnalytics() {
  const domain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN?.trim();
  if (!domain) return null;

  return (
    <Script
      defer
      data-domain={domain}
      src="https://plausible.io/js/script.js"
      strategy="afterInteractive"
    />
  );
}
