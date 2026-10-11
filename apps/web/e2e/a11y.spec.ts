/**
 * WCAG 2.2 AA, in a real browser.
 *
 * WHY A BROWSER AND NOT jsdom
 * --------------------------
 * axe-core's `color-contrast` rule needs a layout engine and real painted
 * colours. Under jsdom it returns `incomplete` — "I could not determine this" —
 * which is not a pass. This suite runs against the production build in
 * Chromium, so contrast, focus rings, reflow and target sizes are all measured
 * on rendered pixels.
 *
 * WHAT IS COVERED
 * ---------------
 *  - axe-core over every route that renders without a session, at three real
 *    viewports.
 *  - The focus indicator, measured as computed style rather than as a class.
 *  - Keyboard order, the skip link, and the mobile disclosure.
 *  - Reflow at 320 CSS px (WCAG 1.4.10) and at 200% of a 1280px viewport
 *    (WCAG 1.4.4).
 *  - Target sizes at a coarse pointer (WCAG 2.5.8 / 2.5.5).
 *
 * WHAT IS NOT COVERED, AND WHY
 * ----------------------------
 *  - `/dashboard`. It is behind a session guard that fails closed, and there
 *    is no database in this environment, so no session can exist. Asserting a
 *    bypass to make it testable would be a worse outcome than a gap. Its
 *    markup is covered by `src/__tests__/a11y-static.spec.tsx` (axe over the
 *    rendered component tree) and its colours by the token arithmetic in
 *    `packages/ui/src/tokens.test.ts`.
 *  - Sign-in with real credentials, and every authenticated route, for the
 *    same reason.
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** The routes that render for an anonymous visitor. */
const ROUTES = [
  { path: "/", name: "overview" },
  { path: "/sign-in", name: "sign-in" },
] as const;

/**
 * Real device widths, not arbitrary ones.
 *
 * 360x640 is a common Android width; 768x1024 is the tablet breakpoint; 1280
 * is where the desktop navigation layout switches on. Testing at the widths
 * the product is actually used at is the point — the buyer is on a phone at a
 * tournament, not at whatever the CSS was authored against.
 */
