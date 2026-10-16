import type { Metadata } from "next";
import * as React from "react";

import { EmptyState, PageHeader, SectionHeading, Table, TableBody, TableCaption, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "@raptor/ui";

import { getCurrentSession } from "../../../server/session";
import { getWorkspaceCompetitions } from "../../../server/workspace";

export const metadata: Metadata = {
  title: "Competitions",
};

export const dynamic = "force-dynamic";

/**
 * Competitions, registrations and the upcoming schedule. Tables, not cards:
 * dates and counts are precise records.
 */
export default async function CompetitionsPage(): Promise<React.JSX.Element> {
  const session = await getCurrentSession();
  const data = session === null ? null : await getWorkspaceCompetitions(session.orgId);

  return (
    <>
      <PageHeader
        eyebrow="Competitive"
        title="Competitions"
        description="Events, entries and the upcoming match schedule."
      />
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
        {data === null || data.competitions === null ? (
          <EmptyState title="Competitions unavailable" description="Could not load competitions right now. Try again later." />
        ) : data.competitions.length === 0 ? (
          <EmptyState title="No competitions yet" description="Events appear here once the organisation enters its first competition." />
        ) : (
          <section aria-labelledby="events">
            <SectionHeading id="events" title="Events" description="Newest first." />
            <Table label="Competitions">
              <TableCaption>Registration counts exclude withdrawn entries.</TableCaption>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">Event</TableHeaderCell>
                  <TableHeaderCell scope="col">Format</TableHeaderCell>
                  <TableHeaderCell scope="col">Status</TableHeaderCell>
                  <TableHeaderCell scope="col">Window</TableHeaderCell>
                  <TableHeaderCell scope="col">Entries</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.competitions.map((competition) => (
                  <TableRow key={`${competition.name}-${competition.startsAt}`}>
                    <TableRowHeader>{competition.name}</TableRowHeader>
                    <TableCell>{competition.format}</TableCell>
                    <TableCell>{competition.status}</TableCell>
                    <TableCell className="tabular-nums">
                      {competition.startsAt.slice(0, 10)} → {competition.endsAt.slice(0, 10)}
                    </TableCell>
                    <TableCell className="tabular-nums">{competition.registrations}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )}
        {data?.upcoming === null || data?.upcoming === undefined || data.upcoming.length === 0 ? null : (
          <section aria-labelledby="upcoming">
            <SectionHeading id="upcoming" title="Upcoming matches" description="Scheduled, soonest first." />
            <Table label="Upcoming matches">
              <TableCaption>Only scheduled, unarchived fixtures.</TableCaption>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">Team</TableHeaderCell>
                  <TableHeaderCell scope="col">Round</TableHeaderCell>
                  <TableHeaderCell scope="col">Scheduled</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.upcoming.map((match, index) => (
                  <TableRow key={`${match.team}-${match.scheduledAt}-${index}`}>
                    <TableRowHeader>{match.team}</TableRowHeader>
                    <TableCell>{match.round ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">{match.scheduledAt}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )}
      </div>
    </>
  );
}
