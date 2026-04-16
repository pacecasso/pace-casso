"use client";

import { getSocialLinks } from "../lib/siteConfig";

export default function SocialLinks() {
  const links = getSocialLinks();
  if (!links.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
      <span aria-hidden className="text-pace-line">
        ·
      </span>
      {links.map((l, i) => (
        <span key={l.href}>
          {i > 0 ? (
            <span aria-hidden className="text-pace-line">
              {" "}
              ·{" "}
            </span>
          ) : null}
          <a
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-bebas tracking-[0.12em] text-pace-ink transition hover:text-pace-yellow"
          >
            {l.label}
          </a>
        </span>
      ))}
    </span>
  );
}
