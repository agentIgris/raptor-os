/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { Container } from "./container";

describe("Container", () => {
  it("caps and centres content at the lg width by default", () => {
    render(<Container data-testid="c">x</Container>);
    const el = screen.getByTestId("c");
    expect(el.className).toContain("mx-auto");
    expect(el.className).toContain("max-w-6xl");
    expect(el.className).toContain("w-full");
  });

  it("supports md and xl widths", () => {
    const { rerender } = render(<Container data-testid="c" max="md">x</Container>);
    expect(screen.getByTestId("c").className).toContain("max-w-3xl");
    rerender(<Container data-testid="c" max="xl">x</Container>);
    expect(screen.getByTestId("c").className).toContain("max-w-7xl");
  });
});
