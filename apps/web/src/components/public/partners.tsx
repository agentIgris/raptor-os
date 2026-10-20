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
      <ul className="mt-6 flex flex-wrap gap-3">
        {data.map((partner, index) => (
          <li
            key={partner.name}
            className={`${index % 3 === 0 ? "dc-fill-violet dc-hard-hot" : index % 3 === 1 ? "dc-fill-cyan dc-hard-lime" : "dc-fill-sun dc-hard-cyan"} rounded-full border-2 border-[var(--dc-on-pop)] px-4 py-1 text-[length:var(--text-md)] font-bold tracking-[var(--tracking-tight)]`}
          >
            {partner.url === null ? (
              <span translate="no">{partner.name}</span>
            ) : (
              <a href={partner.url} rel="noopener sponsored" target="_blank" translate="no">
                {partner.name}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
