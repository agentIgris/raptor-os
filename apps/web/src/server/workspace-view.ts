import type { WorkspaceMemberRow } from "./workspace";

export interface MemberView {
  readonly displayName: string;
  readonly membershipStatus: string;
  readonly roles: readonly string[];
  readonly joinedAt: string | null;
}

/**
 * Merge membership/role rows into one row per person. Pure: the query returns
 * one row per (person, role), and the table wants one row per person. A
 * member with no current role keeps their membership row with no roles —
 * membership and role assignment are different facts.
 */
export function mergeMembers(rows: readonly WorkspaceMemberRow[]): MemberView[] {
  const members = new Map<string, MemberView & { roles: string[] }>();
  for (const row of rows) {
    const key = `${row.displayName ?? ""}|${row.joinedAt ?? ""}`;
    let member = members.get(key);
    if (member === undefined) {
      member = {
        displayName: row.displayName ?? "Unnamed member",
        membershipStatus: row.membershipStatus,
        roles: [],
        joinedAt: row.joinedAt,
      };
      members.set(key, member);
    }
    if (row.roleName !== null && row.roleName !== "" && !member.roles.includes(row.roleName)) {
      member.roles.push(row.roleName);
    }
  }
  return [...members.values()];
}
