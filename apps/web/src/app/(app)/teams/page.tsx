import type { Metadata } from "next";
import * as React from "react";

import { EmptyState, PageHeader, SectionHeading } from "@raptor/ui";

import { getCurrentSession } from "../../../server/session";
import { getWorkspaceRosters } from "../../../server/workspace";

export const metadata: Metadata = {
  title: "Teams",
};

export const dynamic = "force-dynamic";

/**
 * Teams and their current rosters. Internal viewers see every member —
 * including profiles that stay private on the public site — because the
 * session guard and membership already establish the right to see them.
 */
export default async function TeamsPage(): Promise<React.JSX.Element> {
  const session = await getCurrentSession();
  const teams = session === null ? null : await getWorkspaceRosters(session.orgId);

  return (
    <>
      <PageHeader
        eyebrow="Competitive"
        title="Teams"
        description="Active teams, their games and divisions, and current rosters."
      />
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
        {teams === null ? (
          <EmptyState title="Teams unavailable" description="Could not load teams right now. Try again later." />
        ) : teams.length === 0 ? (
          <EmptyState title="No teams yet" description="Teams appear here once the organisation fields its first roster." />
        ) : (
          teams.map((team) => (
            <section key={team.slug} aria-labelledby={`team-${team.slug}`}>
              <SectionHeading
                id={`team-${team.slug}`}
                title={team.name}
                description={`${team.gameName}${team.divisionName === null ? "" : ` · ${team.divisionName}`} · ${team.status}`}
              />
              {team.players.length === 0 ? (
                <EmptyState title="Lineup not published" description="Members appear here once they join this team." />
              ) : (
                <ul className="mt-4 flex flex-col gap-2">
                  {team.players.map((player) => (
                    <li
                      key={player.handle}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-raised px-4 py-3"
                    >
                      <span className="min-w-0 text-[length:var(--text-sm)] font-medium break-words text-ink" translate="no">
                        {player.handle}
                      </span>
                      <span className="text-[length:var(--text-xs)] text-ink-muted">{player.role}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))
        )}
      </div>
    </>
  );
}
