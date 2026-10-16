import type { Metadata } from "next";
import * as React from "react";

import { Badge, EmptyState, PageHeader, Table, TableBody, TableCaption, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "@raptor/ui";

import { getCurrentSession } from "../../../server/session";
import { mergeMembers } from "../../../server/workspace-view";
import { getWorkspaceMembers } from "../../../server/workspace";

export const metadata: Metadata = {
  title: "Members",
};

export const dynamic = "force-dynamic";

/**
 * Organisation members: display names, membership standing and current roles.
 * Display names only — legal names and contact data never cross into this
 * (or any) listing.
 */
export default async function MembersPage(): Promise<React.JSX.Element> {
  const session = await getCurrentSession();
  const rows = session === null ? null : await getWorkspaceMembers(session.orgId);
  const members = rows === null ? null : mergeMembers(rows);

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Members"
        description="Everyone attached to this organisation, and what they may do."
      />
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
        {members === null ? (
          <EmptyState title="Members unavailable" description="Could not load members right now. Try again later." />
        ) : members.length === 0 ? (
          <EmptyState title="No members yet" description="Members appear here once invitations are accepted." />
        ) : (
          <Table label="Organisation members">
            <TableCaption>Roles shown are current assignments only.</TableCaption>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">Member</TableHeaderCell>
                <TableHeaderCell scope="col">Standing</TableHeaderCell>
                <TableHeaderCell scope="col">Roles</TableHeaderCell>
                <TableHeaderCell scope="col">Joined</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((member) => (
                <TableRow key={`${member.displayName}-${member.joinedAt ?? "?"}`}>
                  <TableRowHeader>{member.displayName}</TableRowHeader>
                  <TableCell>
                    <Badge tone={member.membershipStatus === "active" ? "success" : "warning"}>
                      {member.membershipStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>{member.roles.length === 0 ? "—" : member.roles.join(", ")}</TableCell>
                  <TableCell className="tabular-nums">{member.joinedAt ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </>
  );
}
