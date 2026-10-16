import * as React from "react";

import type { NavSection } from "../../server/nav";

import { SectionCrumb } from "./crumbs";
import { MenuButton } from "./menu-button";
import { UserMenu } from "./user-menu";

/**
 * Workspace top bar: mobile menu, current-section breadcrumb, session menu.
 * Sticky so sign-out is always one tap away — an authenticated user can
 * always leave, on any viewport.
 */
export function Topbar({
  sections,
  email,
  role,
  twoFactorEnabled,
}: {
  readonly sections: readonly NavSection[];
  readonly email: string;
  readonly role: string;
  readonly twoFactorEnabled: boolean;
}): React.JSX.Element {
  return (
    <div className="sticky top-0 z-40 border-b border-hairline bg-canvas">
      <div className="relative mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-8">
        <span className="flex min-w-0 items-center gap-3">
          <MenuButton sections={sections} />
          <SectionCrumb />
        </span>
        <UserMenu email={email} role={role} twoFactorEnabled={twoFactorEnabled} />
      </div>
    </div>
  );
}