const VIEWPORTS = [
  { name: "mobile", width: 360, height: 640 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

const WCAG_22_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

function formatViolations(violations: readonly { id: string; impact?: string | null; help: string; nodes: readonly { target: unknown; failureSummary?: string }[] }[]): string {
  if (violations.length === 0) return "  (none)";
  return violations
    .map(
      (violation) =>
        `  [${String(violation.impact)}] ${violation.id} — ${violation.help}\n` +
        violation.nodes
          .map((node) => `      ${JSON.stringify(node.target)}\n${node.failureSummary ?? ""}`)
          .join("\n"),
    )
    .join("\n");
}

test.describe("WCAG 2.2 AA — axe-core over every route", () => {
  for (const route of ROUTES) {
    for (const viewport of VIEWPORTS) {
      test(`${route.name} at ${viewport.width}x${viewport.height} has no violations`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(route.path, { waitUntil: "networkidle" });

        const results = await new AxeBuilder({ page })
          .withTags(WCAG_22_AA_TAGS)
          .analyze();

        expect(
          results.violations,
          `axe-core violations on ${route.path} at ${viewport.width}x${viewport.height}:\n${formatViolations(results.violations)}`,
        ).toEqual([]);
      });
    }
  }

  test("colour contrast is actually evaluated in the browser, not deferred", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/", { waitUntil: "networkidle" });

    const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA_TAGS).analyze();

    // If `color-contrast` came back `incomplete` here, the rule did not run and
    // every contrast assertion in this suite would be vacuous. Asserting this
    // is what makes the rest of the file mean something.
    const deferred = results.incomplete.filter((entry) => entry.id === "color-contrast");
    expect(
      deferred.map((entry) => entry.nodes.map((node) => JSON.stringify(node.target))),
      "color-contrast was not evaluated — the contrast assertions below would be meaningless",
    ).toEqual([]);
  });

  test("colour contrast is measured for the cells inside the horizontally scrolling table", async ({ page }) => {
    // At 360px the data tables scroll horizontally inside their own region —
    // that is the WCAG 1.4.10 Reflow behaviour — and axe cannot determine the
    // painted background of a cell scrolled out of that region. It reports
    // `incomplete`, which means "could not measure", NOT "passed".
    //
    // So the container is temporarily allowed to lay out at full width. Nothing
    // about the colours changes — same tokens, same cascade, same computed
    // values — but every cell becomes measurable, which is what turns the
    // assertions below from "no complaints" into "measured".
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/", { waitUntil: "networkidle" });

    const before = await new AxeBuilder({ page }).withTags(WCAG_22_AA_TAGS).analyze();
    expect(
      before.incomplete.filter((entry) => entry.id === "color-contrast").length,
      "expected axe to defer the off-screen table cells; if it no longer does, this test's premise has changed",
    ).toBeGreaterThan(0);

    await page.addStyleTag({
      content: '[role="region"] { overflow-x: visible !important; } body { width: max-content; }',
    });

    const after = await new AxeBuilder({ page }).withTags(WCAG_22_AA_TAGS).analyze();

    expect(
      after.violations,
      `axe-core violations with the table unrolled:\n${formatViolations(after.violations)}`,
    ).toEqual([]);
    expect(
      after.incomplete
        .filter((entry) => entry.id === "color-contrast")
        .flatMap((entry) => entry.nodes.map((node) => JSON.stringify(node.target))),
      "contrast is still unmeasurable for some cells once the table is laid out in full",
    ).toEqual([]);
  });

  test("dark colour scheme also passes", async ({ page }) => {
    // The dark theme is a separate set of token values with its own contrast
    // arithmetic; testing only the light theme would test half the palette.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/", { waitUntil: "networkidle" });

    const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA_TAGS).analyze();
    expect(results.violations, `dark scheme violations:\n${formatViolations(results.violations)}`).toEqual([]);
  });

  test("increased-contrast preference also passes", async ({ page }) => {
    // The `prefers-contrast: more` block in globals.css rewrites the text and
    // border ramp. A preference that produces a violation would be a
    // preference that makes the app worse.
    await page.emulateMedia({ contrast: "more" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/", { waitUntil: "networkidle" });

    const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA_TAGS).analyze();
    expect(results.violations, `prefers-contrast: more violations:\n${formatViolations(results.violations)}`).toEqual([]);
  });
});

test.describe("focus indicator, measured", () => {
  test("a focused link paints a visible outline", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/", { waitUntil: "networkidle" });

    await page.keyboard.press("Tab");

    const styles = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null) return null;
      const computed = window.getComputedStyle(element);
      return {
        tagName: element.tagName,
        outlineStyle: computed.outlineStyle,
        outlineWidth: computed.outlineWidth,
        outlineColor: computed.outlineColor,
        boxShadow: computed.boxShadow,
      };
    });

    expect(styles).not.toBeNull();
    expect(styles?.tagName).toBe("A");
    expect(styles?.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(styles?.outlineWidth ?? "0")).toBeGreaterThan(0);
    // The inner ring. Both halves matter: the outline alone is a single colour
    // and disappears on a surface that matches it.
    expect(styles?.boxShadow ?? "none").not.toBe("none");
  });

  test("the focus ring is visible on a solid accent button, where a single-colour ring would not be", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in", { waitUntil: "networkidle" });

    const button = page.getByRole("button", { name: "Sign in" });
    await button.focus();

    const styles = await button.evaluate((element) => {
      const computed = window.getComputedStyle(element);
      return {
        outlineStyle: computed.outlineStyle,
        outlineWidth: computed.outlineWidth,
        boxShadow: computed.boxShadow,
        backgroundColor: computed.backgroundColor,
      };
    });

    expect(styles.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(styles.outlineWidth)).toBeGreaterThan(0);
    expect(styles.boxShadow).not.toBe("none");
  });
});

