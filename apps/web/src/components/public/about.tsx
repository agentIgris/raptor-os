import * as React from "react";

import { EmptyState, SectionHeading } from "@raptor/ui";

/**
 * About: a placeholder with a promise, not a fabricated history.
 *
 * Founding year, founders and story appear here only from verified sources.
 * Until then the section says exactly that — a missing story is not a gap to
 * fill with adjectives.
 */
export function About(): React.JSX.Element {
  return (
    <section aria-labelledby="about" id="about" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10 md:px-8">
      <SectionHeading id="about" title="About Raptor" description="Who we are." />
      <EmptyState
        title="Story coming soon"
        description="Founding, leadership and history appear here once verified and published."
      />
    </section>
  );
}
