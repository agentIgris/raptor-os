import * as React from "react";

import { cn } from "../lib/cn";

export interface SectionHeadingProps extends React.ComponentProps<"div"> {
  /** Element id, referenced by the section's `aria-labelledby`. Required. */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
}

/**
 * Section heading.
 *
 * The overview and dashboard repeated the same `h2` class list six times with
 * three different gap values. One component pins the hierarchy (always `h2`,
 * always directly under the page `h1`), the balanced wrapping, and the
 * title-to-description spacing.
 */
export function SectionHeading({
  id,
  title,
  description,
  actions,
  className,
  ...props
}: SectionHeadingProps): React.JSX.Element {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2
          id={id}
          className="scroll-mt-20 text-balance text-[length:var(--text-xl)] leading-[var(--leading-snug)] font-semibold tracking-[var(--tracking-tight)] text-ink"
        >
          {title}
        </h2>
        {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {description === undefined ? null : (
        <p className="max-w-prose text-pretty text-[length:var(--text-sm)] leading-[var(--leading-normal)] text-ink-muted">
          {description}
        </p>
      )}
    </div>
  );
}
