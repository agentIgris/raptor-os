/**
 * Public home states against the production build with NO database.
 *
 * The e2e webServer points DATABASE_URL at a dead port on purpose, so every
 * live source is unreachable and each section must degrade to its designed
 * unknown/empty state — never a crash, a spinner forever, or invented
 * content. Sections with real data are covered by the CMS publish-flow proof
 * (Task 3) and the mapper unit tests, not here.
 */

import { expect, test } from "@playwright/test";

test.describe("public home without data", () => {
  test("renders exactly one h1 and the hero calls to action", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Raptor Esports");
    await expect(page.getByRole("link", { name: "Explore the teams" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Latest results" })).toBeVisible();
  });

  test("degrades every data section honestly", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Divisions unavailable")).toBeVisible();
    await expect(page.getByText("Roster unavailable")).toBeVisible();
    await expect(page.getByText("Results unavailable")).toBeVisible();
    await expect(page.getByText("News unavailable")).toBeVisible();
    await expect(page.getByText("Story coming soon")).toBeVisible();
    await expect(page.getByText("Get in touch")).toBeVisible();
  });

  test("omits proof strip and partners when there is nothing to show", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByLabel("Organisation facts")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Partners" })).toHaveCount(0);
  });

  test("loads with no application errors in the console", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => {
      errors.push(`uncaught: ${error.message}`);
    });

    await page.goto("/");

    const unexpected = errors.filter((message) => !/Failed to load resource.*api\/auth/.test(message));
    expect(unexpected, `unexpected console errors on /:\n${unexpected.join("\n")}`).toEqual([]);
  });
});
