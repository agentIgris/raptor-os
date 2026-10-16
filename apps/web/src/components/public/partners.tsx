import * as React from "react";

import { SectionHeading } from "@raptor/ui";
import type { CmsPartner } from "../../server/cms";

/**
 * Partners strip: names only, until the first approved logo is uploaded.
 * The whole section is omitted when empty — a partners strip with no
 * partners implies endorsements that do not exist.
 */
export function Partners({ data }: { data: readonly CmsPartner[] | null }): React.JSX.Element | null {
  if (data === null || data.length === 0) return null;
  return (
    <section aria-labelledby="partners" id="partners" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10 md:px-8">
      <SectionHeading id="partners" title="Partners" description="Organisations that back Raptor." />
      <ul className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
        {data.map((partner) => (
          <li
            key={partner.name}
            className="text-[length:var(--text-md)] font-semibold tracking-[var(--tracking-tight)] text-ink-muted"
          >
            {partner.url === null ? (
              <span translate="no">{partner.name}</span>
            ) : (
              <a href={partner.url} rel="noopener sponsored" target="_blank" translate="no" className="underline decoration-hairline underline-offset-4 hover:text-ink">
                {partner.name}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
