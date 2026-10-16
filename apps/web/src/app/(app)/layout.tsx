import { redirect } from "next/navigation";
import * as React from "react";

import { WorkspaceShell } from "../../components/app/workspace-shell";
import { buildWorkspaceNav } from "../../server/nav";
import { getActiveOrg } from "../../server/orgs";
import { getRecentOrgs } from "../../server/org-actions";
import { getCurrentSession } from "../../server/session";

/**
 * Layout for authenticated routes.
 *
 * THE GUARD FAILS CLOSED (unchanged). `getCurrentSession()` returning `null`
 * — no cookie, an expired or forged cookie, or an environment that cannot
 * validate one — all mean the same thing here: redirect to sign-in. It is a
 * `redirect`, not a `notFound()` or a 403 page: a 307, so the browser never
 * renders or caches the protected HTML at the protected URL.
 *
 * Inside the guard, everything is preference, not permission: the role
 * filters which sections are OFFERED, the active org names the tenant, and
 * every read underneath stays membership- and RLS-enforced.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.JSX.Element> {
  const session = await getCurrentSession();

  if (session === null) {
    redirect("/sign-in?next=/dashboard");
  }

  const [org, recents] = await Promise.all([getActiveOrg(session.orgId), getRecentOrgs()]);

  return (
    <WorkspaceShell
      orgId={session.orgId}
      orgName={org?.displayName ?? "No organisation"}
      sections={buildWorkspaceNav(session.role)}
      recents={recents}
      email={session.email}
      role={session.role}
      twoFactorEnabled={session.twoFactorEnabled}
    >
      {children}
    </WorkspaceShell>
  );
}
