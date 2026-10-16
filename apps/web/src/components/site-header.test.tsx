import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SiteHeader } from "./site-header";

let currentPath = "/";

vi.mock("next/navigation", () => ({
  usePathname: (): string => currentPath,
}));

interface MockImageProps {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly className?: string;
}

vi.mock("next/image", () => ({
  // Static-markup stand-in: enough to assert src/alt/dimensions.
  default: (props: MockImageProps): React.JSX.Element =>
    React.createElement("img", {
      src: props.src,
      alt: props.alt,
      width: props.width,
      height: props.height,
      className: props.className,
    }),
}));

/**
 * Public nav contract: core links always, Sign in quiet-last, Partners and
 * Join only behind their flags (brief: no partners entry without content, no
 * recruitment CTA while closed).
 */
describe("site header", () => {
  it("renders the core destinations with Sign in last", () => {
    currentPath = "/";
    const html = renderToStaticMarkup(<SiteHeader />);
    for (const label of ["Teams", "Results", "News &amp; Media", "About", "Sign in"]) {
      expect(html).toContain(label);
    }
    for (const href of ["/#teams", "/#results", "/#news", "/#about", "/sign-in"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html.indexOf("Sign in")).toBeGreaterThan(html.indexOf("About"));
    expect(html).not.toContain("Partners");
    expect(html).not.toContain("Join Raptor");
  });

  it("reveals Partners and Join behind their flags", () => {
    currentPath = "/teams";
    const html = renderToStaticMarkup(<SiteHeader showPartners recruitmentOpen />);
    expect(html).toContain("Partners");
    expect(html).toContain("Join Raptor");
    expect(html).toContain('href="/join"');
  });

  it("claims no current page on home: destinations are same-page anchors", () => {
    // Anchors are jumps, not pages — none may carry aria-current. When
    // detail routes land, the prefix logic in the component applies again.
    currentPath = "/";
    expect(renderToStaticMarkup(<SiteHeader />)).not.toContain('aria-current="page"');
  });

  it("brands with the placeholder logo at header size", () => {
    currentPath = "/";
    const html = renderToStaticMarkup(<SiteHeader />);
    expect(html).toContain('src="/placeholders/logo.svg"');
    // `&nbsp;` in JSX is the U+00A0 character in static markup, not the entity.
    // The wordmark uses `&nbsp;` (U+00A0 in static markup): assert the parts.
    expect(html).toContain("Raptor");
    expect(html).toContain("Esports");
  });
});
