import type { Metadata } from "next";
import * as React from "react";

import { EmptyState, PageHeader, Stat } from "@raptor/ui";

import { getCurrentSession } from "../../../server/session";
import { getWorkspaceOrg } from "../../../server/workspace";

export const metadata: Metadata = {
  title: "Organisation settings",
};

export const dynamic = "force-dynamic";

/**
 * Organisation profile, read-only in this version. Profile changes have no
 * self-service path yet — that is stated here rather than implied by a form
 * that writes nowhere.
 */
export default async function SettingsPage(): Promise<React.JSX.Element> {
  const session = await getCurrentSession();
  const org = session === null ? null : await getWorkspaceOrg(session.orgId);

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Organisation"
        description="Identity, locale and currency for the active tenant."
      />
      <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
        {org === null ? (
          <EmptyState title="Organisation unavailable" description="Could not load the organisation profile right now. Try again later." />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="Display name" value={org.displayName} />
            <Stat label="Slug" value={org.slug} hint="Tenant identifier. Never changes." />
            <Stat label="Status" value={org.status} />
            <Stat label="Timezone" value={org.timezone} />
            <Stat label="Locale" value={org.locale} />
            <Stat label="Currency" value={org.currency} />
          </div>
        )}
      </div>
    </>
  );
}
