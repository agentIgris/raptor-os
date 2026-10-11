import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Card.
 *
 * A card is a `<section>` when it has a heading, because that is exactly what
 * it is: a named region of the page. Rendering a generic `<div>` and letting
 * a screen-reader user hunt for the boundary is the usual failure. When there
 * is no heading, `aria-labelledby` is omitted and the element falls back to a
 * plain `<div>` so it does not pollute the landmark list with unnamed regions.
 */
export interface CardProps extends React.ComponentProps<"section"> {
  /** Id of the element that names this card. Required for the landmark. */
  labelledBy?: string;
}

export const Card = React.forwardRef<HTMLElement, CardProps>(function Card(
  { className, labelledBy, children, ...props },
  ref,
) {
  return (
    <section
      ref={ref}
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      className={cn(
        "rounded-lg border border-hairline bg-raised shadow-[var(--shadow-sm)]",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
});

export const CardHeader = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function CardHeader({ className, ...props }, ref) {
    return <div ref={ref} className={cn("flex flex-col gap-2 p-6", className)} {...props} />;
  },
);

/**
 * Card heading.
 *
 * `as`/`asChild` is deliberately absent. The heading level is a decision about
 * the page outline, not about the component, so the caller picks it: an
 * `h1` inside a card that is not the page title produces a broken outline
 * that no amount of component-level cleverness can fix.
 */
export const CardTitle = React.forwardRef<HTMLHeadingElement, React.ComponentProps<"h3">>(
  function CardTitle({ className, ...props }, ref) {
    return (
      <h3
        ref={ref}
        className={cn("text-[length:var(--text-lg)] leading-[var(--leading-snug)] font-semibold", className)}
        {...props}
      />
    );
  },
);

export const CardDescription = React.forwardRef<HTMLParagraphElement, React.ComponentProps<"p">>(
  function CardDescription({ className, ...props }, ref) {
    return (
      <p
        ref={ref}
        className={cn("text-[length:var(--text-sm)] leading-[var(--leading-normal)] text-ink-muted", className)}
        {...props}
      />
    );
  },
);

export const CardContent = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn("px-6 pb-6", className)} {...props} />;
  },
);

export const CardFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex flex-wrap items-center gap-3 px-6 pb-6", className)}
        {...props}
      />
    );
  },
);