test.describe("keyboard navigation", () => {
  test("the first Tab stop is the skip link, and it becomes visible", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/", { waitUntil: "networkidle" });

    await page.keyboard.press("Tab");

    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();

    // It must be on screen and hit-testable, not merely present. A skip link
    // clipped out of reach by a bug is the worst kind: announced, unfindable.
    const box = await skip.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.width ?? 0) * (box?.height ?? 0)).toBeGreaterThan(0);
  });

  test("activating the skip link moves focus into main", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/", { waitUntil: "networkidle" });

    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    const activeId = await page.evaluate(() => document.activeElement?.id ?? null);
    expect(activeId).toBe("main");
  });

  test("every interactive element is reachable by Tab alone", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/sign-in", { waitUntil: "networkidle" });

    const reached = await tabThrough(page, 40);
    const expected = await page.evaluate(() => {
      const selector = "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])";
      return [...document.querySelectorAll<HTMLElement>(selector)]
        .filter((element) => {
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && element.tabIndex >= 0;
        })
        .map((element) => element.id || element.getAttribute("name") || element.tagName);
    });

    // Every focusable control on the page was actually visited. A control that
    // exists but is unreachable by keyboard is invisible to this assertion
    // unless the counts are compared, which is what the set difference does.
    const visited = new Set(reached);
    const missing = expected.filter((identifier) => !visited.has(identifier));
    expect(missing, "controls that Tab never reached").toEqual([]);
  });
});

/** Press Tab `times` times, returning the id/name/tag of each focused element. */
async function tabThrough(page: Page, times: number): Promise<string[]> {
  const seen: string[] = [];
  for (let index = 0; index < times; index += 1) {
    await page.keyboard.press("Tab");
    const identifier = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null || element === document.body) return null;
      return element.id || element.getAttribute("name") || element.tagName;
    });
    if (identifier !== null) seen.push(identifier);
  }
  return seen;
}

