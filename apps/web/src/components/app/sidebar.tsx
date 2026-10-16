import Image from "next/image";
import * as React from "react";

import type { NavSection } from "../../server/nav";

/**
 * Workspace sidebar: tenant mark, organisation switcher slot, role-filtered
 * navigation. Server-rendered from the session — the client never decides
 * which sections exist.
 */
export function Sidebar({
  sections,
  switcher,
}: {
  readonly sections: readonly NavSection[];
  readonly switcher: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
      <div className="flex items-center gap-2 px-1">
        <Image src="/placeholders/logo.svg" alt="" width={28} height={28} className="h-7 w-7" />
        <span className="text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-faint uppercase">
          Workspace
        </span>
      </div>
      {switcher}
      <nav aria-label="Workspace" className="min-w-0 flex-1">
        <ul className="flex min-w-0 flex-col gap-4">
          {sections.map((section) => (
            <li key={section.title}>
              <p className="px-2 text-[length:var(--text-xs)] font-semibold tracking-[var(--tracking-wide)] text-ink-faint uppercase">
                {section.title}
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {section.items.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
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
  );
}
