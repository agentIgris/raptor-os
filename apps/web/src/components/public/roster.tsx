import Image from "next/image";
import * as React from "react";

import { Badge, EmptyState, SectionHeading } from "@raptor/ui";
import type { PublicTeam } from "../../server/public";

import { playerPortrait } from "./art";

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
      {players.map((player) => {
        const portrait = playerPortrait(player.handle);
        return (
          <li key={player.handle} className="min-w-0 text-center">
            <Image
              src={portrait.src}
              alt={portrait.real ? `Portrait of ${player.handle}` : `Portrait placeholder for ${player.handle}`}
              width={600}
              height={600}
              sizes="(max-width: 640px) 50vw, 20vw"
              className="dc-hard-violet aspect-square w-full rounded-lg border-2 border-[var(--dc-line)] bg-panel object-cover"
            />
            <p className="mt-2 truncate text-[length:var(--text-sm)] font-medium text-[var(--dc-ink)]" translate="no">
              {player.handle}
            </p>
            <Badge
              tone={ROLE_TONE[player.role as keyof typeof ROLE_TONE] ?? "neutral"}
              className={player.role === "captain" ? "dc-fill-cyan" : "dc-fill-violet"}
            >
              {player.role}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Featured team plus roster grid. Handles come only from `public`-visibility
 * profiles (enforced in the query); portraits are placeholders until approved
 * player photos land in the manifest.
 *
 * EVERY TEAM GETS ITS PLAYERS' PORTRAITS, not only the featured one. The
 * featured card used to be the only place a player was rendered as an image,
 * and every other team was a line of handles joined by dots — so a roster of
 * four players with four committed portraits showed none of them, and the page
 * read as a list of names rather than a squad. Measured against the seeded
 * data: the featured card (the Academy, one player) showed a portrait, and the
 * Main team (four players) showed text.
 *
 * The featured card is also the first team THAT HAS PLAYERS, not the first team
 * by name. The two used to disagree: the Academy sorts first, and the squad
 * that carries the division and the portraits sorted second — so the headline
 * card showed the empty team and the real squad was a line of handles.
 */
export function Roster({ data }: { data: readonly PublicTeam[] | null }): React.JSX.Element {
  if (data === null) {
    return (
      <Shell>
        <EmptyState title="Roster unavailable" description="Could not load the roster right now. Try again later." />
      </Shell>
    );
  }
  const featured = data.find((team) => team.players.length > 0) ?? data[0];
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
  const rest = data.filter((team) => team.slug !== featured.slug);
  return (
    <Shell>
      <div className="mt-6 flex flex-col gap-8">
        <article
          aria-labelledby="featured-team"
          className="dc-bg-panel dc-grid dc-hard-hot grid grid-cols-1 gap-6 rounded-lg border-2 border-[var(--dc-line)] p-6 lg:grid-cols-2"
        >
          <div>
            <p className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-[var(--dc-cyan)] uppercase">
              Featured team · {featured.gameName}
            </p>
            <h3
              id="featured-team"
              className="font-display mt-2 text-balance text-[length:var(--text-3xl)] leading-[var(--leading-tight)] font-extrabold break-words"
            >
              <span className="dc-sun dc-text-undershadow">{featured.name}</span>
            </h3>
            <p className="mt-2 text-[length:var(--text-sm)] text-[var(--dc-ink-dim)]">
              {featured.divisionName ?? "Unplaced division"} · {featured.status}
            </p>
          </div>
          <TeamPlayers players={featured.players} />
        </article>
        {rest.length > 0 ? (
          <ul className="flex flex-col gap-4">
            {rest.map((team, index) => (
              <li
                key={team.slug}
                className={`dc-bg-panel ${index % 2 === 0 ? "dc-hard-cyan" : "dc-hard-lime"} min-w-0 rounded-lg border-2 border-[var(--dc-line)] p-4`}
              >
                <p className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-[var(--dc-ink-faint)] uppercase">
                  {team.gameName}
                  {team.divisionName === null ? "" : ` · ${team.divisionName}`}
                </p>
                <p className="mt-1 text-[length:var(--text-md)] font-semibold text-[var(--dc-ink)]">{team.name}</p>
                {team.players.length === 0 ? (
                  <p className="mt-1 text-[length:var(--text-sm)] text-[var(--dc-ink-dim)]">Lineup not published.</p>
                ) : (
                  <div className="mt-3">
                    <TeamPlayers players={team.players} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Shell>
  );
}
