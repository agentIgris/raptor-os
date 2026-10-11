/**
 * The base stylesheet's accessibility contract.
 *
 * These are assertions about `globals.css` rather than about rendered output.
 * They exist because the focus ring is applied ONCE, at the base layer, to
 * every focusable element — which is the mechanism that makes
 * "accessible by default" true, and therefore the single most valuable line in
 * the whole design system. It is also the easiest line to delete: `outline:
 * none` is a one-character change that looks like a fix and silently removes
 * keyboard navigation for every user.
 *
 * The rendered, painted result is verified in a real browser in
 * `apps/web/e2e/a11y.spec.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const GLOBALS_PATH = fileURLToPath(new URL("./styles/globals.css", import.meta.url));
const globals = readFileSync(GLOBALS_PATH, "utf8");
const withoutComments = globals.replace(/\/\*[\s\S]*?\*\//g, "");

describe("focus indicator", () => {
  it("never suppresses an outline anywhere in the sheet", () => {
    // `outline: none` / `outline: 0` is the single most common way an
    // "accessible by default" claim is quietly withdrawn. It appears nowhere
    // here, comments stripped so this file's own explanation does not trip it.
    expect(withoutComments).not.toMatch(/outline\s*:\s*(none|0)\b/);
  });

  it("applies a focus indicator to every natively focusable element in one rule", () => {
    // One rule, one place to get it right. A per-component ring is a per-component
    // opportunity to forget it.
    expect(globals).toMatch(
      /:where\(a,\s*button,\s*input,\s*select,\s*textarea,\s*summary,\s*\[tabindex\]\):focus-visible\s*\{/,
    );
  });

  it("paints two rings, so at least one clears 3:1 on any surface", () => {
    // A single ring is invisible when it matches the surface it lands on — a
    // violet ring on a violet primary button is 1:1. The inner ring fills the
    // gap flush against the element in the theme's text colour; the outer
    // outline is the accent. `tokens.test.ts` proves the arithmetic.
    expect(globals).toMatch(/outline:\s*var\(--focus-ring-width\)\s*solid\s*var\(--focus-ring-color\)/);
    expect(globals).toMatch(/box-shadow:\s*0 0 0 var\(--focus-ring-offset\) var\(--focus-ring-inner\)/);
  });

  it("uses :focus-visible so the ring only appears for keyboard users", () => {
    expect(globals).toContain(":focus-visible");
  });

  it("has a forced-colours fallback that does not depend on author colours", () => {
    // In forced-colors mode every author colour is discarded, which would make
    // both rings the same colour. The system highlight colour is the only thing
    // guaranteed visible there.
    expect(globals).toMatch(/@media \(forced-colors: active\)/);
    expect(globals).toMatch(/outline:\s*3px solid Highlight/);
  });
});

describe("motion", () => {
  it("honours prefers-reduced-motion", () => {
    // WCAG 2.3.3 is AAA, and it is also the difference between an app someone
    // can use at a tournament and one they turn off.
    expect(globals).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(globals).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});

describe("typography and reflow", () => {
  it("sets a minimum 16px body size at the base layer", () => {
    // WCAG 1.4.4 requires text to be resizable to 200%. A body size below
    // 16px is the most common cause of that failing on a phone, because the
    // initial-scale then has to zoom out to fit a layout that was never
    // designed for it.
    expect(globals).toMatch(/font-size:\s*var\(--text-sm\)/);
  });

  it("keeps anchor targets clear of the sticky header", () => {
    // Without this, following a fragment link scrolls the target underneath the
    // sticky header and the user lands on something they cannot see.
    expect(globals).toMatch(/scroll-padding-top/);
  });

  it("does not disable text-size adjustment", () => {
    expect(withoutComments).not.toMatch(/text-size-adjust:\s*none/);
  });
});

describe("theme mapping", () => {
  it("uses `@theme inline` so the dark theme is not shadowed by a generated :root", () => {
    // Without `inline`, Tailwind snapshots the light value into its own `:root`
    // block, which wins over `.dark`. The dark mode then silently never
    // applies and every dark-theme contrast measurement is of a theme nobody
    // sees. This keyword is load-bearing.
    expect(globals).toMatch(/@theme inline\s*\{/);
  });

  it("maps both Tailwind's canonical shadcn names and the semantic ones", () => {
    // Dropping a community shadcn component in must inherit the verified
    // palette rather than introduce its own greys.
    expect(globals).toContain("--color-background: var(--surface-canvas)");
    expect(globals).toContain("--color-foreground: var(--text-primary)");
    expect(globals).toContain("--color-primary: var(--accent-base)");
    expect(globals).toContain("--color-destructive: var(--danger-base)");
  });

  it("maps every spacing step to a token so p-4 and --space-4 cannot drift", () => {
    expect(globals).toMatch(/--spacing-4:\s*var\(--space-4\)/);
    expect(globals).toMatch(/--spacing-16:\s*var\(--space-16\)/);
  });
});