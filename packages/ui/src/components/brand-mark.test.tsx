/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { BrandMark } from "./brand-mark";

describe("BrandMark", () => {
  it("is decorative by default so the adjacent brand text names the link", () => {
    render(
      <a href="/">
        <BrandMark />
        Raptor OS
      </a>,
    );
    const svg = document.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(screen.getByRole("link", { name: "Raptor OS" })).toBeInTheDocument();
  });

  it("accepts a title as an accessible name when used standalone", () => {
    render(<BrandMark title="Raptor OS home" />);
    expect(screen.getByRole("img", { name: "Raptor OS home" })).toBeInTheDocument();
  });

  it("inherits text colour and keeps a consistent stroke", () => {
    render(<BrandMark data-testid="mark" />);
    const svg = screen.getByTestId("mark");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
  });
});
