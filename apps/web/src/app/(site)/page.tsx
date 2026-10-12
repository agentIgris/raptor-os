import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  SectionHeading,
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

import { buildPrizePreview, buildRosterPreview } from "../../server/dashboard";
import { formatMoney } from "../../server/format";

export const metadata: Metadata = {
  title: "Overview",
};

/**
 * Rendered per request, not prerendered.
 *
 * A nonce-based Content Security Policy (see `src/proxy.ts`) cannot be
 * satisfied by a page whose HTML was produced at build time: the inline
 * bootstrap scripts in a prerendered document were emitted without a nonce, and
 * the browser blocked every one of them. React never hydrated and the page was
 * inert — the same class of failure the CSP itself was introduced to detect.
 *
 * The cost is real and is recorded rather than hidden: this page loses static
 * generation. For a multi-tenant product whose landing page differs per tenant
 * that is the correct trade anyway, and the next thing that would force this
 * decision is a per-organisation theme.
 */
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
 * The public entry point.
 *
 * This is the acquisition surface named in the spec (§1) and it is also the
 * route axe-core runs over in a real browser in `e2e/a11y.spec.ts`, because
 * it renders every primitive the dashboard uses — cards, stat tiles, a data
 * table, status pills and buttons — at real viewport sizes with real CSS
 * applied. That is what makes the contrast rule a measurement rather than an
 * assumption: axe reads the computed colours of these elements in a real
 * layout engine, which a jsdom test cannot do.
 *
 * Every number below is derived by `@raptor/core` from the fixtures in
 * `server/dashboard.ts`. Nothing here is hand-typed "example data", because a
 * display bug in the money formatter is exactly the class of defect that ships
 * when the display path is never exercised.
 */
export default function OverviewPage(): React.JSX.Element {
  const prize = buildPrizePreview();
  const roster = buildRosterPreview();

  return (
    <>
      <PageHeader
        eyebrow="Raptor OS"
        title="Money and obligations, in one system of record"
        description="Prize allocation, sponsor deliverables, rosters and contracts for a competitive esports organisation — deterministic, explainable and provable."
        actions={
          <>
            <Button asChild>
              <a href="/sign-in">Sign in</a>
            </Button>
            <Button asChild variant="outline">
              <a href="/dashboard">Open the dashboard</a>
            </Button>
          </>
        }
      />

      <div className="flex min-w-0 flex-col gap-8">
        <section aria-labelledby="what-it-is" className="flex min-w-0 flex-col gap-4">
          <SectionHeading
            id="what-it-is"
            title="What it does"
            description="One ledger for prize money, sponsor obligations, and the roster they belong to."
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Stat
              label="Prize pool, illustrative"
              value={formatMoney(prize.net)}
              hint={`${prize.currency} — gross ${formatMoney(prize.gross)}, after deductions and tax.`}
            />
            <Stat
              label="Reconciliation variance"
              value={formatMoney(prize.variance)}
              hint="Allocations plus adjustments must equal the net exactly. This run reconciles."
            />
            <Stat
              label="Roster on the ladder"
              value={String(roster.length)}
              hint="Tier movement is decided by the recovered rule, not by a coach's judgement."
            />
          </div>
        </section>

        <section aria-labelledby="allocation" className="flex min-w-0 flex-col gap-4">
          <SectionHeading
            id="allocation"
            title="Prize allocation"
            description="Largest-remainder distribution across every share of the net pool."
          />
          <Alert tone="info">
            <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)] font-medium">
              Illustrative figures.
            </p>
            <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)]">
              These are computed by <code className="font-mono" translate="no">@raptor/core</code> from a fixture
              prize pool so the money path is exercised end to end. They are not a customer&rsquo;s
              money.
            </p>
          </Alert>

          {prize.allocations.length === 0 ? (
            <EmptyState
              title="No allocations yet"
              description="Allocations appear once the prize pool is computed for this cycle."
            />
          ) : (
          <Table label="Prize allocation preview">
            <TableCaption>
              Allocation by basis, with the indivisible remainder distributed by largest remainder.
            </TableCaption>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">Basis</TableHeaderCell>
                <TableHeaderCell scope="col">Participants</TableHeaderCell>
                <TableHeaderCell scope="col">Computed amount</TableHeaderCell>
                <TableHeaderCell scope="col">Rule version</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {prize.allocations.map((row) => (
                <TableRow key={row.id}>
                  <TableRowHeader>{row.label}</TableRowHeader>
                  <TableCell className="tabular-nums">{String(row.participants)}</TableCell>
                  <TableCell className="tabular-nums">{formatMoney(row.computed)}</TableCell>
                  <TableCell className="font-mono text-[length:var(--text-xs)] break-all text-ink-muted" translate="no">
                    {row.ruleVersion}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          )}
        </section>

        <section aria-labelledby="roster" className="flex min-w-0 flex-col gap-4">
          <SectionHeading
            id="roster"
            title="Roster and tier movement"
            description="Attendance from recorded arrivals; tiers from win rate. Neither is self-declared."
          />

          {roster.length === 0 ? (
            <EmptyState
              title="No rostered players"
              description="Players appear here once they are added to the organisation."
            />
          ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card labelledBy="attendance-heading">
              <CardHeader>
                <CardTitle id="attendance-heading">Attendance</CardTitle>
                <CardDescription>
                  Derived from the recorded arrival instant, never self-declared.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2">
                  {roster.map((player) => (
                    <li
                      key={player.handle}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3"
                    >
                      <span className="min-w-0 text-[length:var(--text-sm)] font-medium break-words" translate="no">{player.handle}</span>
                      <Badge tone={TONE_BY_ATTENDANCE[player.attendance]}>
                        {player.attendance}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card labelledBy="ladder-heading">
              <CardHeader>
                <CardTitle id="ladder-heading">Tier ladder</CardTitle>
                <CardDescription>
                  Promotion above 50%, retention from 35%, demotion below. Exactly 50 is retained.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2">
                  {roster.map((player) => (
                    <li
                      key={player.handle}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-3"
                    >
                      <span className="min-w-0 text-[length:var(--text-sm)] break-words">
                        <span translate="no">{player.handle}</span>{" "}
                        <span className="text-ink-muted" translate="no">
                          ({player.previousTier} → {player.newTier})
                        </span>
                      </span>
                      <Badge tone={TONE_BY_MOVEMENT[player.movement]}>
                        {player.movement} · {player.winRatePercent}%
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
          )}
        </section>
      </div>
    </>
  );
}