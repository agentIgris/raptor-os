import { Badge, PageFooter, PrimaryNav, SkipLink, type NavItem } from "@raptor/ui";
import { redirect } from "next/navigation";
import * as React from "react";

import { getCurrentSession } from "../../server/session";

const NAV: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", current: true },
  { href: "/", label: "Overview" },
  { href: "/sign-in", label: "Sign in" },
];

/**
 * Layout for authenticated routes.
 *
 * THE GUARD FAILS CLOSED. `getCurrentSession()` returning `null` — no cookie,
 * an expired or forged cookie, or an environment that cannot validate one —
 * all mean the same thing here: redirect to sign-in. There is no branch that
 * renders the dashboard's contents without a resolved session, and no
 * environment variable that relaxes it. A security check that fails open on an
 * internal error is not a check, and this is the control that the legacy
 * project's tenant isolation depended on and did not have.
 *
 * It is a `redirect`, not a `notFound()` or a 403 page: a redirect is a 307,
 * so the browser never renders or caches the protected HTML at the protected
 * URL.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.JSX.Element> {
  const session = await getCurrentSession();

  if (session === null) {
    redirect("/sign-in?next=/dashboard");
  }

  return (
    <>
      <SkipLink href="#main" />
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas">
        <PrimaryNav
          brand={
            <a
              href="/dashboard"
              className="flex min-h-11 items-center gap-2 text-[length:var(--text-md)] font-bold tracking-[var(--tracking-tight)] text-ink no-underline"
            >
              <span aria-hidden="true">🦖</span>
              Raptor&nbsp;OS
            </a>
          }
          items={NAV}
        />
        {/*
          Session summary.

          Rendered as text, not as a badge colour, and the two facts a support
          engineer needs are both present: the role (which decides what the user
          may do) and whether MFA is enrolled (which is what locks privileged
          roles out). No token, no session id, no cookie value — there is
          nothing here that should be read out over the user's shoulder, and
          nothing that would be dangerous in a screenshot.
        */}
        <p className="flex flex-wrap items-center gap-2 border-t border-hairline px-4 py-2 text-[length:var(--text-xs)] text-ink-muted md:px-6">
          <span>{session.email}</span>
          <Badge tone={session.role === "pending" ? "warning" : "accent"}>{session.role}</Badge>
          <Badge tone={session.twoFactorEnabled ? "success" : "neutral"}>
            {session.twoFactorEnabled ? "MFA enrolled" : "MFA not enrolled"}
          </Badge>
        </p>
      </header>

      <main id="main" tabIndex={-1} className="flex-1 px-4 py-8 md:px-8">
        {children}
      </main>

      <PageFooter>
        <p>Tenant resolved from the session. Never from a request parameter.</p>
      </PageFooter>
    </>
  );
}