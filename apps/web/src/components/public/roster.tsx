import Image from "next/image";
import * as React from "react";

import { Badge, EmptyState, SectionHeading } from "@raptor/ui";
import type { PublicTeam } from "../../server/public";

const ROLE_TONE = {
  captain: "info",
  player: "neutral",
  substitute: "neutral",
  academy: "neutral",
  flex: "neutral",
} as const;

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <section aria-labelledby="teams" id="teams" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10 md:px-8">
      <SectionHeading
        id="teams"
        title="Teams & rosters"
        description="Active teams and the players fielded for them."
      />
      {children}
    </section>
  );
}

function TeamPlayers({ players }: { players: PublicTeam["players"] }): React.JSX.Element {
  if (players.length === 0) {
    return <EmptyState title="Roster pending" description="This team's lineup has not been published." />;
  }
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {players.map((player) => (
        <li key={player.handle} className="min-w-0 text-center">
          <Image
            src="/placeholders/player-portrait.svg"
            alt={`Portrait placeholder for ${player.handle}`}
            width={600}
            height={600}
            sizes="(max-width: 640px) 50vw, 20vw"
            className="aspect-square w-full rounded-lg border border-hairline object-cover"
          />
          <p className="mt-2 truncate text-[length:var(--text-sm)] font-medium text-ink" translate="no">
            {player.handle}
          </p>
          <Badge tone={ROLE_TONE[player.role as keyof typeof ROLE_TONE] ?? "neutral"}>{player.role}</Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * Featured team plus roster grid. Handles come only from `public`-visibility
 * profiles (enforced in the query); portraits are placeholders until approved
 * player photos land in the manifest.
 */
export function Roster({ data }: { data: readonly PublicTeam[] | null }): React.JSX.Element {
  if (data === null) {
    return (
      <Shell>
        <EmptyState title="Roster unavailable" description="Could not load the roster right now. Try again later." />
      </Shell>
    );
  }
  const featured = data[0];
  if (featured === undefined) {
    return (
      <Shell>
        <EmptyState
          title="No public roster yet"
          description="Players appear here once divisions publish their rosters."
        />
      </Shell>
    );
  }
  const rest = data.slice(1);
  return (
    <Shell>
      <div className="mt-6 flex flex-col gap-8">
        <article aria-labelledby="featured-team" className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <p className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-faint uppercase">
              Featured team · {featured.gameName}
            </p>
            <h3 id="featured-team" className="font-display mt-2 text-balance text-[length:var(--text-3xl)] leading-[var(--leading-tight)] font-semibold break-words text-ink">
              {featured.name}
            </h3>
            <p className="mt-2 text-[length:var(--text-sm)] text-ink-muted">
              {featured.divisionName ?? "Unplaced division"} · {featured.status}
            </p>
          </div>
          <TeamPlayers players={featured.players} />
        </article>
        {rest.length > 0 ? (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {rest.map((team) => (
              <li key={team.slug} className="min-w-0 rounded-lg border border-hairline bg-raised p-4">
                <p className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-faint uppercase">
                  {team.gameName}
                  {team.divisionName === null ? "" : ` · ${team.divisionName}`}
                </p>
                <p className="mt-1 text-[length:var(--text-md)] font-semibold text-ink">{team.name}</p>
                <p className="mt-1 text-[length:var(--text-sm)] text-ink-muted">
                  {team.players.length === 0
                    ? "Lineup not published."
                    : team.players.map((player) => player.handle).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Shell>
  );
}
