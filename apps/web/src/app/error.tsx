"use client";

import { Button } from "@raptor/ui";
import * as React from "react";

/**
 * Route-level error boundary.
 *
 * This is a CLIENT component and must be: Next.js requires it so it can attach
 * the retry handler.
 *
 * `reset()` re-renders the segment rather than reloading the page, so a
 * transient server error does not throw away whatever the user had typed.
 *
 * The digest is shown deliberately. It is the id that ties this render to the
 * server-side log entry for the same request — a user reporting "it broke"
 * gives you one string that correlates to a specific trace, instead of you
 * guessing which of a thousand identical "Something went wrong" renders it was.
 * It is not a secret and it is not user data.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): React.JSX.Element {
  const [retrying, setRetrying] = React.useState(false);

  return (
    <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-4 py-8">
      <h1 className="text-[length:var(--text-2xl)] leading-[var(--leading-tight)] font-bold tracking-[var(--tracking-tight)]">
        Something went wrong
      </h1>
      <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)] text-ink-muted">
        This request could not be completed. Nothing was changed. Retrying is safe.
      </p>
      {error.digest === undefined ? null : (
        <p className="font-mono text-[length:var(--text-xs)] text-ink-faint">
          Reference: {error.digest}
        </p>
      )}
      <div>
        <Button
          type="button"
          disabled={retrying}
          aria-busy={retrying}
          onClick={() => {
            setRetrying(true);
            reset();
          }}
        >
          {retrying ? "Retrying…" : "Try again"}
        </Button>
      </div>
    </div>
  );
}