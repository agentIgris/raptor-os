import * as React from "react";

import { Main, PageFooter, SkipLink } from "@raptor/ui";

import type { NavSection } from "../../server/nav";
import type { RecentOrg } from "../../server/org-actions";

import { OrgSwitcher } from "./org-switcher";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

/**
 * Authenticated workspace shell: sidebar + topbar + content.
 *
 * Same tokens, spacing and landmarks as the public shell — the console reads
 * as the same product, not a second design. The sidebar owns viewports `lg`
 * and up; below that the top bar's menu button carries the same sections.
 */
export function WorkspaceShell({
  orgId,
  orgName,
  sections,
  recents,
  email,
  role,
  twoFactorEnabled,
  children,
}: {
  readonly orgId: string | null;
  readonly orgName: string;
  readonly sections: readonly NavSection[];
  readonly recents: readonly RecentOrg[];
  readonly email: string;
  readonly role: string;
  readonly twoFactorEnabled: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <SkipLink href="#main" />
      <div className="flex min-h-dvh">
        <aside className="hidden w-64 shrink-0 border-r border-hairline bg-canvas lg:flex lg:flex-col" aria-label="Workspace sidebar">
          <Sidebar
            sections={sections}
            switcher={<OrgSwitcher currentOrgId={orgId} currentOrgName={orgName} recents={recents} />}
          />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar sections={sections} email={email} role={role} twoFactorEnabled={twoFactorEnabled} />
          <Main>{children}</Main>
          <PageFooter>
            <p>
              Tenant resolved from the session. Never from a request parameter.
            </p>
          </PageFooter>
        </div>
      </div>
    </>
  );
}
