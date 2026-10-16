"use client";

import * as React from "react";

import { switchActiveOrg, type RecentOrg } from "../../server/org-actions";

/**
 * Organisation switcher.
 *
 * A native `<details>` disclosure: no state, works pre-hydration, announces
 * expanded/collapsed by itself. Recent organisations (server-read cookie) get
 * one-button forms; anything else goes through the id form. Failures render
 * inline via `useActionState` — never a redirect into an org the account does
 * not belong to, because the failure never navigates at all.
 */
export function OrgSwitcher({
  currentOrgId,
  currentOrgName,
  recents,
}: {
  readonly currentOrgId: string | null;
  readonly currentOrgName: string;
  readonly recents: readonly RecentOrg[];
}): React.JSX.Element {
  const [error, dispatch, pending] = React.useActionState(switchActiveOrg, null);
  const others = recents.filter((entry) => entry.id !== currentOrgId);

  return (
    <details className="group min-w-0">
      <summary className="flex min-h-11 cursor-pointer touch-manipulation list-none items-center gap-2 rounded-md px-3 py-2 text-[length:var(--text-sm)] font-medium text-ink-muted hover:bg-sunken hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 truncate" translate="no">
          {currentOrgName}
        </span>
        <span aria-hidden="true" className="text-ink-faint transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="mt-1 flex min-w-0 flex-col gap-3 rounded-md border border-hairline bg-raised p-3">
        {others.length > 0 ? (
          <ul className="flex min-w-0 flex-col gap-1">
            {others.map((entry) => (
              <li key={entry.id}>
                <form action={dispatch}>
                  <input type="hidden" name="orgId" value={entry.id} />
                  <button
                    type="submit"
                    disabled={pending}
                    className="flex min-h-11 w-full cursor-pointer touch-manipulation items-center rounded-md px-3 py-2 text-left text-[length:var(--text-sm)] text-ink hover:bg-sunken disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate" translate="no">
                      {entry.name}
                    </span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[length:var(--text-xs)] text-ink-muted">No other recent organisations.</p>
        )}
        <form action={dispatch} className="flex min-w-0 flex-col gap-2 border-t border-hairline pt-3">
          <label htmlFor="org-switch-id" className="text-[length:var(--text-xs)] font-medium text-ink-muted">
            Switch by organisation id
          </label>
          <span className="flex min-w-0 gap-2">
            <input
              id="org-switch-id"
              name="orgId"
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="min-h-11 min-w-0 flex-1 rounded-md border border-control bg-canvas px-3 font-mono text-[length:var(--text-xs)] text-ink"
            />
            <button
              type="submit"
              disabled={pending}
              className="inline-flex min-h-11 shrink-0 cursor-pointer touch-manipulation items-center rounded-md border border-control bg-canvas px-3 text-[length:var(--text-sm)] font-medium text-ink hover:bg-sunken disabled:pointer-events-none disabled:opacity-50"
            >
              {pending ? "…" : "Switch"}
            </button>
          </span>
        </form>
        {error === null ? null : (
          <p role="alert" className="text-[length:var(--text-xs)] font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

