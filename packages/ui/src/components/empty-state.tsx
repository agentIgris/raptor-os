import * as React from "react";

import { cn } from "../lib/cn";

export interface EmptyStateProps extends React.ComponentProps<"div"> {
  readonly title: string;
  readonly description?: string;
  readonly action?: React.ReactNode;
}

/**
 * Empty state.
 *
 * Tables with zero rows previously rendered a header and nothing else — a grid
 * that looks broken and announces nothing. An empty result is a state with its
 * own heading, explanation, and optional next step, rendered inside the same
 * bordered surface the table would have occupied so the layout does not jump.
 */
export function EmptyState({ title, description, action, className, ...props }: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-2 rounded-md border border-dashed border-control bg-canvas px-4 py-8 text-left",
        className,
      )}
      {...props}
    >
      <p className="text-[length:var(--text-md)] leading-[var(--leading-snug)] font-semibold text-ink">{title}</p>
      {description === undefined ? null : (
        <p className="max-w-prose text-pretty text-[length:var(--text-sm)] leading-[var(--leading-normal)] text-ink-muted">
          {description}
        </p>
      )}
      {action === undefined ? null : <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}
