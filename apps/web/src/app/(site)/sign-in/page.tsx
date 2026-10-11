import type { Metadata } from "next";
import * as React from "react";

import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@raptor/ui";

import { getCurrentSession } from "../../../server/session";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
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
    <div className="mx-auto flex w-full max-w-[32rem] flex-col gap-6">
      <Card labelledBy="sign-in-heading">
        <CardHeader>
          <CardTitle id="sign-in-heading">Sign in to Raptor OS</CardTitle>
          <CardDescription>
            Your session is held in an httpOnly cookie. It is never written to browser storage,
            so a script in this page cannot read it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {session === null ? (
            <SignInForm callbackUrl="/dashboard" />
          ) : (
            <Alert tone="success">
              <p className="text-[length:var(--text-sm)] leading-[var(--leading-normal)]">
                You are already signed in as {session.email}.{" "}
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
    </div>
  );
}