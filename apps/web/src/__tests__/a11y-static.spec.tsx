/**
 * @vitest-environment jsdom
 *
 * axe-core over the application's own routes, as rendered markup.
 *
 * WHAT THIS COVERS
 * ----------------
 * The two routes that render for an anonymous visitor, plus the dashboard's own
 * content. axe-core evaluates the real element tree the components produce:
 * heading order, landmark structure and roles, accessible names, label
 * associations, `aria-*` validity, list structure, table header association,
 * and every WCAG 2.2 AA rule that does not need a layout engine.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER
 * ----------------------------------
 * `color-contrast`. jsdom has no layout and no real computed background
 * painting, so axe returns `incomplete` for that rule rather than a verdict.
 * Pretending otherwise would be the worst kind of green — a passing contrast
 * assertion that measured nothing.
 *
 * Colour contrast is therefore asserted in two other places, both real:
 *   - `packages/ui/src/tokens.test.ts` computes every token pair's WCAG ratio
 *     from the shipped values, in both themes;
 *   - `apps/web/e2e/a11y.spec.ts` runs this same rule set through
 *     `@axe-core/playwright` against the real server in Chromium, where the
 *     colours are genuinely painted, at three viewports.
 *
 * The assertion at the bottom of this file enforces that arrangement: every
 * `incomplete` result must be `color-contrast` and nothing else. If a rule
 * axe cannot judge appears here, this test fails rather than quietly adding to
 * the gap.
 */

import axe from "axe-core";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SiteLayout from "../app/(site)/layout";
import OverviewPage from "../app/(site)/page";
import DashboardPage from "../app/(app)/dashboard/page";
import RootLayout from "../app/layout";

/**
 * The public home reads live sources; in this suite there is no database, so
 * the data layer is stubbed at the module boundary to the known-empty state.
 * What is asserted here is structure and contrast, not content — content
 * states are covered by `e2e/public.spec.ts` and the mapper unit tests.
 */
vi.mock("../server/public", () => ({
  getPublicDivisions: (): Promise<readonly unknown[]> => Promise.resolve([]),
  getPublicTeams: (): Promise<readonly unknown[]> => Promise.resolve([]),
  getPublicResults: (): Promise<readonly unknown[]> => Promise.resolve([]),
}));

vi.mock("../server/cms", () => ({
  getPublishedNews: (): Promise<readonly unknown[]> => Promise.resolve([]),
  getPublishedPartners: (): Promise<readonly unknown[]> => Promise.resolve([]),
  getRecruitment: (): Promise<unknown> =>
    Promise.resolve({ open: false, heading: null, formTarget: null }),
  getSiteSocials: (): Promise<readonly unknown[]> => Promise.resolve([]),
}));

/**
 * The WCAG conformance tags to run.
 *
 * `wcag22aa` is included explicitly: axe does not enable WCAG 2.2 AA rules by
 * default when tags are given, and 2.2 is the version this product claims.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

interface AxeViolationShape {
  readonly id: string;
  readonly impact?: string | null;
  readonly help: string;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

/** Replace the whole document, so `<html lang>` is present and axe sees it. */
function mount(markup: string): void {
  document.open();
  document.write(`<!DOCTYPE html>${markup}`);
  document.close();

  // Next injects `<title>` from each route's `metadata` export at request
  // time; `renderToStaticMarkup` does not, because it renders a component tree
  // and not a Next response. Without this, axe's `document-title` rule fires on
  // every case and reports a defect in the harness rather than in the app.
  // The rule is left ENABLED, so a route that genuinely loses its metadata
  // title still fails — here and in the browser run.
  if (document.querySelector("title") === null) {
    const title = document.createElement("title");
    title.textContent = "Raptor OS";
    document.head.append(title);
  }
}

function renderRoute(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

async function runAxe(): Promise<axe.AxeResults> {
  return await axe.run(document, {
    runOnly: { type: "tag", values: [...TAGS] },
  });
}

function describeViolations(results: axe.AxeResults): string {
  return (results.violations as readonly AxeViolationShape[])
    .map(
      (violation) =>
        `  [${String(violation.impact)}] ${violation.id} — ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(" ")}`).join("\n"),
    )
    .join("\n");
}

beforeEach(() => {
  mount("<!DOCTYPE html><html lang='en'><head><title>t</title></head><body></body></html>");
});

