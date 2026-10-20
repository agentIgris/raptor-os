import { ALL_ROLES, type Role } from "@raptor/auth/roles";

/**
 * Workspace navigation map.
 *
 * Two independent filters apply, in this order:
 *
 * 1. ROLE. `roles` names who may see the item. This is UX only — every read
 *    underneath is membership- and RLS-enforced, so a hidden link is
 *    convenience while a forged request is still refused.
 * 2. IMPLEMENTED. Only routes that exist render. A nav item pointing at an
 *    unbuilt route is a 404 with extra steps (Task 8 flips these flags as
 *    modules land).
 */

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly implemented: boolean;
}

export interface NavSection {
  readonly title: string;
  readonly items: readonly NavItem[];
}

interface NavEntry extends NavItem {
  readonly roles: readonly Role[];
}

interface NavGroup {
  readonly title: string;
  readonly entries: readonly NavEntry[];
}

const MANAGERS: readonly Role[] = ["manager", "admin", "owner"];
const EVERYONE: readonly Role[] = [...ALL_ROLES];

const NAV: readonly NavGroup[] = [
  {
    title: "Overview",
    entries: [
      { href: "/dashboard", label: "Dashboard", implemented: true, roles: EVERYONE },
      { href: "/assistant", label: "Assistant", implemented: true, roles: ["player", "coach", "analyst", ...MANAGERS] },
    ],
  },
  {
    title: "Competitive",
    entries: [
      { href: "/teams", label: "Teams", implemented: true, roles: EVERYONE },
      { href: "/competitions", label: "Competitions", implemented: true, roles: EVERYONE },
    ],
  },
  {
    title: "People",
    entries: [{ href: "/members", label: "Members", implemented: true, roles: MANAGERS }],
  },
  {
    title: "Content",
    entries: [
      { href: "/content", label: "News & media", implemented: true, roles: MANAGERS },
      { href: "/partners", label: "Partners", implemented: true, roles: MANAGERS },
    ],
  },
  {
    title: "Insights",
    entries: [{ href: "/insights", label: "Analytics", implemented: true, roles: ["coach", "analyst", ...MANAGERS] }],
  },
  {
    title: "Settings",
    entries: [{ href: "/settings", label: "Organisation", implemented: true, roles: ["admin", "owner"] }],
  },
];

/** Sections with at least one implemented item the role may see. Pure. */
export function buildWorkspaceNav(role: string): NavSection[] {
  const sections: NavSection[] = [];
  for (const group of NAV) {
    const items = group.entries
      .filter((entry) => entry.implemented && (entry.roles as readonly string[]).includes(role))
      .map((entry): NavItem => ({ href: entry.href, label: entry.label, implemented: entry.implemented }));
    if (items.length > 0) sections.push({ title: group.title, items });
  }
  return sections;
}

/** Breadcrumb label for a workspace path. Unknown paths say so. */
export function sectionLabelFor(pathname: string): string {
  for (const group of NAV) {
    for (const entry of group.entries) {
      if (entry.href !== "/" && pathname.startsWith(entry.href)) return entry.label;
    }
  }
  return "Workspace";
}
