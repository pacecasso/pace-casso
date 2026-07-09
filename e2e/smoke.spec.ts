import { expect, test, type Page, type Route } from "@playwright/test";
import path from "node:path";

function distanceMeters(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lat1, lng1] = coords[i - 1]!;
    const [lat2, lng2] = coords[i]!;
    const mLat = (lat2 - lat1) * 111_320;
    const mLng =
      (lng2 - lng1) *
      111_320 *
      Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    total += Math.hypot(mLat, mLng);
  }
  return total;
}

function mockedCoordsFromRequest(route: Route): [number, number][] {
  if (route.request().method() === "POST") {
    const body = route.request().postDataJSON() as {
      coordinates?: [number, number][];
    };
    return body.coordinates ?? [];
  }
  const pathname = new URL(route.request().url()).pathname;
  const encoded = pathname.split("/walking/")[1] ?? "";
  return encoded
    .split(";")
    .map((pair) => {
      const [lng, lat] = pair.split(",").map(Number);
      return [lat, lng] as [number, number];
    })
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
}

async function mockMapbox(page: Page) {
  const fulfillDirections = async (route: Route) => {
    const coords = mockedCoordsFromRequest(route);
    const distance = Math.max(1, distanceMeters(coords));
    const geometry = coords.map(([lat, lng]) => [lng, lat]);
    const steps = coords.slice(0, -1).map(([lat, lng], i) => ({
      distance: Math.max(1, distance / Math.max(1, coords.length - 1)),
      duration: Math.max(1, distance / 1.4 / Math.max(1, coords.length - 1)),
      name: "Test Street",
      maneuver: {
        type: i === 0 ? "depart" : "turn",
        modifier: i === 0 ? undefined : "right",
        location: [lng, lat],
        instruction: i === 0 ? "Start on Test Street" : "Turn right onto Test Street",
      },
    }));

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        routes: [
          {
            distance,
            duration: distance / 1.4,
            geometry: { coordinates: geometry },
            legs: [{ steps }],
          },
        ],
      }),
    });
  };

  const fulfillMatching = async (route: Route) => {
    const coords = mockedCoordsFromRequest(route);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        matchings: [
          {
            confidence: 0.2,
            distance: Math.max(1, distanceMeters(coords)),
            geometry: {
              coordinates: coords.map(([lat, lng]) => [lng, lat]),
            },
          },
        ],
      }),
    });
  };

  const fulfillReverseGeocode = async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        features: [
          {
            text: "Test Street",
            place_type: ["street"],
          },
        ],
      }),
    });
  };

  await page.route("**/api/mapbox/walking-directions", fulfillDirections);
  await page.route("**/api/mapbox/walking-matching", fulfillMatching);
  await page.route("**/api/mapbox/geocode-reverse", fulfillReverseGeocode);
  await page.route("**/directions/v5/mapbox/walking/**", fulfillDirections);
  await page.route("**/matching/v5/mapbox/walking/**", fulfillMatching);
  await page.route("**/geocoding/v5/mapbox.places/**", fulfillReverseGeocode);
}

test.describe("smoke", () => {
  test.beforeEach(async ({ page }) => {
    await mockMapbox(page);
  });

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
    // Button label is "Continue with {preset.label}" after the multi-city
    // rewrite — accept both forms (future-proofing against a label tweak).
    await expect(
      page.getByRole("button", { name: /^Continue\b/ }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("create flow reaches artwork upload screen", async ({ page }) => {
    await page.goto("/create");
    await page.getByRole("button", { name: /^Continue\b/ }).click();
    await expect(
      page.getByRole("button", { name: /From a photo/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Draw on the map/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: /From a photo/i }).click();
    await expect(page.getByText("Choose file")).toBeVisible();
    await expect(page.getByText("Detail", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Next: place on map/i }),
    ).toBeDisabled();
  });

  test("svg upload traces and reaches placement screen", async ({ page }) => {
    await page.goto("/create");
    await page.getByRole("button", { name: /^Continue\b/ }).click();
    await page.getByRole("button", { name: /From a photo/i }).click();

    await page
      .locator('input[type="file"]')
      .setInputFiles(path.join(process.cwd(), "e2e", "fixtures", "simple-line.svg"));

    const nextButton = page.getByRole("button", { name: /Next: place on map/i });
    await expect(nextButton).toBeEnabled({ timeout: 30_000 });
    await nextButton.click();

    // The sketch-review gate sits between tracing and placement for photo
    // uploads; approve the suggested sketch to continue.
    await expect(page.getByText("APPROVE THE SKETCH")).toBeVisible();
    await page.getByRole("button", { name: /Use sketch/i }).last().click();

    await expect(page.getByText("Place on map").first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Snap to streets/i }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: /Snap to streets/i }),
    ).toBeInViewport();
    const pageScrolls = await page.evaluate(
      () =>
        document.documentElement.scrollHeight > window.innerHeight + 4 ||
        document.body.scrollHeight > window.innerHeight + 4,
    );
    expect(pageScrolls).toBe(false);
  });

  test("svg workflow reaches final GPX export with mocked routing", async ({ page }) => {
    await page.goto("/create");
    await page.getByRole("button", { name: /^Continue\b/ }).click();
    await page.getByRole("button", { name: /From a photo/i }).click();

    await page
      .locator('input[type="file"]')
      .setInputFiles(path.join(process.cwd(), "e2e", "fixtures", "simple-line.svg"));

    await expect(
      page.getByRole("button", { name: /Next: place on map/i }),
    ).toBeEnabled({ timeout: 30_000 });
    await page.getByRole("button", { name: /Detailed trace/i }).click();
    await page.getByRole("button", { name: /Next: place on map/i }).click();

    // Approve the sketch-review gate before placement.
    await expect(page.getByText("APPROVE THE SKETCH")).toBeVisible();
    await page.getByRole("button", { name: /Use sketch/i }).last().click();

    await expect(page.getByText("Place on map").first()).toBeVisible();
    await page.getByRole("button", { name: /Snap to streets/i }).click();

    await expect(page.getByText(/READY TO TUNE/i)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /Tune route/i }).click();
    await expect(page.getByText(/READY TO RUN/i)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /Looks good/i }).click();
    await expect(page.getByText(/Route ready/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("button", { name: /Download GPX/i }),
    ).toBeEnabled();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download GPX/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("pacecasso-route.gpx");
  });

  test("help page loads", async ({ page }) => {
    await page.goto("/help");
    await expect(
      page.getByRole("heading", { level: 1, name: "Help" }),
    ).toBeVisible();
  });
});
