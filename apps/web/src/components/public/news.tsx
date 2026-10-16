import * as React from "react";

import { EmptyState, SectionHeading } from "@raptor/ui";
import type { CmsArticle } from "../../server/cms";

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <section aria-labelledby="news" id="news" className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-10 md:px-8">
      <SectionHeading id="news" title="Latest news" description="Announcements and match reports from the organisation." />
      {children}
    </section>
  );
}

/**
 * Editorial feed: one featured story plus recents — never a uniform card
 * wall. Items carry no links until article detail routes exist; a headline
 * linking to a 404 is worse than a headline that stands alone.
 */
export function NewsFeed({ data }: { data: readonly CmsArticle[] | null }): React.JSX.Element {
  if (data === null) {
    return (
      <Shell>
        <EmptyState title="News unavailable" description="Could not load news right now. Try again later." />
      </Shell>
    );
  }
  const featured = data[0];
  if (featured === undefined) {
    return (
      <Shell>
        <EmptyState
          title="No stories published yet"
          description="Announcements appear here once the organisation publishes its first story."
        />
      </Shell>
    );
  }
  const rest = data.slice(1);
  return (
    <Shell>
      <div className="mt-6 flex flex-col gap-6">
        <article aria-labelledby="featured-story">
          <p className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-faint uppercase">
            Featured
            {featured.publishedAt === null ? "" : ` · ${featured.publishedAt.slice(0, 10)}`}
          </p>
          <h3 id="featured-story" className="font-display mt-2 max-w-prose text-balance text-[length:var(--text-2xl)] leading-[var(--leading-tight)] font-semibold break-words text-ink">
            {featured.title}
          </h3>
          {featured.excerpt === null ? null : (
            <p className="mt-2 max-w-prose text-pretty text-[length:var(--text-sm)] leading-[var(--leading-normal)] text-ink-muted">
              {featured.excerpt}
            </p>
          )}
        </article>
        {rest.length > 0 ? (
          <ul className="flex flex-col gap-4 border-t border-hairline pt-6">
            {rest.map((article) => (
              <li key={article.slug} className="min-w-0">
                <p className="text-[length:var(--text-md)] font-medium break-words text-ink">{article.title}</p>
                <p className="mt-1 text-[length:var(--text-xs)] text-ink-faint">
                  {article.publishedAt === null ? "Undated" : article.publishedAt.slice(0, 10)}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Shell>
  );
}
