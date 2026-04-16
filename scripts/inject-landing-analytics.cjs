/**
 * Injects NEXT_PUBLIC_PLAUSIBLE_DOMAIN into static landing.html meta for Plausible.
 * Leaves content empty when unset (in-page loader skips). Only writes if changed.
 */
const fs = require("fs");
const path = require("path");

const landingPath = path.join(__dirname, "..", "public", "landing.html");
const html = fs.readFileSync(landingPath, "utf8");

const domain = (process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN || "")
  .trim()
  .replace(/"/g, "");

const replacement =
  domain.length > 0
    ? `<meta name="pace-plausible-domain" content="${domain}" />`
    : '<meta name="pace-plausible-domain" content="" />';

const newHtml = html.replace(
  /<meta\s+name="pace-plausible-domain"\s+content="[^"]*"\s*\/>/i,
  replacement,
);

if (newHtml !== html) {
  fs.writeFileSync(landingPath, newHtml);
}

console.log(
  "[inject-landing-analytics] landing Plausible domain:",
  domain || "(empty — loader skips)",
);
