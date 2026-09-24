import { expect, test } from "@playwright/test";
import path from "node:path";

/**
 * The phone run Ralph actually does, against PRODUCTION: Brooklyn -> photo ->
 * Find my route -> the stroke edit step. Nothing is mocked; the point is to
 * catch a dead end on a small screen before he does (Sep 6: a Done button that
 * could not be tapped, a Continue disabled under the first draft).
 */
// phone-sized on the project's own browser (devices[] forces webkit, which
// this project is not configured for)
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const BASE = process.env.PHONE_BASE ?? "https://www.pacecasso.com";

test("brooklyn draft and edit on a phone", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Start Creating", exact: true }).first().click();

  // city gate is a <select>, and the Continue button names the chosen city
  await page.getByRole("combobox").first().selectOption({ label: "Brooklyn — New York City" });
  await page.getByRole("button", { name: /Continue with Brooklyn/i }).click();

  // upload
  await page.getByRole("button", { name: /From a photo/i }).click();
  await page.locator('input[type="file"]').first()
    .setInputFiles(path.join(process.cwd(), "catpic.jpg"));
  // the trace step needs an explicit "Done" before it will build the route line
  const done = page.getByRole("button", { name: /Done — build my route line/i });
  await expect(done).toBeVisible({ timeout: 60_000 });
  await done.click();
  const next = page.getByRole("button", { name: /Next: place on map/i });
  await expect(next).toBeEnabled({ timeout: 90_000 });
  await next.click();

  // draft: wait for the SEARCH to end, not the size estimate shown on this step
  const find = page.getByRole("button", { name: /Find my route/i }).first();
  await expect(find).toBeVisible({ timeout: 30_000 });
  await find.click();
  await expect(page.getByRole("button", { name: /Finding your route/i })).toHaveCount(0, { timeout: 6 * 60_000 });
  await page.getByRole("button", { name: /Continue with this draft/i }).click();

  // the edit step must be reachable AND usable on this screen: before Sep 24
  // every Brooklyn draft was refused here with "manhattan-only"
  await expect(page.getByRole("button", { name: /Draw a line/i })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: /Looks good — continue/i })).toBeVisible();
  for (const b of await page.getByRole("button").all()) {
    const label = (await b.textContent())?.trim() ?? "";
    if (!label) continue;
    const box = await b.boundingBox();
    if (box && (box.y + box.height > 900 || box.width < 24 || box.height < 24)) {
      console.log(`SMALL/OFFSCREEN TAP TARGET: "${label}" ${JSON.stringify(box)}`);
    }
  }
  await page.screenshot({ path: "tmp-perceptual/phone-edit.png", fullPage: true });
});
