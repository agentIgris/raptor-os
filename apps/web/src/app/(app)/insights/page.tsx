import type { Metadata } from "next";
import * as React from "react";

import { EmptyState, PageHeader, SectionHeading, Table, TableBody, TableCaption, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "@raptor/ui";

import { getCurrentSession } from "../../../server/session";
import { getWorkspaceInsights } from "../../../server/workspace";

export const metadata: Metadata = {
  title: "Analytics",
};

export const dynamic = "force-dynamic";

/**
 * Decision-relevant numbers from the analytics functions — tables, not
 * charts, until a metric earns a visualization. Fixed 30-day window, stated
 * on the page: an open-ended window would hide unbounded history.
 */
export default async function InsightsPage(): Promise<React.JSX.Element> {
  const session = await getCurrentSession();
  const insights = session === null ? null : await getWorkspaceInsights(session.orgId);

  return (
    <>
      <PageHeader
        eyebrow="Insights"
        title="Analytics"
        description="Metric summary, top teams and player leaderboard for the last 30 days."
      />
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
        {insights === null ? (
          <EmptyState title="Analytics unavailable" description="Could not compute analytics right now. Try again later." />
        ) : (
          <>
            <section aria-labelledby="metric-summary">
              <SectionHeading id="metric-summary" title="Metric summary" description="Numerators, denominators and computed values." />
              {insights.metrics.length === 0 ? (
                <EmptyState title="No metrics in window" description="Metrics appear once matches fall inside the window." />
              ) : (
                <Table label="Metric summary">
                  <TableCaption>Statuses other than ok carry their reason.</TableCaption>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell scope="col">Metric</TableHeaderCell>
                      <TableHeaderCell scope="col">Status</TableHeaderCell>
                      <TableHeaderCell scope="col">Value</TableHeaderCell>
                      <TableHeaderCell scope="col">Detail</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {insights.metrics.map((metric) => (
                      <TableRow key={metric.key}>
                        <TableRowHeader translate="no">{metric.key}</TableRowHeader>
                        <TableCell>{metric.status}</TableCell>
                        <TableCell className="tabular-nums">{metric.value ?? "—"}</TableCell>
                        <TableCell>{metric.detail ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
            <section aria-labelledby="top-teams">
              <SectionHeading id="top-teams" title="Top teams" description="By map win rate, top 10." />
              {insights.teams.length === 0 ? (
                <EmptyState title="No ranking in window" description="Rankings appear once matches complete." />
              ) : (
                <Table label="Top teams">
                  <TableCaption>Rank 1 first.</TableCaption>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell scope="col">Rank</TableHeaderCell>
                      <TableHeaderCell scope="col">Team</TableHeaderCell>
                      <TableHeaderCell scope="col">Won</TableHeaderCell>
                      <TableHeaderCell scope="col">Lost</TableHeaderCell>
                      <TableHeaderCell scope="col">Map win rate</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {insights.teams.map((team) => (
                      <TableRow key={team.name}>
                        <TableRowHeader className="tabular-nums">{team.rank ?? "—"}</TableRowHeader>
                        <TableCell>{team.name}</TableCell>
                        <TableCell className="tabular-nums">{team.won}</TableCell>
                        <TableCell className="tabular-nums">{team.lost}</TableCell>
                        <TableCell className="tabular-nums">{team.winRate ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
            <section aria-labelledby="player-board">
              <SectionHeading id="player-board" title="Player leaderboard" description="Top 10 by rank." />
              {insights.players.length === 0 ? (
                <EmptyState title="No player data in window" description="Leaderboard rows appear once performances are recorded." />
              ) : (
                <Table label="Player leaderboard">
                  <TableCaption>Handles shown; underlying rows are keyed by person.</TableCaption>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell scope="col">Player</TableHeaderCell>
                      <TableHeaderCell scope="col">Played</TableHeaderCell>
                      <TableHeaderCell scope="col">Wins</TableHeaderCell>
                      <TableHeaderCell scope="col">K/D</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {insights.players.map((player) => (
                      <TableRow key={player.handle}>
                        <TableRowHeader translate="no">{player.handle}</TableRowHeader>
                        <TableCell className="tabular-nums">{player.played}</TableCell>
                        <TableCell className="tabular-nums">{player.wins}</TableCell>
                        <TableCell className="tabular-nums">{player.kd ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}