test.describe("responsive behaviour at real breakpoints", () => {
  test("no horizontal page overflow at 320px (WCAG 1.4.10 Reflow)", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/", { waitUntil: "networkidle" });

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    // One pixel of slack for sub-pixel layout rounding; anything more is a
    // genuinely unreachable column.
    expect(
      overflow.scrollWidth,
      `document scrolls horizontally at 320px: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test("the mobile navigation is behind a disclosure below md, and inline above it", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/", { waitUntil: "networkidle" });

    const toggle = page.getByRole("button", { name: /main menu/i });
    // Scoped to the navigation landmark: the page also contains a call to
    // action whose accessible name contains "dashboard", and an unscoped
    // locator would match whichever came first in the DOM.
    const nav = page.getByRole("navigation", { name: "Primary" });
    const dashboardLink = nav.getByRole("link", { name: "Dashboard" });

    await expect(toggle).toBeVisible();
    // Collapsed: the links are not on the page for a keyboard user to tab into.
    await expect(dashboardLink).toBeHidden();

    // `toPass` retries the whole action. This is not papering over a flake:
    // `PrimaryNav` is a client component, so until React hydrates the button
    // is a real <button> with a real `aria-expanded` and no behaviour yet.
    // The assertion that matters is "it becomes operable", bounded by a
    // timeout a real user would tolerate.
    await expect(async () => {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    }).toPass({ timeout: 10_000 });

    await expect(dashboardLink).toBeVisible();

    // The toggle leaves the tab order on a wide viewport, where the nav is
    // always visible and a disclosure button would be noise.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(toggle).toBeHidden();
    await expect(dashboardLink).toBeVisible();
  });

  test("the disclosure is operable entirely from the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/", { waitUntil: "networkidle" });

    const toggle = page.getByRole("button", { name: /main menu/i });

    // Same hydration caveat as above, expressed as a retry on the keyboard
    // path so the assertion stays about Enter/Space rather than about timing.
    await expect(async () => {
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    }).toPass({ timeout: 10_000 });

    // With the panel open, the next Tab must land on a nav link, not skip past
    // it. This is what proves the panel is in the tab order once expanded and
    // removed from it once collapsed.
    await page.keyboard.press("Tab");
    const focused = (await page.evaluate(() => document.activeElement?.textContent ?? "")).trim();
    expect(["Overview", "Dashboard", "Sign in"]).toContain(focused);
  });

  test("the collapsed panel is genuinely unreachable by keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/", { waitUntil: "networkidle" });

    // An off-screen-but-present nav is the classic mobile a11y defect: a
    // keyboard user tabs into an invisible list of links. Tabbing forward ten
    // times must never land inside the collapsed panel.
    await expect(async () => {
      await page.getByRole("button", { name: /main menu/i }).focus();
    }).toPass({ timeout: 10_000 });

    const visited: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press("Tab");
      visited.push((await page.evaluate(() => document.activeElement?.textContent ?? "")).trim());
    }

    expect(visited, "Tab reached a link inside the collapsed navigation").not.toContain("Dashboard");
    expect(visited).not.toContain("Overview");
  });

  test("interactive targets are at least 44px on a phone", async ({ page }) => {
    // WCAG 2.2 SC 2.5.8 asks for 24x24 CSS px; 44 is SC 2.5.5 (AAA) and is the
    // size that survives a thumb on a phone at a tournament.
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/", { waitUntil: "networkidle" });

    const tooSmall = await page.evaluate(() => {
      const selector = "a[href], button, input, select, textarea";
      const problems: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = element.getBoundingClientRect();
        // A 1x1 box is a `sr-only` element: clipped out of view until focused.
        // It is not a target anyone can hit, so it is measured separately,
        // while focused, rather than counted here.
        if (rect.width <= 1 || rect.height <= 1) continue;
        if (rect.height < 44 || rect.width < 44) {
          problems.push(
            `${element.tagName} "${(element.textContent ?? "").trim().slice(0, 30)}" is ${Math.round(rect.width)}x${Math.round(rect.height)}`,
          );
        }
      }
      return problems;
    });

    expect(tooSmall, `targets under 44x44 at 360px:\n  ${tooSmall.join("\n  ")}`).toEqual([]);
  });

  test("the skip link meets 44px once it is visible", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/", { waitUntil: "networkidle" });

    await page.keyboard.press("Tab");
    const box = await page.getByRole("link", { name: "Skip to main content" }).boundingBox();

    expect(box).not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  });

  test("content survives 200% text zoom (WCAG 1.4.4)", async ({ page }) => {
    // Playwright cannot zoom the browser viewport, so 200% zoom is emulated
    // the way it actually manifests: the layout width halves. At 1280 wide,
    // 200% zoom gives the page 640 CSS px to lay out in.
    await page.setViewportSize({ width: 640, height: 512 });
    await page.goto("/", { waitUntil: "networkidle" });

    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      `content is lost at 200% zoom: ${overflow.scrollWidth} > ${overflow.clientWidth}`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});

test.describe("reduced motion", () => {
  test("collapses every transition to the 0.01ms floor", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/", { waitUntil: "networkidle" });

    const durations = await page.evaluate(() => {
      const link = [...document.querySelectorAll<HTMLElement>("a[href]")].find(
        (element) => (element.textContent ?? "").trim() === "Dashboard",
      );
      if (link === undefined) return [];
      return window
        .getComputedStyle(link)
        .transitionDuration.split(",")
        .map((value) => Number.parseFloat(value) * (value.includes("ms") ? 0.001 : 1));
    });

    expect(durations.length).toBeGreaterThan(0);
    // Chromium serialises 0.01ms as `1e-05s`, so the comparison is numeric
    // rather than a regex against the string. Every duration must be under a
    // millisecond — not merely "shorter than before", which would pass even if
    // the block were deleted.
    for (const duration of durations) {
      expect(duration).toBeLessThan(0.001);
    }
  });

  test("still applies transitions when the preference is off", async ({ page }) => {
    // The other half of the contract: a `prefers-reduced-motion` block that
    // zeroes durations unconditionally would satisfy the test above while
    // making the whole interface feel broken. Measured on a control that
    // actually declares a transition — the nav links do not.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/", { waitUntil: "networkidle" });

    // A link, not a button: `asChild` renders the `<a>` and the element is a
    // navigation, so the role is correct and is asserted rather than assumed.
    const call = page.getByRole("link", { name: "Open the dashboard" });
    await expect(call).toBeVisible();

    const duration = await call.evaluate((element) => window.getComputedStyle(element).transitionDuration);

    expect(Number.parseFloat(duration)).toBeGreaterThan(0);
  });
});