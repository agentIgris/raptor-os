"use client";

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Button variants.
 *
 * Contrast is not asserted in a comment here. Every `*-bg`/`*-fg` pair below
 * is enumerated in `CONTRAST_REQUIREMENTS` in `../tokens.ts` and its ratio is
 * computed by `../tokens.test.ts` on every run, in both themes, including the
 * `:hover` and `:active` fills — the states where a palette most often
 * quietly stops passing.
 */
export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md",
    "font-medium leading-tight",
    // Every size is at least 44px tall. WCAG 2.5.8 (AA, new in 2.2) asks for
    // 24x24; 44 is 2.5.5 (AAA) and is the number that actually survives a
    // thumb on a phone at a tournament. Every size clears it, not just the
    // default one.
    "min-h-11 min-w-11",
    "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
    // The focus ring is applied in `globals.css` `@layer base`, to every
    // focusable element. It is NOT re-declared here: a second declaration
    // would be one more place for a `focus:` class to override it, and that is
    // precisely the regression this system is built to make impossible.
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active",
        secondary: "bg-sunken text-ink hover:bg-hairline",
        outline: "border border-control bg-canvas text-ink hover:bg-sunken",
        ghost: "bg-transparent text-ink hover:bg-sunken",
        danger: "bg-danger text-on-danger hover:bg-danger-hover",
        link: "min-h-0 min-w-0 rounded-xs p-0 text-accent underline underline-offset-4 hover:bg-transparent",
      },
      size: {
        // Height comes from `min-h-11` (44px) on the base plus these padding
        // values; `size` here controls density, never drops below 44px.
        sm: "px-3 text-[length:var(--text-xs)]",
        md: "px-4 text-[length:var(--text-sm)]",
        lg: "px-6 text-[length:var(--text-md)]",
        // Icon-only controls must still carry an accessible name; that is
        // enforced by the "Button accessible names" block in
        // `button.test.tsx`, not by this class list.
        icon: "px-0 text-[length:var(--text-sm)]",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  /**
   * Render the child element instead of a `<button>`, keeping the styling.
   * Used for links that must look like buttons. The accessibility obligation
   * does not transfer for free: `button-semantics.test.tsx` asserts that
   * `asChild` refuses a non-interactive element unless the caller supplies
   * the role and label it needs.
   */
  asChild?: boolean;
}

/**
 * The button primitive.
 *
 * Three properties that are easy to lose and are therefore pinned here:
 *
 * 1. It is a real `<button>`, so it is keyboard-activatable with both Enter
 *    and Space, announced as a button, and in the tab order — none of which
 *    is true of a styled `<div onClick>`.
 * 2. `type` defaults to `"button"`. A button with no type inside a form
 *    submits that form. That single default omission has caused lost drafts
 *    in more applications than any a11y defect.
 * 3. It never renders its own focus ring, because `globals.css` gives one to
 *    every focusable element already.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type, ...props },
  ref,
) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      ref={ref}
      // `type` only applies to a real <button>; passing it to a Slot child
      // would leak an invalid attribute onto an <a>.
      {...(asChild ? {} : { type: type ?? "button" })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});