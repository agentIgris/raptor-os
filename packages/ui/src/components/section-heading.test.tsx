/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { SectionHeading } from "./section-heading";

describe("SectionHeading", () => {
  it("renders an h2 with the given id for aria-labelledby", () => {
    render(<SectionHeading id="roster" title="Roster" />);
    const heading = screen.getByRole("heading", { level: 2, name: "Roster" });
    expect(heading.id).toBe("roster");
  });

  it("renders the description as supporting copy", () => {
    render(<SectionHeading id="a" title="Allocation" description="Largest remainder." />);
    expect(screen.getByText("Largest remainder.")).toBeInTheDocument();
  });

  it("keeps heading order valid inside a page with an h1", () => {
    render(
      <>
        <h1>Dashboard</h1>
        <SectionHeading id="a" title="Prize position" />
      </>,
    );
    const levels = [...document.querySelectorAll("h1,h2")].map((h) => h.tagName);
    expect(levels).toEqual(["H1", "H2"]);
  });
});
