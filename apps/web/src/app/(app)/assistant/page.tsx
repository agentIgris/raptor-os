import { OFFLINE_DISCLAIMER, readProviderConfig } from "@raptor/assistant";
import { Alert, PageHeader, SectionHeading } from "@raptor/ui";
import type { Metadata } from "next";
import * as React from "react";

import { AssistantPanel } from "../../../components/app/assistant-panel";

export const metadata: Metadata = {
  title: "Assistant",
};

export const dynamic = "force-dynamic";

/**
 * The assistant page.
 *
 * The server component reads the provider environment once to say whether a
 * model answers — it never calls the model, that is the API route's job. The
 * panel is the only client component on the page.
 *
 * Pending accounts do not see this route in the navigation, but a direct visit
 * still renders; the API route fails them closed with a 403, which is the one
 * boundary that actually holds the workspace data.
 */
export default function AssistantPage(): React.JSX.Element {
  const config = readProviderConfig(process.env);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Assistant"
        description="Ask about this organisation's teams, competitions, rosters and analytics. The assistant can only show data your role already has."
      />

      <div className="flex min-w-0 flex-col gap-8">
        {config === null ? (
          <Alert tone="info">
            <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)] font-medium">
              {OFFLINE_DISCLAIMER}
            </p>
          </Alert>
        ) : null}

        <section aria-labelledby="assistant-heading" className="flex min-w-0 flex-col gap-4">
          <SectionHeading
            id="assistant-heading"
            title="Ask the assistant"
            description="One question at a time; every answer cites the workspace data it was built from."
          />
          <AssistantPanel modelLabel={config?.model ?? null} />
        </section>
      </div>
    </>
  );
}
