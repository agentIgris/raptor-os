import {
  makeRegistry,
  makeTool,
  type AssistantRole,
  type OfflineAnswer,
  type ToolRegistry,
} from "@raptor/assistant";

import {
  getWorkspaceCompetitions,
  getWorkspaceInsights,
  getWorkspaceMembers,
  getWorkspaceOrg,
  getWorkspaceRosters,
  getWorkspaceTeams,
} from "./workspace";

/**
 * The concrete workspace tools the assistant may run.
 *
 * `packages/assistant` owns who may run what (`matrix.ts`) and how answers are
 * composed (`offline.ts`, `provider.ts`); this file owns what runs. Every tool
 * is a read against `server/workspace.ts`, so each inherits its contract for
 * free: tenant-scoped through `withOrg`, no-throw (the promise never rejects;
 * `null` means the read is temporarily unavailable), and read-only.
 *
 * There is deliberately no tool that writes. The assistant is a question
 * surface over data the caller can already see in the navigation, not a
 * second, looser entry point into the tenant database.
 */

/** Text every tool returns when the workspace read reports `null`. */
const UNAVAILABLE = "Workspace data is temporarily unavailable. Try again shortly.";

/**
 * What the client receives from `/api/assistant`. Offline mode is the default;
 * provider mode only appears when all three `ASSISTANT_*` variables are set.
 */
export interface ProviderAnswer {
  readonly mode: "provider";
  readonly question: string;
  readonly role: AssistantRole;
  readonly answer: string;
}

export type AssistantAnswer = OfflineAnswer | ProviderAnswer;

/** Build the workspace tool registry, fresh per request. */
export function buildAssistantRegistry(): ToolRegistry {
  return makeRegistry([
    makeTool({
      name: "listTeams",
      description: "List the organisation's teams with game, division, status and member count.",
      run: async ({ session }) => {
        const teams = await getWorkspaceTeams(session.orgId);
        if (teams === null) return { ok: false, error: UNAVAILABLE };
        if (teams.length === 0) return { ok: true, data: "No active teams exist yet." };
        const lines = teams.map(
          (team) =>
            `${team.name} (${team.slug}) — ${team.game}${team.division === null ? "" : `, ${team.division}`} — ${team.status}, ${team.members} members`,
        );
        return { ok: true, data: lines.join("\n") };
      },
    }),
    makeTool({
      name: "listCompetitions",
      description: "List active competitions and the next scheduled matches.",
      run: async ({ session }) => {
        const workspace = await getWorkspaceCompetitions(session.orgId);
        if (workspace.competitions === null || workspace.upcoming === null) {
          return { ok: false, error: UNAVAILABLE };
        }
        const lines: string[] = [];
        if (workspace.competitions.length === 0) {
          lines.push("No active competitions exist yet.");
        } else {
          for (const competition of workspace.competitions) {
            lines.push(
              `${competition.name} — ${competition.format}, ${competition.status}; runs ${competition.startsAt} to ${competition.endsAt}; ${competition.registrations} registrations`,
            );
          }
        }
        if (workspace.upcoming.length === 0) {
          lines.push("No upcoming matches are scheduled.");
        } else {
          for (const match of workspace.upcoming) {
            lines.push(
              `${match.team} — ${match.round === null ? "round to be scheduled" : match.round} at ${match.scheduledAt}, status ${match.status}`,
            );
          }
        }
        return { ok: true, data: lines.join("\n") };
      },
    }),
    makeTool({
      name: "getInsights",
      description: "Summarise this period's analytics: metric readings, top teams and top players.",
      run: async ({ session }) => {
        const insights = await getWorkspaceInsights(session.orgId);
        if (insights === null) return { ok: false, error: UNAVAILABLE };
        if (insights.metrics.length === 0 && insights.teams.length === 0 && insights.players.length === 0) {
          return { ok: true, data: "No analytics have been recorded for this period." };
        }
        const lines: string[] = [];
        for (const metric of insights.metrics) {
          lines.push(
            metric.value === null
              ? `${metric.key}: unavailable${metric.detail === null ? "" : ` (${metric.detail})`}`
              : `${metric.key}: ${metric.value}`,
          );
        }
        for (const team of insights.teams) {
          lines.push(
            `${team.name} — rank ${team.rank === null ? "unranked" : team.rank}, ${team.won} won, ${team.lost} lost${team.winRate === null ? "" : `, map win rate ${team.winRate}`}`,
          );
        }
        for (const player of insights.players) {
          lines.push(
            `${player.handle} — ${player.played} matches, ${player.wins} wins${player.kd === null ? "" : `, K/D ${player.kd}`}`,
          );
        }
        return { ok: true, data: lines.join("\n") };
      },
    }),
    makeTool({
      name: "getRoster",
      description: "List the rostered players of each active team.",
      run: async ({ session }) => {
        const rosters = await getWorkspaceRosters(session.orgId);
        if (rosters === null) return { ok: false, error: UNAVAILABLE };
        if (rosters.length === 0) return { ok: true, data: "No active teams have rosters yet." };
        const lines: string[] = [];
        for (const team of rosters) {
          lines.push(
            `${team.name} (${team.gameName}${team.divisionName === null ? "" : `, ${team.divisionName}`}) — ${team.status}`,
          );
          if (team.players.length === 0) {
            lines.push("  no rostered players");
          } else {
            for (const player of team.players) {
              lines.push(`  ${player.handle}${player.role === "" ? "" : ` — ${player.role}`}`);
            }
          }
        }
        return { ok: true, data: lines.join("\n") };
      },
    }),
    makeTool({
      name: "listMembers",
      description: "List the organisation's people with membership status, role and join date.",
      run: async ({ session }) => {
        const members = await getWorkspaceMembers(session.orgId);
        if (members === null) return { ok: false, error: UNAVAILABLE };
        if (members.length === 0) return { ok: true, data: "The organisation has no members yet." };
        const lines = members.map(
          (member) =>
            `${member.displayName ?? "Unnamed member"} — membership ${member.membershipStatus}${
              member.roleKey === null ? "" : `, role ${member.roleName ?? member.roleKey}`
            }${member.joinedAt === null ? "" : `, joined ${member.joinedAt}`}`,
        );
        return { ok: true, data: lines.join("\n") };
      },
    }),
    makeTool({
      name: "getOrgOverview",
      description: "Describe the organisation itself with active team and member counts.",
      run: async ({ session }) => {
        const org = await getWorkspaceOrg(session.orgId);
        const teams = await getWorkspaceTeams(session.orgId);
        const members = await getWorkspaceMembers(session.orgId);
        if (org === null || teams === null || members === null) return { ok: false, error: UNAVAILABLE };
        const lines = [
          `${org.displayName} (${org.slug}) — status ${org.status}; timezone ${org.timezone}; locale ${org.locale}; currency ${org.currency}.`,
          `${teams.length} active team(s).`,
          `${members.length} member(s).`,
        ];
        return { ok: true, data: lines.join("\n") };
      },
    }),
  ]);
}
