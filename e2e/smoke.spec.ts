import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
  test("home redirects to marketing landing", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/landing\.html$/);
    await expect(
      page.getByRole("link", { name: "PaceCasso home" }),
    ).toBeVisible();
  });

  test("landing has primary CTA to create", async ({ page }) => {
    await page.goto("/landing.html");
    await expect(
      page.getByRole("link", { name: "Start Creating", exact: true }),
    ).toBeVisible();
  });

  test("create flow shows city gate", async ({ page }) => {
    await page.goto("/create");
    await expect(page.getByRole("button", { name: /^Continue$/ })).toBeVisible(
      { timeout: 30_000 },
    );
  });

  test("help page loads", async ({ page }) => {
    await page.goto("/help");
    await expect(
      page.getByRole("heading", { level: 1, name: "Help" }),
    ).toBeVisible();
  });
});
