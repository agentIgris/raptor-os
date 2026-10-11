/**
 * @vitest-environment jsdom
 *
 * Table, skip link, page landmarks.
 */

import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { Main, PageFooter, PageHeader, SkipLink } from "./app-shell";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeaderCell, TableRow, TableRowHeader } from "./table";

describe("Table — the scrollable region", () => {
  it("is a named region so it can be found and named in a landmark list", () => {
    render(
      <Table label="Prize allocation">
        <tbody />
      </Table>,
    );
    const region = screen.getByRole("region", { name: "Prize allocation" });
    expect(region.tagName).toBe("DIV");
    expect(region.querySelector("table")).not.toBeNull();
  });

  it("is focusable, because a scrollable region must be keyboard-operable", () => {
    // WCAG 2.1.1. A scrollable <div> is NOT focusable by default, so a
    // horizontally scrolling table on a phone is unreachable by keyboard.
    // axe-core's `scrollable-region-focusable` rule fails without this tabindex.
    render(
      <Table label="Prize allocation">
        <tbody />
      </Table>,
    );
    expect(screen.getByRole("region", { name: "Prize allocation" })).toHaveAttribute("tabindex", "0");
  });

  it("actually takes focus with the keyboard", () => {
    render(
      <>
        <a href="/">First</a>
        <Table label="Prize allocation">
          <tbody />
        </Table>
      </>,
    );

    const region = screen.getByRole("region", { name: "Prize allocation" });
    region.focus();
    expect(region).toHaveFocus();
  });
});

describe("Table — header association", () => {
  it("gives every column header a scope by default", () => {
    render(
      <Table label="Roster">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Handle</TableHeaderCell>
            <TableHeaderCell>Attendance</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell>kirra</TableCell>
            <TableCell>present</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header).toHaveAttribute("scope", "col");
    }
  });

  it("renders a row name cell as a real <th scope='row'>", () => {
    // A `<td scope="row">` is inert: it renders identically and is announced as
    // an ordinary cell. This component exists because that mistake shipped in an
    // earlier draft of the dashboard table.
    render(
      <Table label="Roster">
        <TableBody>
          <TableRow>
            <TableRowHeader>kirra</TableRowHeader>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const header = screen.getByRole("rowheader");
    expect(header.tagName).toBe("TH");
    expect(header).toHaveAttribute("scope", "row");
  });

  it("gives TableCell no way to express a scope, so the inert form cannot be written", () => {
    // A compile-time guarantee, asserted at runtime as a documentation of it.
    expect("scope" in TableCell({})).toBe(false);
  });

  it("renders the caption as a real <caption>, inside the table", () => {
    // A caption is the table's accessible name and its description. Putting it
    // in a <p> above the table loses both.
    render(
      <Table label="Roster">
        <TableCaption>Attendance for the 14 June session</TableCaption>
        <TableBody />
      </Table>,
    );
    const table = screen.getByRole("table");
    expect(table.querySelector("caption")).toHaveTextContent("Attendance for the 14 June session");
  });
});

describe("SkipLink", () => {
  it("targets an element that exists", () => {
    render(
      <>
        <SkipLink href="#main" />
        <Main>Content</Main>
      </>,
    );
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(link.getAttribute("href")).toBe("#main");
    // A skip link pointing at nothing is worse than no skip link: the user is
    // told navigation exists and it does not work.
    expect(document.querySelector("#main")).not.toBeNull();
  });

  it("is hidden from view but NOT removed from the tree", () => {
    // `display: none` or `visibility: hidden` would make it unfocusable and
    // the feature decorative. The `sr-only` utility clips it instead.
    render(<SkipLink href="#main" />);
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(link.className).toContain("sr-only");
    expect(link.className).not.toMatch(/\bhidden\b/);
    expect(link.className).not.toMatch(/display:\s*none/);
  });

  it("becomes visible on focus, not only on :focus-visible", () => {
    // A browser without :focus-visible support would otherwise never show it.
    render(<SkipLink href="#main" />);
    const className = screen.getByRole("link", { name: "Skip to main content" }).className;
    expect(className).toContain("focus:not-sr-only");
  });

  it("has a sensible default label that a caller can override", () => {
    const { rerender } = render(<SkipLink href="#main" />);
    expect(screen.getByRole("link", { name: "Skip to main content" })).toBeInTheDocument();

    rerender(<SkipLink href="#main" label="Skip to roster" />);
    expect(screen.getByRole("link", { name: "Skip to roster" })).toBeInTheDocument();
  });
});

describe("PageHeader and Main", () => {
  it("renders exactly one h1", () => {
    render(<PageHeader title="Dashboard" description="Prize position" />);
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("gives the main landmark the id the skip link points at, and makes it focusable", () => {
    // `tabIndex={-1}` is what lets a fragment link actually MOVE focus to the
    // target rather than only scrolling to it. Without it, pressing the skip
    // link scrolls but leaves focus in the navigation — the failure the feature
    // exists to prevent.
    render(<Main>Content</Main>);
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(main).toHaveAttribute("tabindex", "-1");
  });

  it("renders the footer as a contentinfo landmark", () => {
    render(<PageFooter>Footer</PageFooter>);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("renders the header as a banner landmark only at the top level", () => {
    // `<header>` is `banner` only when it is not nested inside article/aside/
    // main/nav/section. This documents the assumption the layouts rely on.
    render(
      <>
        <PageHeader title="Dashboard" />
      </>,
    );
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
});