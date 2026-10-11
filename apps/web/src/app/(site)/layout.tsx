import { PageFooter, PrimaryNav, SkipLink, type NavItem } from "@raptor/ui";

const NAV: readonly NavItem[] = [
  { href: "/", label: "Overview", current: true },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/sign-in", label: "Sign in" },
];

/**
 * Layout for unauthenticated routes.
 *
 * Owns every landmark the page has:
 *
 *  - `<header>` is the `banner` landmark (implicit for a top-level `<header>`).
 *  - `<nav aria-label="Primary">` is the navigation landmark, named so it can
 *    be told apart from any secondary nav a page grows later.
 *  - `<main>` is the `main` landmark, and carries `id="main"` to match the
 *    skip link's `href`.
 *  - `<footer>` is `contentinfo`.
 *
 * The skip link is rendered BEFORE `<header>` so it is the first tab stop on
 * the page. Putting it after the nav — the usual placement — means a keyboard
 * user has already tabbed through the navigation they were trying to skip.
 */
export default function SiteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <>
      <SkipLink href="#main" />
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas">
        <PrimaryNav
          brand={
            <a
              href="/"
              className="flex min-h-11 items-center gap-2 text-[length:var(--text-md)] font-bold tracking-[var(--tracking-tight)] text-ink no-underline"
            >
              <span aria-hidden="true">🦖</span>
              Raptor&nbsp;OS
            </a>
          }
          items={NAV}
        />
      </header>
      <main id="main" tabIndex={-1} className="flex-1 px-4 py-8 md:px-8">
        {children}
      </main>
      <PageFooter>
        <p>
          Raptor OS — a multi-tenant operating system for competitive esports organisations.
        </p>
      </PageFooter>
    </>
  );
}