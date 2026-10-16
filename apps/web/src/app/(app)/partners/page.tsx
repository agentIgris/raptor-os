import type { Metadata } from "next";
import * as React from "react";

import { Button, EmptyState, PageHeader, Table, TableBody, TableCaption, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "@raptor/ui";

import { getPublishedPartners } from "../../../server/cms";

export const metadata: Metadata = {
  title: "Partners",
};

export const dynamic = "force-dynamic";

/**
 * Published partners. Contract values and obligations stay in the money
 * views — this is the public-facing list, nothing more.
 */
export default async function PartnersPage(): Promise<React.JSX.Element> {
  const partners = await getPublishedPartners();

  return (
    <>
      <PageHeader
        eyebrow="Content"
        title="Partners"
        description="Published partner entries shown on the public site."
        actions={
          <Button asChild variant="outline">
            <a href="/cms-admin">Open content admin</a>
          </Button>
        }
      />
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
        {partners === null ? (
          <EmptyState title="Partners unavailable" description="Could not load partners right now. Try again later." />
        ) : partners.length === 0 ? (
          <EmptyState title="No partners published" description="Partners appear here once approved entries are published. Unapproved logos stay out." />
        ) : (
          <Table label="Published partners">
            <TableCaption>Alphabetical. Tiers are display order hints, not contract terms.</TableCaption>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">Partner</TableHeaderCell>
                <TableHeaderCell scope="col">Tier</TableHeaderCell>
                <TableHeaderCell scope="col">Website</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {partners.map((partner) => (
                <TableRow key={partner.name}>
                  <TableRowHeader translate="no">{partner.name}</TableRowHeader>
                  <TableCell>{partner.tier}</TableCell>
                  <TableCell>{partner.url === null ? "—" : partner.url}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
