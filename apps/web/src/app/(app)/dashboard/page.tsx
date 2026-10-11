import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  Stat,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
} from "@raptor/ui";
import type { Metadata } from "next";
import * as React from "react";

import { buildPrizePreview, buildRosterPreview } from "../../../server/dashboard";
import { formatMoney } from "../../../server/format";

export const metadata: Metadata = {
  title: "Dashboard",
};

export const dynamic = "force-dynamic";

const TONE_BY_MOVEMENT = {
  promote: "success",
  retain: "info",
  demote: "danger",
  exempt: "neutral",
} as const;

const TONE_BY_ATTENDANCE = {
  present: "success",
  late: "warning",
  absent: "danger",
} as const;

/**
 * The dashboard.
 *
 * The page is a server component: it reads no client state, ships no
 * JavaScript for the data itself, and cannot leak a token into a bundle
 * because there is no bundle to leak one into.
 *
 * Access control is the parent layout's job, not this file's. Repeating the
 * session check here would be two checks that could drift; the layout's guard
 * is the one, and this page cannot render without having passed it.
 */
export default function DashboardPage(): React.JSX.Element {
  const prize = buildPrizePreview();
  const roster = buildRosterPreview();

  const present = roster.filter((player) => player.attendance === "present").length;
  const attendancePercent = roster.length === 0 ? 0 : Math.round((present / roster.length) * 100);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Dashboard"
        description="Prize position, attendance and roster movement for the current cycle."
      />

      <div className="flex flex-col gap-8">
        <Alert tone={prize.variance.isZero() ? "success" : "danger"} politeness="assertive">
          <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)] font-medium">
            {prize.variance.isZero()
              ? "Reconciliation holds: allocations sum exactly to the net pool."
              : `Reconciliation variance of ${formatMoney(prize.variance)} must be resolved before this pool is payable.`}
          </p>
        </Alert>

        <section aria-labelledby="position" className="flex flex-col gap-4">
          <h2
            id="position"
            className="text-[length:var(--text-xl)] leading-[var(--leading-snug)] font-semibold tracking-[var(--tracking-tight)]"
          >
            Prize position
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Gross" value={formatMoney(prize.gross)} hint={`${prize.currency}, as received.`} />
            <Stat label="Deductions" value={formatMoney(prize.deductions)} hint="Withheld by the organiser." />
            <Stat label="Tax" value={formatMoney(prize.tax)} hint="Withheld, not an expense." />
            <Stat label="Net payable" value={formatMoney(prize.net)} hint="What the allocation divides." />
          </div>
        </section>

        <section aria-labelledby="allocation-heading" className="flex flex-col gap-4">
          <h2
            id="allocation-heading"
            className="text-[length:var(--text-xl)] leading-[var(--leading-snug)] font-semibold tracking-[var(--tracking-tight)]"
          >
            Allocation
          </h2>
          <Table label="Prize allocation">
            <TableCaption>
              One row per participant share. Largest-remainder distribution, frozen at compute
              time.
            </TableCaption>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">Share</TableHeaderCell>
                <TableHeaderCell scope="col">Computed</TableHeaderCell>
                <TableHeaderCell scope="col">Rule version</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {prize.allocations.map((row) => (
                <TableRow key={row.id}>
                  <TableCell scope="row" className="font-medium">
                    {row.label}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatMoney(row.computed)}</TableCell>
                  <TableCell className="font-mono text-[length:var(--text-xs)] text-ink-muted">
                    {row.ruleVersion}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        <section aria-labelledby="roster-heading" className="flex flex-col gap-4">
          <h2
            id="roster-heading"
            className="text-[length:var(--text-xl)] leading-[var(--leading-snug)] font-semibold tracking-[var(--tracking-tight)]"
          >
            Roster
          </h2>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Stat
              label="Attendance this session"
              value={`${attendancePercent}%`}
              hint={`${present} of ${roster.length} arrived inside the 15-minute cutoff.`}
            />

            <Card labelledBy="attendance-card-heading" className="lg:col-span-2">
              <CardHeader>
                <CardTitle id="attendance-card-heading">Attendance and movement</CardTitle>
                <CardDescription>
                  Status is derived from the recorded arrival instant. Tier movement is derived from
                  the win rate. Neither is self-declared.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table label="Roster attendance and tier movement">
                  <TableCaption>
                    Every row is a person, not a login. A player may hold several roles across
                    organisations.
                  </TableCaption>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell scope="col">Handle</TableHeaderCell>
                      <TableHeaderCell scope="col">Attendance</TableHeaderCell>
                      <TableHeaderCell scope="col">Tier</TableHeaderCell>
                      <TableHeaderCell scope="col">Win rate</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {roster.map((player) => (
                      <TableRow key={player.handle}>
                        <TableRowHeader>{player.handle}</TableRowHeader>
                        <TableCell>
                          <Badge tone={TONE_BY_ATTENDANCE[player.attendance]}>
                            {player.attendance}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge tone={TONE_BY_MOVEMENT[player.movement]}>
                            {player.previousTier} → {player.newTier}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">{player.winRatePercent}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </>
  );
}