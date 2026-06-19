import { test, expect, type Page } from "@playwright/test";

/**
 * `work serve` web console e2e — a lightweight structural + routing smoke test.
 *
 * Two contracts, deliberately independent of any run data:
 *   1. the shell renders (brand, primary nav, the bound-host pill, main region);
 *   2. clicking a nav CTA drives the SPA route — the URL, the active tab, and the
 *      page heading all reflect the app state for Workflows / Webhooks /
 *      Schedules / History.
 *
 * Nothing here asserts on workflow names, run ids, or any seeded content — only
 * on elements that exist for every install regardless of history.
 */

const SECTIONS = [
  { cta: "#nav-workflows", path: "/", heading: "Workflows" },
  { cta: "#nav-webhooks", path: "/webhooks", heading: "Webhooks" },
  { cta: "#nav-schedules", path: "/schedules", heading: "Schedules" },
  { cta: "#nav-history", path: "/history", heading: "Run history" },
] as const;

test.describe("shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("renders the console shell", async ({ page }) => {
    // Brand + product wordmark.
    await expect(page.locator("header.app .brand .name")).toContainText("work");

    // Primary nav exposes all four sections.
    const nav = page.locator("nav.app");
    await expect(nav).toBeVisible();
    for (const { cta } of SECTIONS) {
      await expect(page.locator(cta)).toBeVisible();
    }

    // The loopback host pill and the main content region.
    await expect(page.locator(".env-pill")).toBeVisible();
    await expect(page.locator("main#app")).toBeVisible();
  });

  test("lands on the Workflows route by default", async ({ page }) => {
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.locator("main#app h1")).toHaveText("Workflows");
    await expect(page.locator("#nav-workflows")).toHaveClass(/active/);
  });
});

test.describe("navigation reflects URL + app state", () => {
  for (const { cta, path, heading } of SECTIONS) {
    test(`clicking ${heading} routes to ${path}`, async ({ page }) => {
      await page.goto("/");
      await page.locator(cta).click();

      // URL state mirrors the section we navigated to.
      await expect(page).toHaveURL(new RegExp(`${escapeRegExp(path)}$`));
      expect(new URL(page.url()).pathname).toBe(path);

      // The view + active tab agree with the URL.
      await expect(page.locator("main#app h1")).toHaveText(heading);
      await expect(page.locator(cta)).toHaveClass(/active/);
      await expectOnlyActiveTab(page, cta);
    });
  }

  test("a deep link / refresh renders the same route", async ({ page }) => {
    await page.goto("/schedules");
    await expect(page.locator("main#app h1")).toHaveText("Schedules");
    await expect(page.locator("#nav-schedules")).toHaveClass(/active/);
    expect(new URL(page.url()).pathname).toBe("/schedules");
  });

  test("browser back/forward restore prior routes", async ({ page }) => {
    await page.goto("/");
    await page.locator("#nav-history").click();
    await expect(page).toHaveURL(/\/history$/);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`127\\.0\\.0\\.1:\\d+/$`));
    await expect(page.locator("main#app h1")).toHaveText("Workflows");

    await page.goForward();
    await expect(page).toHaveURL(/\/history$/);
    await expect(page.locator("main#app h1")).toHaveText("Run history");
  });
});

/** Exactly one primary-nav tab carries `.active` at a time. */
async function expectOnlyActiveTab(page: Page, activeCta: string) {
  const ctas = SECTIONS.map((s) => s.cta);
  for (const cta of ctas) {
    if (cta === activeCta) continue;
    await expect(page.locator(cta)).not.toHaveClass(/active/);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
