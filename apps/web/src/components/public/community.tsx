import * as React from "react";

import { Button, SectionHeading } from "@raptor/ui";
import type { CmsRecruitment, CmsSocial } from "../../server/cms";

/**
 * Community channels: verified CMS links only. No section when nothing is
 * published — an empty "follow us" block implies channels that do not exist.
 */
export function Community({ data }: { data: readonly CmsSocial[] | null }): React.JSX.Element | null {
  if (data === null || data.length === 0) return null;
  return (
    <section aria-labelledby="community" id="community" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10 md:px-8">
      <SectionHeading id="community" title="Follow Raptor" description="Official channels, nowhere else." />
      <ul className="mt-6 flex flex-wrap gap-3">
        {data.map((social) => (
          <li key={`${social.network}:${social.url}`}>
            <Button asChild variant="outline">
              <a href={social.url} rel="me noopener" target="_blank">
                {social.network}
              </a>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Recruitment: application CTA only while `open` is true in the CMS — and the
 * apply button only when a form target exists. Otherwise a neutral line that
 * promises nothing and collects nothing.
 */
export function Recruitment({ data }: { data: CmsRecruitment | null }): React.JSX.Element {
  const open = data?.open ?? false;
  return (
    <section aria-labelledby="recruitment" id="recruitment" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10 md:px-8">
      <SectionHeading
        id="recruitment"
        title={open ? (data?.heading ?? "Join Raptor") : "Get in touch"}
        description={
          open
            ? "Roster tryouts and open roles. The form states what is collected and where it goes."
            : "Recruitment opens here when the organisation is accepting applications."
        }
      />
      {open && data?.formTarget ? (
        <div className="mt-6">
          <Button asChild>
            <a href={data.formTarget} rel="noopener" target="_blank">
              Apply now
            </a>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
