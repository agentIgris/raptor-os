/**
 * @vitest-environment jsdom
 *
 * axe-core over every primitive.
 *
 * This is the "accessible by default" claim, checked rather than asserted.
 * Each primitive is rendered into a realistic page context (the landmarks a
 * real page provides) and axe is run over it.
 *
 * LIMITATION, stated plainly: under jsdom, axe's `color-contrast` rule returns
 * `incomplete` rather than a verdict, because there is no layout engine and
 * no real painted background. Colour contrast is verified for real in two
 * places instead — `src/tokens.test.ts` computes every token pair's WCAG ratio
 * from the shipped values, and `apps/web/e2e/a11y.spec.ts` runs this same
 * engine over the rendered routes in Chromium at three viewports. The
 * assertion at the bottom of this file keeps that gap explicit: if axe ever
 * reports `color-contrast` as *violating* here, that is a genuine regression
 * and it fails the test.
 */

import axe from "axe-core";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Alert } from "../components/alert";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/card";
import { Main, PageFooter, PageHeader, SkipLink } from "../components/app-shell";
import { PrimaryNav } from "../components/primary-nav";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeaderCell, TableRow } from "../components/table";
import { TextField } from "../components/text-field";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function audit(): Promise<axe.AxeResults> {
  setDocumentTitle();
  return await axe.run(document, {
    runOnly: { type: "tag", values: TAGS },
    resultTypes: ["violations", "incomplete"],
  });
}

function report(results: axe.AxeResults): string {
  return results.violations
    .map(
      (violation) =>
        `  [${String(violation.impact)}] ${violation.id} — ${violation.help}\n` +
        violation.nodes.map((node) => `      ${node.target.join(" ")}`).join("\n"),
    )
    .join("\n");
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("class");
});

/**
 * Give the test document a `<title>`.
 *
 * axe's `document-title` rule is a real rule about a real page, and it fires
 * here only because a jsdom document has no `<head><title>`. Adding one keeps
 * the rule active — so if the application's root layout ever loses its
 * `metadata.title`, the browser run still catches it — without every case in
 * this file having to explain a failure that is about the harness.
 */
function setDocumentTitle(): void {
  let title = document.querySelector("title");
  if (title === null) {
    title = document.createElement("title");
    document.head.append(title);
  }
  title.textContent = "Primitives";
  document.documentElement.setAttribute("lang", "en");
}

describe("axe-core over the primitive set", () => {
  it("Button: no violations", async () => {
    render(
      <Main>
        <h1>Primitives</h1>
        <Button>Save</Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Delete</Button>
        <Button variant="link">A link that looks like a button</Button>
        <Button disabled>Disabled</Button>
      </Main>,
    );
    const results = await audit();
    expect(results.violations, report(results)).toEqual([]);
  });

  it("Button: an icon-only control with a name has no violations", async () => {
    render(
      <Main>
        <h1>Primitives</h1>
        <Button size="icon" aria-label="Close">
          <svg aria-hidden="true" />
        </Button>
      </Main>,
    );
    const results = await audit();
    expect(results.violations, report(results)).toEqual([]);
  });

  it("Card with a heading: no violations", async () => {
    render(
      <Main>
        <h1>Primitives</h1>
        <Card labelledBy="card-heading">
          <CardHeader>
            <CardTitle id="card-heading">Allocation</CardTitle>
            <CardDescription>Largest remainder.</CardDescription>
          </CardHeader>
          <CardContent>
            <p>Content</p>
          </CardContent>
        </Card>
      </Main>,
    );
    const results = await audit();
    expect(results.violations, report(results)).toEqual([]);
  });

  it("Badges: no violations — colour is never the only signal", async () => {
    render(
      <Main>
        <h1>Primitives</h1>
        <p>
          <Badge>neutral</Badge> <Badge tone="accent">accent</Badge>{" "}
          <Badge tone="success">present</Badge> <Badge tone="warning">late</Badge>{" "}
          <Badge tone="danger">absent</Badge> <Badge tone="info">info</Badge>
        </p>
      </Main>,
    );
    // Each badge carries its own text, so the status is legible without colour.
    expect(screen.getByText("absent")).toBeInTheDocument();
    const results = await audit();
    expect(results.violations, report(results)).toEqual([]);
  });

  it("Alert: no violations", async () => {
    render(
      <Main>
        <h1>Primitives</h1>
        <Alert tone="danger" politeness="assertive">
          <p>Reconciliation variance must be resolved.</p>
        </Alert>
        <Alert tone="info">
          <p>Allocation recomputed.</p>
        </Alert>
      </Main>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    const results = await audit();
    expect(results.violations, report(results)).toEqual([]);
  });

  it("TextField: no violations with and without an error", async () => {
    render(
      <Main>
        <h1>Primitives</h1>
        <TextField id="ok" label="Email address" hint="Work address." />
        <TextField id="bad" label="Password" error="Too short." required />
      </Main>,
    );
    const results = await audit();
    expect(results.violations, report(results)).toEqual([]);
  });

  it("Table: no violations", async () => {
    render(
      <Main>
        <h1>Primitives</h1>
        <Table label="Roster">
          <TableCaption>Attendance for the 14 June session.</TableCaption>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Handle</TableHeaderCell>
              <TableHeaderCell>Attendance</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow>
              <TableCell scope="row">kirra</TableCell>
              <TableCell>
                <Badge tone="success">present</Badge>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Main>,
    );
    const results = await audit();
    expect(results.violations, report(results)).toEqual([]);
  });

  it("PrimaryNav and the full landmark set: no violations", async () => {
    render(
      <>
        <SkipLink href="#main" />
        <header>
          <PrimaryNav
            brand={<a href="/">Raptor OS</a>}
            items={[{ href: "/", label: "Overview", current: true }]}
          />
        </header>
        <Main>
          <PageHeader title="Dashboard" description="Prize position." />
        </Main>
        <PageFooter>
          <p>Footer</p>
        </PageFooter>
      </>,
    );

    document.documentElement.setAttribute("lang", "en");
    const results = await audit();
    expect(results.violations, report(results)).toEqual([]);
  });
});

describe("axe-core coverage limits", () => {
  it("records exactly which rules jsdom cannot answer", async () => {
    render(
      <Main>
        <h1>Primitives</h1>
        <Button>Save</Button>
      </Main>,
    );
    document.documentElement.setAttribute("lang", "en");

    const results = await audit();
    const incomplete = [...new Set(results.incomplete.map((entry) => entry.id))].sort();

    expect(incomplete).toEqual(["color-contrast"]);
  });

  it("never reports color-contrast as a violation here — if it ever does, that is real", async () => {
    // This is a guard on the guard. If a future jsdom or axe version begins to
    // evaluate contrast properly, a genuine violation must not be absorbed by
    // the blanket "incomplete is expected" allowance above.
    render(
      <Main>
        <h1>Primitives</h1>
        <Button>Save</Button>
      </Main>,
    );
    document.documentElement.setAttribute("lang", "en");

    const results = await audit();
    expect(results.violations.map((violation) => violation.id)).not.toContain("color-contrast");
  });
});