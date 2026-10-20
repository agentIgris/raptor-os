/**
 * Role → tool scope matrix for the workspace assistant.
 *
 * Single source of truth for what each workspace role may ask the assistant
 * to fetch. It deliberately mirrors `apps/web/src/server/nav.ts` gating (the
 * navigation is the human-facing half of the same contract) but lives here so
 * the assistant can enforce it independently and fail closed:
 *
 * - `pending` accounts see nothing (they cannot even see the workspace nav).
 * - Players/… get read-only views of the things they can already navigate to.
 * - `manager`+ see member data; `admin`/`owner` see the org-level overview.
 *
 * Nothing here is writable: every tool in the registry is read-only against
 * the tenant database, filtered through RLS by the caller.
 */

export const ASSISTANT_ROLES = [
  "pending",
  "player",
  "coach",
  "analyst",
  "manager",
  "admin",
  "owner",
] as const;

export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

export const ASSISTANT_TOOLS = [
  "listTeams",
  "listCompetitions",
  "getInsights",
  "getRoster",
  "listMembers",
  "getOrgOverview",
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number];

/**
 * Who may run each tool. Every role not listed for a tool is denied, which
 * keeps a future tool addition safe by default (nothing is reachable until a
 * role is explicitly added here).
 */
export const TOOL_SCOPES: Record<AssistantToolName, readonly AssistantRole[]> = {
  listTeams: ["player", "coach", "analyst", "manager", "admin", "owner"],
  listCompetitions: ["player", "coach", "analyst", "manager", "admin", "owner"],
  getInsights: ["coach", "analyst", "manager", "admin", "owner"],
  getRoster: ["coach", "analyst", "manager", "admin", "owner"],
  listMembers: ["manager", "admin", "owner"],
  getOrgOverview: ["admin", "owner"],
};

export function isToolAllowed(
  tool: AssistantToolName,
  role: AssistantRole,
): boolean {
  return TOOL_SCOPES[tool].includes(role);
}

export function toolsForRole(role: AssistantRole): AssistantToolName[] {
  return ASSISTANT_TOOLS.filter((tool) => isToolAllowed(tool, role));
}
