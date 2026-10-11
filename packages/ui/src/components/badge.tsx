import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Badge / status pill.
 *
 * Colour is never the only signal: every variant also renders its own text,
 * and `tone="danger"` maps to the danger palette specifically so "red" cannot
 * be mistaken for "accent". WCAG 1.4.1 (Use of Colour) is a requirement, not
 * a preference, and a status column that is a column of coloured dots fails it
 * for every user who cannot distinguish the hues.
 */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-3 py-1 text-[length:var(--text-xs)] font-semibold leading-[var(--leading-snug)] whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-sunken text-ink-muted",
        accent: "bg-accent-soft text-accent",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
        info: "bg-info-soft text-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}