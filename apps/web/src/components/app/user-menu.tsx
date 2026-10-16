"use client";

import * as React from "react";

import { Badge } from "@raptor/ui";
import { createAuthClient } from "better-auth/react";

export interface UserMenuProps {
  readonly email: string;
  readonly role: string;
  readonly twoFactorEnabled: boolean;
}

/**
 * Session summary and sign-out.
 *
 * Role + MFA as text with badges (colour is never the only signal), no token,
 * no session id. Sign-out uses Better Auth's client (`/api/auth/*` +
 * httpOnly cookie); on success the router replaces onto sign-in and refreshes
 * so the server guard re-runs. The failure is a polite live region so it is
 * announced without stealing focus.
 */
export function UserMenu({ email, role, twoFactorEnabled }: UserMenuProps): React.JSX.Element {
  const [signingOut, setSigningOut] = React.useState(false);
  const [signOutError, setSignOutError] = React.useState<string | null>(null);

  const onSignOut = async (): Promise<void> => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      const authClient = createAuthClient();
      const result = await authClient.signOut();
      if (result.error !== null && result.error !== undefined) {
        setSignOutError("Sign-out failed. Try again.");
        return;
      }
      window.location.assign("/sign-in");
    } catch {
      setSignOutError("Sign-out failed. Try again.");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="hidden min-w-0 truncate text-[length:var(--text-xs)] text-ink-muted sm:inline">
        {email}
      </span>
      <Badge tone={role === "pending" ? "warning" : "accent"}>{role}</Badge>
      <Badge tone={twoFactorEnabled ? "success" : "neutral"}>
        {twoFactorEnabled ? "MFA enrolled" : "MFA not enrolled"}
      </Badge>
      <button
        type="button"
        onClick={() => {
          void onSignOut();
        }}
        disabled={signingOut}
        aria-busy={signingOut}
        className="inline-flex min-h-11 cursor-pointer touch-manipulation items-center justify-center rounded-md border border-control bg-canvas px-3 text-[length:var(--text-sm)] font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:bg-sunken disabled:pointer-events-none disabled:opacity-50"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
      {signOutError === null ? null : (
        <span role="status" className="font-medium text-danger">
          {signOutError}
        </span>
      )}
    </span>
  );
}
