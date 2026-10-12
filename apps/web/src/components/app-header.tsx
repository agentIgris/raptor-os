"use client";

import { usePathname, useRouter } from "next/navigation";
import * as React from "react";

import { Badge, BrandMark, PrimaryNav, ThemeToggle } from "@raptor/ui";
import { createAuthClient } from "better-auth/react";

export interface AppHeaderProps {
  readonly email: string;
  readonly role: string;
  readonly twoFactorEnabled: boolean;
}

const APP_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/", label: "Overview" },
  { href: "/sign-in", label: "Sign in" },
] as const;

/**
 * Authenticated app header.
 *
 * Two fixes over the legacy layout:
 * 1. the active link is derived from the pathname instead of hardcoded, and
 * 2. an authenticated user can actually leave — the legacy header rendered
 *    the session summary as static text with no sign-out control.
 *
 * Sign-out uses Better Auth's client (`/api/auth/*` + httpOnly cookie). No
 * token is read or stored here; on success the router replaces onto sign-in
 * and refreshes so the server guard re-runs.
 */
export function AppHeader({ email, role, twoFactorEnabled }: AppHeaderProps): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);
  const [signOutError, setSignOutError] = React.useState<string | null>(null);

  const items = APP_LINKS.map((link) => ({
    ...link,
    current: pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href)),
  }));

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
      router.replace("/sign-in");
      router.refresh();
    } catch {
      setSignOutError("Sign-out failed. Try again.");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-canvas">
      <div className="mx-auto w-full max-w-6xl">
        <PrimaryNav
          brand={
            <a
              href="/dashboard"
              className="flex min-h-11 touch-manipulation items-center gap-2 text-[length:var(--text-md)] font-bold tracking-[var(--tracking-tight)] break-words text-ink no-underline"
            >
              <span className="text-accent">
                <BrandMark />
              </span>
              <span translate="no">Raptor&nbsp;OS</span>
            </a>
          }
          items={items}
          actions={
            <span className="flex items-center gap-2">
              <ThemeToggle />
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
            </span>
          }
        />
      </div>
      {/*
        Session summary: role + MFA as text with badges (colour is never the
        only signal), no token, no session id. The sign-out error is a polite
        live region so it is announced without stealing focus.
      */}
      <div className="border-t border-hairline">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-4 py-2 text-[length:var(--text-xs)] break-words text-ink-muted md:px-6">
          <span className="min-w-0 break-words">{email}</span>
          <Badge tone={role === "pending" ? "warning" : "accent"}>{role}</Badge>
          <Badge tone={twoFactorEnabled ? "success" : "neutral"}>
            {twoFactorEnabled ? "MFA enrolled" : "MFA not enrolled"}
          </Badge>
          {signOutError === null ? null : (
            <span role="status" className="font-medium text-danger">
              {signOutError}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
