import * as React from "react";

import { cn } from "../lib/cn";

export interface ContainerProps extends React.ComponentProps<"div"> {
  /** Maximum content width. Operations pages use `lg`; prose uses `md`. */
  readonly max?: "md" | "lg" | "xl";
}

/**
 * Content container.
 *
 * Every page in the product had its own ad-hoc `max-w-[32rem]` / `max-w-[40rem]`
 * with its own gutters, so a 1920px monitor showed three different content
 * widths on three routes. This is the one place a width is chosen: full width
 * with responsive gutters, capped and centred.
 */
export function Container({ max = "lg", className, ...props }: ContainerProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "mx-auto w-full",
        max === "md" && "max-w-3xl",
        max === "lg" && "max-w-6xl",
        max === "xl" && "max-w-7xl",
        className,
      )}
      {...props}
    />
  );
}
