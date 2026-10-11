import type { Metadata, Viewport } from "next";
import * as React from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Raptor OS",
    template: "%s · Raptor OS",
  },
  description:
    "One system of record for a competitive esports organisation: prize allocation, sponsor obligations, rosters and money.",
};

export const viewport: Viewport = {
  // Deliberately NOT `maximumScale: 1` or `userScalable: false`. Pinching to
  // zoom is a WCAG 1.4.4 (Resize Text) requirement and blocking it is a defect,
  // not a mobile optimisation.
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e14" },
  ],
};

/**
 * The document shell.
 *
 * `lang="en"` is not decoration. A screen reader picks its pronunciation rules
 * and its synthetic voice from the document language, and a page with no `lang`
 * is announced in whatever language the user last happened to be reading — axe
 * core's `html-has-lang` rule fails without it and it is one of the two checks
 * most often red in a real audit.
 *
 * This layout deliberately contains NO landmarks. Landmarks live in the route
 * groups, because `/sign-in` has no primary navigation and putting one in the
 * root layout means every route inherits a nav that does not apply to it.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-dvh flex-col bg-canvas text-ink antialiased">
        {children}
      </body>
    </html>
  );
}