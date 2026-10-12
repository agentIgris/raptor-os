"use client";

import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Theme toggle.
 *
 * The token layer already ships two complete themes (OS preference + explicit
 * `.dark` / `.light` classes on `<html>`), but no control ever wrote those
 * classes, so keyboard and low-vision users who need the opposite of their OS
 * setting had no recourse.
 *
 * Behaviour:
 * - starts in "system" (no class, OS preference wins);
 * - pressing the button cycles system → light → dark → system;
 * - the choice is in-memory only. Persisting it would require `localStorage`
 *   or `document.cookie`, both of which the `no-client-token-storage` guard
 *   forbids in shipped source — and a theme preference is not worth punching a
 *   hole in a session-security control.
 *
 * The SVG sun/moon glyph is decorative; the accessible name is the action.
 */
export function ThemeToggle({ className }: { readonly className?: string }): React.JSX.Element {
  const [mode, setMode] = React.useState<"system" | "light" | "dark">("system");

  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (mode === "light") root.classList.add("light");
    else if (mode === "dark") root.classList.add("dark");
  }, [mode]);

  const next = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  const label = mode === "system" ? "Use light theme" : mode === "light" ? "Use dark theme" : "Use system theme";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        setMode(next);
      }}
      className={cn(
        "inline-flex min-h-11 min-w-11 cursor-pointer touch-manipulation items-center justify-center rounded-md",
        "border border-control bg-canvas text-ink transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:bg-sunken",
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {mode === "dark" ? (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        ) : mode === "light" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <>
            <rect x="3" y="3" width="18" height="18" rx="9" />
            <path d="M12 3v18" />
          </>
        )}
      </svg>
    </button>
  );
}
