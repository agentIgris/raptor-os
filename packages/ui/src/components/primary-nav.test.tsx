/**
 * @vitest-environment jsdom
 *
 * PrimaryNav — the mobile disclosure.
 *
 * The failure mode this file exists to prevent: a slide-out navigation that is
 * visually off-screen but still in the accessibility tree, so a keyboard user
 * tabs into an invisible list of links and has no idea where they are.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { PrimaryNav, type NavItem } from "./primary-nav";

const ITEMS: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", current: true },
  { href: "/roster", label: "Roster" },
  { href: "/finance", label: "Finance" },
];

function toggle(): HTMLButtonElement {
  return screen.getByRole("button");
}

describe("PrimaryNav — structure", () => {
  it("is a named navigation landmark", () => {
    render(<PrimaryNav items={ITEMS} />);
    // The name is what distinguishes this nav from every other one once a page
    // grows a second one. An unnamed nav is a dead end for landmark
    // navigation.
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("renders every item as a link with its own visible text", () => {
    render(<PrimaryNav items={ITEMS} />);
    for (const item of ITEMS) {
      expect(screen.getByRole("link", { name: item.label })).toHaveAttribute("href", item.href);
    }
  });

  it("marks the current page with aria-current, not just a colour", () => {
    render(<PrimaryNav items={ITEMS} />);
    const current = screen.getByRole("link", { name: "Dashboard" });
    expect(current).toHaveAttribute("aria-current", "page");
    // Background colour is invisible to a screen reader; this is the actual
    // signal.
    expect(screen.getByRole("link", { name: "Roster" })).not.toHaveAttribute("aria-current");
  });
});

describe("PrimaryNav — the disclosure button", () => {
  it("is a real button, reachable and operable from the keyboard", async () => {
    const user = userEvent.setup();
    render(<PrimaryNav items={ITEMS} />);

    const button = toggle();
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");

    await user.tab();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("is operable with Space as well as Enter", async () => {
    const user = userEvent.setup();
    render(<PrimaryNav items={ITEMS} />);

    toggle().focus();
    await user.keyboard(" ");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("reflects its state in aria-expanded and points at the panel it controls", async () => {
    const user = userEvent.setup();
    render(<PrimaryNav items={ITEMS} />);

    const button = toggle();
    expect(button).toHaveAttribute("aria-expanded", "false");

    const panelId = button.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId as string)).not.toBeNull();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("has a name that changes with its state, so a screen reader announces what it will do", () => {
    render(<PrimaryNav items={ITEMS} />);
    expect(toggle()).toHaveAccessibleName("Open main menu");

    // The glyph is decorative; the accessible name comes from the sr-only text.
    const svg = toggle().querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
  });

  it("toggles closed again", async () => {
    const user = userEvent.setup();
    render(<PrimaryNav items={ITEMS} />);

    await user.click(toggle());
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("PrimaryNav — collapsed state", () => {
  it("removes the collapsed panel from the page entirely", async () => {
    const user = userEvent.setup();
    render(<PrimaryNav items={ITEMS} />);

    const panelId = toggle().getAttribute("aria-controls") as string;
    const panel = document.getElementById(panelId) as HTMLElement;

    // `hidden` (Tailwind's `display: none`) rather than a transform or a
    // negative margin: an off-screen-but-present list is still focusable, and
    // that is the defect.
    expect(panel.className).toContain("hidden");

    await user.click(toggle());
    expect(panel.className).not.toContain("hidden");
  });

  it("is above the md breakpoint, where the nav is always shown and the toggle is not offered", () => {
    // `hidden` on a focusable element takes it out of sequential focus, so the
    // toggle does not become an unreachable keyboard stop on a desktop.
    render(<PrimaryNav items={ITEMS} />);
    expect(toggle().className).toContain("md:hidden");
  });

  it("keeps the nav panel visible from md upwards", () => {
    render(<PrimaryNav items={ITEMS} />);
    const panelId = toggle().getAttribute("aria-controls") as string;
    const panel = document.getElementById(panelId) as HTMLElement;
    expect(panel.className).toContain("md:flex");
  });
});

describe("PrimaryNav — target sizes", () => {
  it("gives every nav link a 44px minimum height", () => {
    // WCAG 2.2 SC 2.5.8 asks 24x24. 44 is AAA (2.5.5) and is the number that
    // survives a thumb on a phone at a tournament.
    render(<PrimaryNav items={ITEMS} />);
    for (const item of ITEMS) {
      expect(screen.getByRole("link", { name: item.label }).className).toContain("min-h-11");
    }
  });

  it("gives the disclosure button a 44px minimum target in both dimensions", () => {
    render(<PrimaryNav items={ITEMS} />);
    expect(toggle().className).toContain("min-h-11");
    expect(toggle().className).toContain("min-w-11");
  });
});

describe("PrimaryNav — header actions", () => {
  it("renders persistent actions alongside the disclosure button", () => {
    render(<PrimaryNav items={ITEMS} actions={<button type="button">Theme</button>} />);
    expect(screen.getByRole("button", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /main menu/i })).toBeInTheDocument();
  });
});