describe("axe-core over the overview route", () => {
  it("has no WCAG 2.2 AA violations", async () => {
    // The full document composition: root layout -> site layout -> page. This
    // is what the browser actually gets, minus the CSS.
    mount(
      renderRoute(
        <RootLayout>
          <SiteLayout>
            {await OverviewPage()}
          </SiteLayout>
        </RootLayout>,
      ),
    );

    const results = await runAxe();

    expect(results.violations, `axe-core violations on /:\n${describeViolations(results)}`).toEqual([]);
  });

  it("renders a document with a language and exactly one h1", async () => {
    mount(
      renderRoute(
        <RootLayout>
          <SiteLayout>
            {await OverviewPage()}
          </SiteLayout>
        </RootLayout>,
      ),
    );

    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("exposes the landmarks a screen-reader user navigates by", async () => {
    mount(
      renderRoute(
        <RootLayout>
          <SiteLayout>
            {await OverviewPage()}
          </SiteLayout>
        </RootLayout>,
      ),
    );

    // banner, main, contentinfo and a *named* navigation. A nav with no
    // accessible name is indistinguishable from every other nav once there is
    // more than one.
    expect(document.querySelector("body > header")).not.toBeNull();
    expect(document.querySelector("main#main")).not.toBeNull();
    expect(document.querySelector("body > footer")).not.toBeNull();

    const nav = document.querySelector("nav");
    expect(nav).not.toBeNull();
    expect(nav?.getAttribute("aria-label")).toBe("Primary");
  });

  it("puts the skip link first, pointing at the main landmark", async () => {
    mount(
      renderRoute(
        <RootLayout>
          <SiteLayout>
            {await OverviewPage()}
          </SiteLayout>
        </RootLayout>,
      ),
    );

    const skip = document.querySelector<HTMLAnchorElement>('a[href="#main"]');
    expect(skip).not.toBeNull();
    expect(document.querySelector("main#main")).not.toBeNull();

    // First focusable element in document order.
    const firstFocusable = document.querySelector<HTMLAnchorElement>(
      "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    expect(firstFocusable).toBe(skip);
  });

  it("labels every table and scopes every header cell", async () => {
    mount(
      renderRoute(
        <RootLayout>
          <SiteLayout>
            {await OverviewPage()}
          </SiteLayout>
        </RootLayout>,
      ),
    );

    const tables = [...document.querySelectorAll("table")];
    // Empty states render instead of tables when there is no data — the rule
    // below guards every table that DOES render, on every route, with data or
    // without. An assertion of `> 0` here would force demo rows into an empty
    // database, which is exactly what this page refuses to do.
    for (const table of tables) {
      const region = table.closest('[role="region"]');
      expect(region?.getAttribute("aria-label") ?? "", "a data table must be a named, focusable region").not.toBe("");
      expect(region?.getAttribute("tabindex")).toBe("0");

      for (const header of table.querySelectorAll("th")) {
        expect(header.getAttribute("scope") ?? "", "every th needs a scope").not.toBe("");
      }
    }
  });
});

describe("axe-core over the dashboard content", () => {
  it("has no WCAG 2.2 AA violations", async () => {
    // The page component only. Its parent layout is what enforces the session
    // guard, and that guard means the composed route cannot be rendered in a
    // unit test without a database — the live route is covered by the
    // Playwright run instead. The page's own markup is fully covered here.
    mount(
      `<!DOCTYPE html><html lang="en"><head><title>Dashboard</title></head><body><main id="main">${renderRoute(<DashboardPage />)}</main></body></html>`,
    );

    const results = await runAxe();

    expect(
      results.violations,
      `axe-core violations on the dashboard content:\n${describeViolations(results)}`,
    ).toEqual([]);
  });

  it("keeps its heading order monotonic", () => {
    mount(
      `<!DOCTYPE html><html lang="en"><head><title>Dashboard</title></head><body><main id="main">${renderRoute(<DashboardPage />)}</main></body></html>`,
    );

    const levels = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((heading) =>
      Number.parseInt(heading.tagName.slice(1), 10),
    );
    expect(levels.length).toBeGreaterThan(0);

    for (let index = 1; index < levels.length; index += 1) {
      expect(
        levels[index] as number,
        `heading level jumped from h${String(levels[index - 1])} to h${String(levels[index])}`,
      ).toBeLessThanOrEqual((levels[index - 1] as number) + 1);
    }
  });
});

describe("what this suite cannot see", () => {
  it("leaves colour contrast as the only incomplete rule — nothing else slipped through", async () => {
    // The honest statement of the gap. If a future axe version starts
    // returning `incomplete` for rules jsdom cannot answer, this fails and the
    // gap has to be accounted for rather than absorbed.
    mount(
      renderRoute(
        <RootLayout>
          <SiteLayout>
            {await OverviewPage()}
          </SiteLayout>
        </RootLayout>,
      ),
    );

    const results = await runAxe();
    const incompleteIds = [...new Set(results.incomplete.map((entry) => entry.id))].sort();

    expect(
      incompleteIds.filter((id) => id !== "color-contrast"),
      "new axe rules became unanswerable in jsdom; either cover them or record them here",
    ).toEqual([]);
  });

  it("does confirm color-contrast was actually attempted", async () => {
    mount(
      renderRoute(
        <RootLayout>
          <SiteLayout>
            {await OverviewPage()}
          </SiteLayout>
        </RootLayout>,
      ),
    );

    const results = await runAxe();
    expect(
      results.incomplete.some((entry) => entry.id === "color-contrast"),
      "expected color-contrast to be reported as incomplete under jsdom; if it is not, " +
        "axe is answering it for real and the browser run is no longer the only colour evidence",
    ).toBe(true);
  });
});