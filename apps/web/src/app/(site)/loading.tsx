import * as React from "react";

/**
 * Loading state for public routes.
 *
 * SCOPED TO `(site)` DELIBERATELY. A `loading.tsx` at the app root would wrap
 * the authenticated `(app)` group in a Suspense boundary too, and a `redirect()`
 * thrown inside a Suspense boundary is delivered client-side (HTTP 200 plus a
 * meta refresh, with the flight payload already containing protected content)
 * instead of as the 307 the session guard exists to produce. The guard's
 * contract — unauthenticated requests never receive dashboard content at the
 * protected URL — is asserted by `e2e/smoke.spec.ts`, and a root-level loading
 * file broke it. Scoping the skeleton to the guard-free public group keeps the
 * loading affordance where no redirect can be downgraded.
 *
 * A polite live region with skeleton blocks in the product's own surface
 * tokens — no fake progress, no misleading percentages, just "loading"
 * announced once and a layout that does not jump when the content arrives.
 */
export default function SiteLoading(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading…"
      className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4 px-4 py-8 md:px-8"
    >
      <div className="h-8 w-2/3 animate-pulse rounded-md bg-sunken" />
      <div className="h-4 w-full animate-pulse rounded-md bg-sunken" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="h-28 animate-pulse rounded-lg border border-hairline bg-raised" />
        <div className="h-28 animate-pulse rounded-lg border border-hairline bg-raised" />
        <div className="h-28 animate-pulse rounded-lg border border-hairline bg-raised" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
