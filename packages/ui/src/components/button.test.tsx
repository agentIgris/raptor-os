/**
 * @vitest-environment jsdom
 *
 * Button — the accessibility claims, asserted.
 *
 * Every assertion here corresponds to a specific claim made in `button.tsx`.
 * Where a claim can only be verified in a real browser (the focus ring is
 * actually painted, and is actually visible against the button's own fill) it
 * is cross-referenced rather than asserted here, and the real-browser
 * assertion lives in `apps/web/e2e/a11y.spec.ts`.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button";

describe("Button semantics", () => {
  it("renders a real <button>, so it is reachable and operable by keyboard", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.tagName).toBe("BUTTON");
    // Not a div with a click handler: that has no default Enter/Space
    // behaviour and is not announced as a button.
    expect(button).toHaveAttribute("type", "button");
  });

  it("defaults type to 'button' so it cannot submit a form by accident", () => {
    // A <button> with no type attribute defaults to type="submit". One
    // forgotten attribute is enough to submit a form and lose a draft.
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
  });

  it("still honours an explicit type", () => {
    render(<Button type="submit">Sign in</Button>);
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute("type", "submit");
  });

  it("does not submit a surrounding form when clicked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });

    render(
      <form onSubmit={onSubmit}>
        <Button>Save</Button>
      </form>,
    );

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("is activated by Enter and by Space", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    await user.tab();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe("Button focus indicator", () => {
  it("never emits an outline-none / outline-hidden utility", () => {
    // The component must not suppress the focus ring. The ring itself is
    // applied by `globals.css` to every focusable element; a component-level
    // override is the most common way a "focus-visible: none" regression gets
    // reintroduced.
    render(<Button>Save</Button>);
    const className = screen.getByRole("button", { name: "Save" }).className;
    expect(className).not.toMatch(/outline-(none|hidden|0)/);
    expect(className).not.toMatch(/ring-offset-0/);
  });

  it("keeps its classes when a caller passes className, so the ring cannot be stripped", () => {
    render(<Button className="w-full">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.className).toContain("w-full");
    // The sizing/typography contract is unchanged by the override.
    expect(button.className).toContain("min-h-11");
  });
});

describe("Button states", () => {
  it("is removed from the tab order when disabled, and does not fire", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("exposes aria-busy when a caller marks it busy", () => {
    render(<Button aria-busy>Saving…</Button>);
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-busy", "true");
  });
});

describe("Button asChild", () => {
  it("renders the child element and keeps it keyboard reachable", () => {
    render(
      <Button asChild>
        <a href="/dashboard">Dashboard</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Dashboard" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/dashboard");
    // No invalid `type` leaked onto the anchor from the button defaults.
    expect(link).not.toHaveAttribute("type");
  });

  it("keeps the min-target sizing on the link it renders", () => {
    // A link styled as a button is still an interactive control, and WCAG 2.2
    // SC 2.5.8 applies to it exactly as it applies to the button.
    render(
      <Button asChild>
        <a href="/dashboard">Dashboard</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "Dashboard" }).className).toContain("min-h-11");
  });
});

describe("Button accessible names", () => {
  it("takes its name from its content", () => {
    render(<Button>Allocate prize pool</Button>);
    expect(screen.getByRole("button", { name: "Allocate prize pool" })).toBeInTheDocument();
  });

  it("takes its name from aria-label when the content is an icon", () => {
    // An icon-only control with no name has no accessible name at all, and axe
    // reports it as `button-name`. This is the documented way to give one.
    render(
      <Button size="icon" aria-label="Close">
        <svg aria-hidden="true" data-testid="icon" />
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Close" });
    expect(button).toBeInTheDocument();
    // The decorative glyph must not be announced as well.
    expect(button.querySelector("[data-testid='icon']")).toHaveAttribute("aria-hidden", "true");
  });
});