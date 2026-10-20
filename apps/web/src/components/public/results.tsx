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
    <section
      aria-labelledby="results"
      id="results"
      className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10 md:px-8"
    >
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
        <Table
          label="Verified results"
          wrapperClassName="dc-bg-panel dc-hard-violet mt-6 rounded-lg border-2 border-[var(--dc-line)]"
        >
          <TableCaption className="text-[var(--dc-ink-faint)]">Most recent verified placements first.</TableCaption>
          <TableHead className="bg-transparent">
            <TableRow className="border-b-2 border-b-[var(--dc-line)]">
              <TableHeaderCell className="font-super bg-transparent border-b-2 border-b-[var(--dc-line)] text-[var(--dc-cyan)]">Event</TableHeaderCell>
              <TableHeaderCell className="font-super bg-transparent border-b-2 border-b-[var(--dc-line)] text-[var(--dc-cyan)]">Team</TableHeaderCell>
              <TableHeaderCell className="font-super bg-transparent border-b-2 border-b-[var(--dc-line)] text-[var(--dc-cyan)]">Placement</TableHeaderCell>
              <TableHeaderCell className="font-super bg-transparent border-b-2 border-b-[var(--dc-line)] text-[var(--dc-cyan)]">Date</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data.map((row, index) => (
              <TableRow key={`${row.event}-${row.team}-${row.date}-${index}`} className="border-b-[var(--dc-line)]">
                <TableRowHeader className="font-display border-b-[var(--dc-line)] font-bold text-[var(--dc-ink)]">{row.event}</TableRowHeader>
                <TableCell className="border-b-[var(--dc-line)] text-[var(--dc-ink-dim)]">{row.team}</TableCell>
                <TableCell className="border-b-[var(--dc-line)]">
                  <Badge
                    tone={row.placement === 1 ? "success" : "neutral"}
                    className={row.placement === 1 ? "dc-fill-sun" : "dc-fill-violet"}
                  >
                    {placementLabel(row)}
                  </Badge>
                </TableCell>
                <TableCell className="border-b-[var(--dc-line)] text-[var(--dc-ink-dim)] tabular-nums">
                  {row.date}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
