import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

export const alertVariants = cva(
  "flex flex-col gap-2 rounded-md border p-4",
  {
    variants: {
      tone: {
        info: "border-info bg-info-soft text-info",
        success: "border-success bg-success-soft text-success",
        warning: "border-warning bg-warning-soft text-warning",
        danger: "border-danger bg-danger-soft text-danger",
      },
    },
    defaultVariants: { tone: "info" },
  },
);

export interface AlertProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof alertVariants> {
  /**
   * Live-region politeness.
   *
   * `assertive` (`role="alert"`) interrupts whatever the screen reader is
   * saying. Correct for a validation failure the user just caused; wrong for
   * a banner that was already on the page when they arrived, which interrupts
   * them for no reason.
   *
   * `polite` (`role="status"`) queues the announcement behind whatever is being
   * read. The default here, because most alerts in this product are rendered
   * server-side and were present before the user did anything.
   */
  politeness?: "polite" | "assertive";
}

/**
 * An inline status message.
 *
 * It is a live region in both politeness modes, which means content added
 * after the initial render — the usual case, a failed sign-in or a failed
 * save — is announced without the user having to go and find what changed.
 */
export function Alert({
  className,
  tone,
  politeness = "polite",
  children,
  ...props
}: AlertProps): React.JSX.Element {
  return (
    <div
      {...(politeness === "assertive" ? { role: "alert" } : { role: "status" })}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      {children}
    </div>
  );
}