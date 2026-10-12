"use client";

import * as React from "react";

import { cn } from "../lib/cn";

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /**
   * Marks this item as the current page. Rendered as `aria-current="page"`,
   * which is the only thing that distinguishes "here" from "highlighted" for
   * a screen-reader user — a background colour does not.
   */
  readonly current?: boolean;
}

export interface PrimaryNavProps {
  readonly items: readonly NavItem[];
  /** Visible on wide viewports. Hidden behind the toggle below `md`. */
  readonly brand?: React.ReactNode;
  /** Persistent header utilities (theme toggle, sign-out). Always visible. */
  readonly actions?: React.ReactNode;
}

/**
 * Primary navigation, responsive from 360px up.
 *
 * The mobile behaviour is the point. At a tournament this is used on a phone,
 * so below the `md` breakpoint the nav collapses behind a disclosure button.
 * Three things make that button correct rather than merely functional:
 *
 *  1. it is a real `<button type="button">`, so it is reachable with Tab and
 *     operated with both Enter and Space;
 *  2. `aria-expanded` reflects the actual state and `aria-controls` points at
 *     the panel it toggles, so the relationship is announced;
 *  3. the panel is REMOVED from the accessibility tree when collapsed rather
 *     than hidden behind a transform. A slide-out nav that is visually off
 *     screen but still focusable is the classic mobile a11y defect: a
 *     keyboard user tabs into an invisible list.
 *
 * Above `md` the same `<nav>` is always present and the button is removed with
 * `hidden`, which takes it out of the tab order — `display: none` on a
 * focusable element removes it from sequential focus.
 */
export function PrimaryNav({ items, brand, actions }: PrimaryNavProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  // Deterministic across server and client render. `useId` is used rather than
  // a counter because two navs on one page must not collide.
  const panelId = React.useId();

  const itemClass = (item: NavItem): string =>
    cn(
      "flex min-h-11 touch-manipulation items-center rounded-md px-3 py-2",
      "text-[length:var(--text-sm)] font-medium",
      "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
      item.current === true
        ? "bg-accent-soft text-accent"
        : "text-ink-muted hover:bg-sunken hover:text-ink",
    );

  return (
    <nav aria-label="Primary" className="w-full">
      <div className="flex items-center justify-between gap-4 px-4 py-3 md:px-6">
        {brand}

        <div className="flex items-center gap-2">
          {actions}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              setOpen((was) => !was);
            }}
            className={cn(
              "inline-flex min-h-11 min-w-11 cursor-pointer touch-manipulation items-center justify-center rounded-md",
              "border border-control bg-canvas text-ink",
              "transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:bg-sunken",
              "md:hidden",
            )}
          >
            <span className="sr-only">{open ? "Close main menu" : "Open main menu"}</span>
            {/* Decorative: the button's accessible name comes from the sr-only
                text, so the glyph must not be announced as well. */}
            <svg
              aria-hidden="true"
              focusable="false"
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>

      <ul
        id={panelId}
        // Collapsed on small screens only. Above `md` the panel is always
        // visible, so the `hidden` variant stops applying at that breakpoint.
        className={cn(
          "flex-col gap-1 px-4 pb-4 md:flex md:flex-row md:flex-wrap md:items-center md:pb-0",
          open ? "flex" : "hidden",
        )}
      >
        {items.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              {...(item.current === true ? { "aria-current": "page" as const } : {})}
              className={itemClass(item)}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}