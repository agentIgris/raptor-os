/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { ThemeToggle } from "./theme-toggle";

describe("ThemeToggle", () => {
  it("has an accessible name and toggles the html class without storage", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const button = screen.getByRole("button", { name: "Use light theme" });
    await user.click(button);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(screen.getByRole("button", { name: "Use dark theme" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Use system theme" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("light")).toBe(false);
  });

  it("meets the 44px target", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button").className).toContain("min-h-11");
  });
});
