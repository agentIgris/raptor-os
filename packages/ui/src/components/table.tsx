import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Responsive table.
 *
 * The hard problem with a data table on a phone is horizontal overflow. The
 * usual fixes are all accessibility failures:
 *  - clip the overflow (`overflow: hidden`) — content becomes unreachable and
 *    fails WCAG 1.4.10 Reflow;
 *  - let the whole page scroll sideways — breaks every other page rule;
 *  - hide columns — silently deletes data.
 *
 * So the table scrolls inside its own container, and that container is made
 * reachable and described:
 *  - `role="region"` + `aria-label` so it appears in the landmark list and can
 *    be jumped to;
 *  - `tabIndex={0}` so a keyboard user can scroll it. WCAG 2.1.1 requires
 *    scrollable regions to be keyboard-operable, and a scrollable `<div>` is
 *    not focusable unless it is told to be. axe-core's `scrollable-region-
 *    focusable` rule exists for exactly this and fails without the tabIndex.
 */
export interface TableProps extends React.ComponentProps<"table"> {
  /** Required: a scrollable region with no name is not navigable. */
  label: string;
  wrapperClassName?: string;
}

export function Table({
  label,
  className,
  wrapperClassName,
  children,
  ...props
}: TableProps): React.JSX.Element {
  return (
    <div
      role="region"
      aria-label={label}
      // WCAG 2.1.1: a scrollable region must be keyboard-operable, which for a
      // non-interactive element means giving it a tab stop. This is the
      // documented, intended use of tabindex on a div — and it is required,
      // not merely tolerated: axe-core's `scrollable-region-focusable` rule
      // fails without it.
      tabIndex={0}
      className={cn(
        "w-full overflow-x-auto rounded-md border border-hairline",
        wrapperClassName,
      )}
    >
      <table className={cn("w-full border-collapse text-left text-[length:var(--text-sm)]", className)} {...props}>
        {children}
      </table>
    </div>
  );
}

/**
 * Table caption.
 *
 * Optional to render, but not optional to think about: a table of numbers with
 * no caption is a grid of unlabelled cells. Pass `caption` whenever the table's
 * purpose is not already stated by the heading immediately above it.
 */
export function TableCaption({
  className,
  children,
  ...props
}: React.ComponentProps<"caption">): React.JSX.Element {
  return (
    <caption className={cn("px-4 py-3 text-left text-[length:var(--text-xs)] text-ink-muted", className)} {...props}>
      {children}
    </caption>
  );
}

/**
 * A header cell.
 *
 * `scope="col"` is the default because the overwhelming majority of data tables
 * are column-headed, and an unscoped `<th>` is read by some screen readers as
 * a row header on the wrong axis. Pass `scope="row"` explicitly for the leftmost
 * cell of a row.
 */
export interface TableHeaderCellProps extends React.ComponentProps<"th"> {
  scope?: "col" | "row" | "colgroup" | "rowgroup";
}

export function TableHeaderCell({
  scope = "col",
  className,
  ...props
}: TableHeaderCellProps): React.JSX.Element {
  return (
    <th
      scope={scope}
      className={cn(
        "border-b border-control bg-sunken px-4 py-3",
        "text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-muted uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.JSX.Element {
  return <tr className={cn("border-b border-hairline last:border-b-0", className)} {...props} />;
}

/**
 * A row header cell — the `<th scope="row">` that names a row.
 *
 * THIS MUST BE A `<th>`, NOT A `<td>` WITH `scope` ATTACHED.
 *
 * That distinction was found by a failing test in this package rather than by
 * review: `<td scope="row">` renders identically, produces a table that looks
 * correct in a screenshot, and is announced by every screen reader as
 * "kirra, cell" rather than "kirra, row header". `scope` on a `<td>` is inert.
 * `TableCell` deliberately does not accept a `scope` prop at all, so the wrong
 * element cannot be written by accident.
 */
export function TableRowHeader({
  className,
  ...props
}: React.ComponentProps<"th">): React.JSX.Element {
  return (
    <th
      scope="row"
      className={cn(
        "border-b border-hairline px-4 py-3 align-middle",
        "text-left text-[length:var(--text-sm)] font-medium text-ink",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">): React.JSX.Element {
  return <td className={cn("px-4 py-3 align-middle text-ink", className)} {...props} />;
}

/** The `<thead>`. Exists so the sticky-header classes live in one place. */
export function TableHead({ className, ...props }: React.ComponentProps<"thead">): React.JSX.Element {
  return <thead className={cn("bg-sunken", className)} {...props} />;
}

export function TableBody(props: React.ComponentProps<"tbody">): React.JSX.Element {
  return <tbody {...props} />;
}