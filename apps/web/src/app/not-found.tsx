import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@raptor/ui";
import type { Metadata } from "next";
import * as React from "react";

export const metadata: Metadata = {
  title: "Not found",
  description: "The requested page does not exist in this workspace.",
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
    <div className="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col gap-6 py-12">
      <Card labelledBy="not-found-heading">
        <CardHeader>
          <CardTitle id="not-found-heading" className="text-balance">
            Page not found
          </CardTitle>
          <CardDescription>
            That address does not exist in this organisation&rsquo;s workspace. It may have been
            moved, or the link may be wrong.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <a href="/">Back to the overview</a>
            </Button>
            <Button asChild variant="outline">
              <a href="/sign-in">Sign in</a>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
