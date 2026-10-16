import * as React from "react";

export interface ProofFacts {
  readonly divisions: number;
  readonly teams: number;
  readonly results: number;
}

interface Fact {
  readonly label: string;
  readonly count: number;
}

/**
 * Proof strip: real counts or nothing at all.
 *
 * Renders only when at least one fact exists. A strip of zeros ("0 divisions,
 * 0 teams") reads as failure, and invented totals are forbidden — so absence
 * of data means absence of the strip, and `null` (unknown) behaves the same.
 */
export function ProofStrip({ facts }: { facts: ProofFacts | null }): React.JSX.Element | null {
  if (facts === null) return null;
  const entries: Fact[] = [];
  if (facts.divisions > 0) entries.push({ label: "Active divisions", count: facts.divisions });
  if (facts.teams > 0) entries.push({ label: "Teams", count: facts.teams });
  if (facts.results > 0) entries.push({ label: "Verified results", count: facts.results });
  if (entries.length === 0) return null;
  return (
    <section aria-label="Organisation facts" className="border-b border-hairline">
      <dl className="mx-auto flex w-full max-w-6xl flex-wrap gap-x-10 gap-y-3 px-4 py-5 md:px-8">
        {entries.map((entry) => (
          <div key={entry.label} className="flex items-baseline gap-2">
            <dt className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-faint uppercase">
              {entry.label}
            </dt>
            <dd className="text-[length:var(--text-2xl)] leading-[var(--leading-tight)] font-bold tabular-nums text-ink">
              {entry.count}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
