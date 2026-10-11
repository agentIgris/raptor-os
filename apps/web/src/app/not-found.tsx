import { Button } from "@raptor/ui";
import type { Metadata } from "next";
import * as React from "react";

export const metadata: Metadata = {
  title: "Not found",
};

/**
 * 404.
 *
 * A real page with a real heading and a real way forward, rather than Next's
 * default — which ships without an `<h1>`, so the page outline starts at
 * `h2` for anyone navigating by heading.
 */
export default function NotFound(): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-4 py-12">
      <h1 className="text-[length:var(--text-2xl)] leading-[var(--leading-tight)] font-bold tracking-[var(--tracking-tight)]">
        Page not found
      </h1>
      <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)] text-ink-muted">
        That address does not exist in this organisation&rsquo;s workspace.
      </p>
      <div>
        <Button asChild>
          <a href="/">Back to the overview</a>
        </Button>
      </div>
    </div>
  );
}