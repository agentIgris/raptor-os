"use client";

import { usePathname } from "next/navigation";
import * as React from "react";

import { sectionLabelFor } from "../../server/nav";

/**
 * Breadcrumb: the current workspace section. Client-rendered because only the
 * browser knows the pathname; the label map itself is the server's nav model,
 * so an unknown path says "Workspace" instead of guessing.
 */
export function SectionCrumb(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav aria-label="Breadcrumb">
      <ol>
        <li>
          <span aria-current="page" className="text-[length:var(--text-sm)] font-medium text-ink">
            {sectionLabelFor(pathname)}
          </span>
        </li>
      </ol>
    </nav>
  );
}
