"use client";

import { usePathname } from "next/navigation";
import * as React from "react";

import { BrandMark, PrimaryNav, ThemeToggle } from "@raptor/ui";

const SITE_LINKS = [
  { href: "/", label: "Overview" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/sign-in", label: "Sign in" },
] as const;

/**
 * Public site header.
 *
 * Client-rendered for one reason only: the active destination. The previous
 * layout hardcoded `current: true` on "Overview", so a screen-reader user on
 * `/sign-in` was told they were on the overview. `usePathname` marks the link
 * whose href matches the current route, which is the only correct value.
 *
 * The brand mark is an inline SVG (see `BrandMark`), not the legacy emoji
 * glyph, and the theme toggle is a persistent header action — always visible,
 * never hidden behind the mobile disclosure.
 */
export function SiteHeader(): React.JSX.Element {
  const pathname = usePathname();
  const items = SITE_LINKS.map((link) => ({
    ...link,
    current: link.href === "/" ? pathname === "/" : pathname.startsWith(link.href),
  }));

  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-canvas">
      <div className="mx-auto w-full max-w-6xl">
        <PrimaryNav
          brand={
            <a
              href="/"
              className="flex min-h-11 touch-manipulation items-center gap-2 text-[length:var(--text-md)] font-bold tracking-[var(--tracking-tight)] break-words text-ink no-underline"
            >
              <span className="text-accent">
                <BrandMark />
              </span>
              <span translate="no">Raptor&nbsp;OS</span>
            </a>
          }
          items={items}
          actions={
            <span className="flex items-center gap-2">
              <ThemeToggle />
            </span>
          }
        />
      </div>
    </header>
  );
}
