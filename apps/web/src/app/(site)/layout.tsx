import type { Metadata } from "next";
import { Oswald } from "next/font/google";

import { PageFooter, SkipLink } from "@raptor/ui";

import { SiteHeader } from "../../components/site-header";

/**
 * Display face for the public site only.
 *
 * Oswald (condensed, 500–700) carries headlines; body and UI stay on the
 * system sans. Scoped to the `(site)` layout so the workspace keeps the OS
 * look. `next/font` self-hosts the files, which keeps the font CSP-safe
 * (`font-src 'self'` in `src/proxy.ts`).
 */
const display = Oswald({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const appUrl = process.env["NEXT_PUBLIC_APP_URL"];

export const metadata: Metadata = {
  ...(appUrl === undefined || appUrl === "" ? {} : { metadataBase: new URL(appUrl) }),
  title: {
    default: "Raptor Esports",
    template: "%s — Raptor Esports",
  },
  description:
    "Raptor Esports: competitive rosters, results, news and recruitment. Verified content only — no invented stats.",
  // The root layout defaults the whole product to noindex (correct for the
  // authenticated workspace). The public site overrides it back: fan pages
  // are meant to be found.
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "Raptor Esports",
    images: [
      {
        url: "/placeholders/og-default.svg",
        width: 1200,
        height: 630,
        alt: "Raptor Esports",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/placeholders/og-default.svg"],
  },
};

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
      <main id="main" tabIndex={-1} className={`${display.variable} flex min-w-0 flex-1 flex-col`}>
        {children}
      </main>
      <PageFooter>
        <p>
          <span translate="no">Raptor Esports</span> — rosters, results and news. Verified content only.
        </p>
      </PageFooter>
    </>
  );
}
