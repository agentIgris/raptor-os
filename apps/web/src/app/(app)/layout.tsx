import { PageFooter, SkipLink } from "@raptor/ui";
import { redirect } from "next/navigation";
import * as React from "react";

import { AppHeader } from "../../components/app-header";
import { getCurrentSession } from "../../server/session";

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
      <AppHeader email={session.email} role={session.role} twoFactorEnabled={session.twoFactorEnabled} />

      <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
        {children}
      </main>

      <PageFooter>
        <p>Tenant resolved from the session. Never from a request parameter.</p>
      </PageFooter>
    </>
  );
}
