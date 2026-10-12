"use client";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@raptor/ui";
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

  // If the retry itself fails, the boundary re-renders with the same error and
  // this component stays mounted with `retrying` stuck on. Re-arm the button
  // when the error identity changes so the user is never left with a disabled
  // control and no way forward.
  const digest = error.digest;
  React.useEffect(() => {
    setRetrying(false);
  }, [digest]);

  return (
    <div className="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col gap-6 py-8">
      <Card labelledBy="error-heading">
        <CardHeader>
          <CardTitle id="error-heading" className="text-balance">
            Something went wrong
          </CardTitle>
          <CardDescription>
            This request could not be completed. Nothing was changed. Retrying is safe.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {error.digest === undefined ? null : (
            <p className="font-mono text-[length:var(--text-xs)] break-all text-ink-faint" translate="no">
              Reference: {error.digest}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
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
            <Button asChild variant="outline">
              <a href="/">Back to the overview</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
