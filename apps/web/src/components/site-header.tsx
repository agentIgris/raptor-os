"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import * as React from "react";

import { Button, PrimaryNav, ThemeToggle } from "@raptor/ui";

export interface SiteHeaderProps {
  /**
   * Show the Partners nav item. False until Task 6 reads approved partner
   * content — the brief forbids a partners entry with nothing behind it.
   */
  readonly showPartners?: boolean;
  /**
   * Show the Join CTA. False until Task 6 reads `cms_recruitment.open` —
   * a recruitment button with closed recruitment strands the applicant.
   */
  readonly recruitmentOpen?: boolean;
}

/**
 * Section anchors on the public home. Standalone detail routes do not exist
 * yet, and a nav item linking to a 404 is worse than an anchor — when the
 * routes land, these become paths again and the `current` logic below already
 * handles path prefixes.
 */
const CORE_LINKS = [
  { href: "/#teams", label: "Teams" },
  { href: "/#results", label: "Results" },
  { href: "/#news", label: "News & Media" },
  { href: "/#about", label: "About" },
] as const;

/**
 * Public site header.
 *
 * Client-rendered for one reason only: the active destination. `usePathname`
 * marks the link whose href matches the current route, so a screen-reader
 * user is never told they are somewhere they are not.
 *
 * The brand is the placeholder logo (`/placeholders/logo.svg`, 512px source
 * rendered at 32px) plus the organisation wordmark — no invented marks. The
 * Join call-to-action lives in `actions` (always visible, never buried in the
 * mobile disclosure); Sign in stays a quiet last nav item.
 */
export function SiteHeader({ showPartners = false, recruitmentOpen = false }: SiteHeaderProps): React.JSX.Element {
  const pathname = usePathname();
  const items = [
    ...CORE_LINKS,
    ...(showPartners ? [{ href: "/partners", label: "Partners" } as const] : []),
    { href: "/sign-in", label: "Sign in" },
  ].map((link) => ({
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
              <Image
                src="/placeholders/logo.svg"
                alt="Raptor Esports logo"
                width={32}
                height={32}
                className="h-8 w-8"
              />
              <span translate="no">Raptor&nbsp;Esports</span>
            </a>
          }
          items={items}
          actions={
            <span className="flex items-center gap-2">
              {recruitmentOpen ? (
                <Button asChild>
                  <a href="/join">Join Raptor</a>
                </Button>
              ) : null}
              <ThemeToggle />
            </span>
          }
        />
      </div>
    </header>
  );
}

