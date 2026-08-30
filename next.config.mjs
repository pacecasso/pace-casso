import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Turbopack (next dev) mis-infers the workspace root as the parent Desktop
  // folder on this machine, which breaks `@import "tailwindcss"` resolution
  // ("Can't resolve 'tailwindcss' in C:\users\ralph\desktop") and kills the
  // dev server + e2e runs. Pin the root to the repo. Production builds were
  // unaffected.
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
  async redirects() {
    return [
      // Visitors guess this URL from the "How it works" nav label; it 404ed
      // on both domains (caught by the Aug 30 user audit).
      { source: "/how-it-works", destination: "/how", permanent: true },
    ];
  },
};

export default nextConfig;
