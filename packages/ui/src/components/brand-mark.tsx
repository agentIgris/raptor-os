import * as React from "react";

import { cn } from "../lib/cn";

export interface BrandMarkProps extends React.ComponentProps<"svg"> {
  /** Accessible title. Omit for decorative use alongside visible brand text. */
  readonly title?: string;
}

/**
 * Raptor OS brand mark.
 *
 * A single inline SVG replacing the legacy emoji glyph. Emoji as a brand mark
 * fails the project's own icon discipline (SVG, one stroke weight, aligned to
 * text) and renders differently on every platform — a green dinosaur on one
 * phone, a grey box on another. This mark is a geometric raptor chevron drawn
 * on a 24×24 grid at 2px stroke, `currentColor`-driven so it inherits the
 * surrounding text colour in both themes without a new token.
 *
 * Decorative by default (`aria-hidden`), because every call site pairs it with
 * visible "Raptor OS" text that already names the link.
 */
export function BrandMark({ title, className, ...props }: BrandMarkProps): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title === undefined ? true : undefined}
      focusable="false"
      role={title === undefined ? undefined : "img"}
      className={cn("shrink-0", className)}
      {...props}
    >
      {title === undefined ? null : <title>{title}</title>}
      {/* Chevron claw: outer sweep + inner cut + eye dot. */}
      <path d="M4 5c4-1.5 9-1.5 13 1-1.5 5-5.5 9-11 10.5" />
      <path d="M8.5 8.5c2.5-.6 5-.3 7 1-1 2.8-3.4 5-6.8 6" />
      <circle cx="9" cy="9.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
