import * as React from "react";

import { cn } from "../lib/cn";

/**
 * The skip link.
 *
 * Rendered as the FIRST focusable element in the document, before the header,
 * so a keyboard user arriving on a page with thirty table rows does not have
 * to tab through all of them to reach the navigation.
 *
 * It is off-screen until focused, and it is off-screen with a technique that
 * keeps it reachable rather than one that does not:
 *
 *  - `sr-only`-style clipping (not `display: none`) — a `display: none`
 *    element is not focusable, so a skip link hidden that way can never be
 *    reached and the whole feature is decorative;
 *  - it becomes visible on `:focus` and on `:focus-visible`.
 *
 * `href` is required. There is no sensible default target, and defaulting it
 * to `#main` would quietly point at a page that does not have one.
 */
export interface SkipLinkProps extends React.ComponentProps<"a"> {
  href: string;
  label?: string;
}

export function SkipLink({
  href,
  label = "Skip to main content",
  className,
  ...props
}: SkipLinkProps): React.JSX.Element {
  return (
    <a
      href={href}
      className={cn(
        "sr-only",
        // `:focus` rather than only `:focus-visible`: a skip link reached by
        // keyboard on a browser without :focus-visible support would otherwise
        // never appear at all.
        "focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50",
        "focus:rounded-md focus:bg-accent focus:px-4 focus:py-3",
        "focus:text-on-accent focus:no-underline",
        className,
      )}
      {...props}
    >
      {label}
    </a>
  );
}

export interface PageHeaderProps extends React.ComponentProps<"header"> {
  /** Optional short line above the title. */
  readonly eyebrow?: string;
  /**
   * The page's `<h1>`. Rendered here rather than by the caller so that every
   * page has exactly one first-level heading — an outline that starts at `h2`
   * is a screen-reader navigation defect, not a style choice.
   */
  readonly title: string;
  readonly description?: string;
  readonly actions?: React.ReactNode;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps): React.JSX.Element {
  return (
    <header
      className={cn("border-b border-hairline bg-canvas", className)}
      {...props}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 md:px-8 md:py-8">
        {eyebrow === undefined ? null : (
          <p className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-faint uppercase">
            {eyebrow}
          </p>
        )}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="max-w-prose text-balance text-[length:var(--text-2xl)] leading-[var(--leading-tight)] font-bold tracking-[var(--tracking-tight)] break-words text-ink">
              {title}
            </h1>
            {description === undefined ? null : (
              <p className="max-w-prose text-pretty text-[length:var(--text-sm)] leading-[var(--leading-normal)] break-words text-ink-muted">
                {description}
              </p>
            )}
          </div>
          {actions === undefined ? null : (
            <div className="flex flex-wrap items-center gap-3">{actions}</div>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * The `<main>` landmark.
 *
 * `id` matches the skip link's `href`. The pair is asserted in
 * `app-shell.test.tsx` — a skip link pointing at nothing is worse than no
 * skip link, because the user is told navigation exists and it does not.
 */
export function Main({
  className,
  children,
  ...props
}: React.ComponentProps<"main">): React.JSX.Element {
  return (
    <main
      id="main"
      tabIndex={-1}
      className={cn("mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8", className)}
      {...props}
    >
      {children}
    </main>
  );
}

/** The `<footer>` (contentinfo) landmark. */
export function PageFooter({ className, children, ...props }: React.ComponentProps<"footer">): React.JSX.Element {
  return (
    <footer className={cn("border-t border-hairline", className)} {...props}>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 text-[length:var(--text-sm)] break-words text-ink-muted md:px-8">
        {children}
      </div>
    </footer>
  );
}

/** A single figure, with the label and value as the two halves of the content. */
export function Stat({
  label,
  value,
  hint,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-hairline bg-raised p-4 shadow-[var(--shadow-xs)]">
      <p className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] break-words text-ink-faint uppercase">
        {label}
      </p>
      <p className="text-[length:var(--text-2xl)] leading-[var(--leading-tight)] font-bold tracking-[var(--tracking-tight)] break-words tabular-nums text-ink">
        {value}
      </p>
      {hint === undefined ? null : (
        <p className="text-[length:var(--text-xs)] leading-[var(--leading-normal)] break-words text-ink-muted">{hint}</p>
      )}
      {children}
    </div>
  );
}