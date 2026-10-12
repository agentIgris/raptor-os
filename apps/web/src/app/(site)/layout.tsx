import { PageFooter, SkipLink } from "@raptor/ui";

import { SiteHeader } from "../../components/site-header";

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
      <SiteHeader />
      <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
        {children}
      </main>
      <PageFooter>
        <p>
          <span translate="no">Raptor OS</span> — a multi-tenant operating system for competitive esports
          organisations.
        </p>
      </PageFooter>
    </>
  );
}
