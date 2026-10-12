import type { Metadata } from "next";
import * as React from "react";

import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@raptor/ui";

import { getCurrentSession } from "../../../server/session";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Raptor OS with your organisation account.",
};

export const dynamic = "force-dynamic";

/**
 * Sign-in.
 *
 * Already-authenticated visitors are sent to the dashboard rather than shown a
 * form they do not need. The session comes from the httpOnly cookie via the
 * server; nothing on this page reads a token from the client.
 */
export default async function SignInPage(): Promise<React.JSX.Element> {
  const session = await getCurrentSession();

  return (
    <div className="mx-auto flex w-full max-w-[32rem] min-w-0 flex-col gap-4 py-4">
      <nav aria-label="Breadcrumb">
        <a
          href="/"
          className="inline-flex min-h-11 touch-manipulation items-center rounded-md px-2 py-2 text-[length:var(--text-sm)] font-medium text-ink-muted underline-offset-4 transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:bg-sunken hover:text-ink hover:underline"
        >
          ← Back to the overview
        </a>
      </nav>
      <Card labelledBy="sign-in-heading">
        <CardHeader>
          <CardTitle id="sign-in-heading">Sign in to Raptor OS</CardTitle>
          <CardDescription>
            Your session is held in an httpOnly cookie. It is never written to browser storage,
            so a script in this page cannot read it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-6">
          {session === null ? (
            <SignInForm callbackUrl="/dashboard" />
          ) : (
            <Alert tone="success">
              <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)] break-words">
                You are already signed in as <span className="font-medium break-words">{session.email}</span>.{" "}
                <a
                  className="font-medium underline underline-offset-4"
                  href="/dashboard"
                >
                  Go to the dashboard
                </a>
                .
              </p>
            </Alert>
          )}
        </CardContent>
      </Card>
      {session === null ? (
        <p className="text-pretty text-center text-[length:var(--text-xs)] leading-[var(--leading-normal)] break-words text-ink-muted">
          Protected by session cookies. Contact an organisation owner if you cannot sign in.
        </p>
      ) : (
        <Button asChild variant="outline" className="w-full">
          <a href="/dashboard">Go to the dashboard</a>
        </Button>
      )}
    </div>
  );
}
