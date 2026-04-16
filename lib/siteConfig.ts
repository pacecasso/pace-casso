/**
 * Marketing / social — optional URLs via NEXT_PUBLIC_* (set in Vercel or .env.local).
 * Omit an env var to hide that link.
 */

function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

export function getSocialLinks(): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  const add = (label: string, key: string) => {
    const href = env(key);
    if (href) out.push({ label, href });
  };
  add("Instagram", "NEXT_PUBLIC_SOCIAL_INSTAGRAM");
  add("X", "NEXT_PUBLIC_SOCIAL_X");
  add("GitHub", "NEXT_PUBLIC_SOCIAL_GITHUB");
  return out;
}

/** Handle for share copy (no @ required in env). */
export function getShareTwitterHandle(): string {
  return env("NEXT_PUBLIC_SOCIAL_X_HANDLE") ?? "pacecasso";
}
