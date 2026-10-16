"use client";

import { usePathname } from "next/navigation";
import * as React from "react";

import type { NavSection } from "../../server/nav";

/**
 * Mobile workspace navigation: the sidebar's items behind a disclosure.
 *
 * Same contract as the public `PrimaryNav` disclosure: a real button,
 * `aria-expanded` + `aria-controls`, the panel REMOVED from the tree when
 * closed, Escape closes and returns focus. `items` arrive as props because
 * the role filter runs on the server — the client never decides visibility.
 */
export function MenuButton({ sections }: { sections: readonly NavSection[] }): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  return (
    <div className="lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((was) => !was);
        }}
        className="inline-flex min-h-11 min-w-11 cursor-pointer touch-manipulation items-center justify-center rounded-md border border-control bg-canvas px-3 text-[length:var(--text-sm)] font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:bg-sunken"
      >
        <span className="sr-only">{open ? "Close workspace menu" : "Open workspace menu"}</span>
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
      {open ? (
        <div
          id={panelId}
          className="absolute inset-x-0 top-full z-40 border-b border-hairline bg-canvas px-4 py-4"
        >
          <nav aria-label="Workspace">
            <ul className="flex flex-col gap-4">
              {sections.map((section) => (
                <li key={section.title}>
                  <p className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-faint uppercase">
                    {section.title}
                  </p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {section.items.map((item) => (
                      <li key={item.href}>
                        <a
                          href={item.href}
                          {...(pathname === item.href ? { "aria-current": "page" as const } : {})}
                          onClick={() => {
                            setOpen(false);
                          }}
                          className="flex min-h-11 touch-manipulation items-center rounded-md px-3 py-2 text-[length:var(--text-sm)] font-medium text-ink-muted hover:bg-sunken hover:text-ink"
                        >
                          {item.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      ) : null}
    </div>
  );
}
