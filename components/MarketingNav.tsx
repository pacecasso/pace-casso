import Link from "next/link";
import BrandLogo from "./BrandLogo";

/**
 * Same structure as `public/landing.html` nav: logo, centered links, yellow CTA.
 */
export default function MarketingNav() {
  return (
    <header className="sticky top-0 z-50 bg-pace-white shadow-sm">
      <div className="pace-app-nav flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <Link
          href="/landing.html"
          className="inline-block shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-pace-yellow focus-visible:ring-offset-2"
          aria-label="PaceCasso home"
        >
          <BrandLogo />
        </Link>
        <nav
          className="order-3 flex w-full flex-wrap items-center justify-center gap-x-8 gap-y-2 border-t border-pace-line pt-3 lg:order-1 lg:flex-1 lg:w-auto lg:border-t-0 lg:pt-0"
          aria-label="Main"
        >
          <Link
            href="/landing.html"
            className="pace-nav-link font-bebas text-sm tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
          >
            Home
          </Link>
          <Link
            href="/gallery"
            className="pace-nav-link font-bebas text-sm tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
          >
            Gallery
          </Link>
          <Link
            href="/how"
            className="pace-nav-link font-bebas text-sm tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
          >
            How It Works
          </Link>
          <Link
            href="/community"
            className="pace-nav-link font-bebas text-sm tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
          >
            Community
          </Link>
          <Link
            href="/help"
            className="pace-nav-link font-bebas text-sm tracking-[0.14em] text-pace-ink transition hover:text-pace-yellow"
          >
            Help
          </Link>
        </nav>
        <Link
          href="/create"
          className="pace-btn-primary order-2 shrink-0 rounded px-4 py-2 text-sm font-bold uppercase tracking-wide sm:px-6 sm:text-base lg:order-3"
        >
          Start Creating
        </Link>
      </div>
    </header>
  );
}
