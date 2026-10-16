import * as React from "react";

import { Badge, EmptyState, SectionHeading, Table, TableBody, TableCaption, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "@raptor/ui";
import type { PublicResult } from "../../server/public";

function placementLabel(result: PublicResult): string {
  if (result.placement !== null) return `#${result.placement}`;
  if (result.outcome === "win") return "Win";
  if (result.outcome === "loss") return "Loss";
  if (result.outcome === "draw") return "Draw";
  return "Played";
}

/**
 * Verified results only — the query already excludes unverified rows, because
 * an unverified result is a rumour. Tables, not charts: exact placements and
 * dates.
 */
export function Results({ data }: { data: readonly PublicResult[] | null }): React.JSX.Element {
  return (
    <section aria-labelledby="results" id="results" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10 md:px-8">
      <SectionHeading
        id="results"
        title="Results & honours"
        description="Verified placements from completed competition."
      />
      {data === null ? (
        <EmptyState title="Results unavailable" description="Could not load results right now. Try again later." />
      ) : data.length === 0 ? (
        <EmptyState
          title="No verified results yet"
          description="Placements appear here once competitions complete and results are verified."
        />
      ) : (
        <Table label="Verified results">
          <TableCaption>Most recent verified placements first.</TableCaption>
          <TableHead>
            <TableRow>
              <TableHeaderCell scope="col">Event</TableHeaderCell>
              <TableHeaderCell scope="col">Team</TableHeaderCell>
              <TableHeaderCell scope="col">Placement</TableHeaderCell>
              <TableHeaderCell scope="col">Date</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.map((row, index) => (
              <TableRow key={`${row.event}-${row.team}-${row.date}-${index}`}>
                <TableRowHeader>{row.event}</TableRowHeader>
                <TableCell>{row.team}</TableCell>
                <TableCell>
                  <Badge tone={row.placement === 1 ? "success" : "neutral"}>{placementLabel(row)}</Badge>
                </TableCell>
                <TableCell className="tabular-nums">{row.date}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
