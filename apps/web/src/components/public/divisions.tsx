import Image from "next/image";
import * as React from "react";

import { EmptyState, SectionHeading } from "@raptor/ui";
import type { PublicDivision } from "../../server/public";

/**
 * Game divisions. Tiles link nowhere until division detail routes exist —
 * a tile linking to a 404 is worse than a tile that stands alone.
 */
export function Divisions({ data }: { data: readonly PublicDivision[] | null }): React.JSX.Element {
  return (
    <section aria-labelledby="divisions" id="divisions" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10 md:px-8">
      <SectionHeading
        id="divisions"
        title="Game divisions"
        description="The titles Raptor competes in, and how many teams each fields."
      />
      {data === null ? (
        <EmptyState
          title="Divisions unavailable"
          description="Could not load divisions right now. Try again later."
        />
      ) : data.length === 0 ? (
        <EmptyState
          title="No divisions published yet"
          description="Divisions appear here once the organisation fields its first teams."
        />
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((division) => (
            <li
              key={`${division.gameSlug}/${division.slug}`}
              className="min-w-0 overflow-hidden rounded-lg border border-hairline bg-raised"
            >
              <Image
                src="/placeholders/division.svg"
                alt=""
                width={800}
                height={600}
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                className="aspect-[4/3] w-full object-cover"
              />
              <div className="flex flex-col gap-1 p-4">
                <p className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-faint uppercase">
                  {division.gameName} · {division.tier}
                </p>
                <p className="text-[length:var(--text-md)] font-semibold text-ink">{division.name}</p>
                <p className="text-[length:var(--text-sm)] text-ink-muted">
                  {division.teamCount === 1 ? "1 team" : `${division.teamCount} teams`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
