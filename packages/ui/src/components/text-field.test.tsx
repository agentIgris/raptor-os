/**
 * @vitest-environment jsdom
 *
 * TextField — the label/description/error wiring.
 *
 * A form field is the most common place for an accessibility claim to be
 * quietly wrong, because it renders correctly and still fails: a `<label>`
 * whose `htmlFor` points at the wrong id, or an error message that exists on
 * the screen and not in the accessibility tree, both look perfect in a
 * screenshot and are invisible to the user who needs them.
 */

import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { TextField } from "./text-field";

function describedByOf(field: HTMLElement): readonly string[] {
  return (field.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((value) => value !== "");
}

describe("TextField label association", () => {
  it("links the label to the input with htmlFor/id", () => {
    render(<TextField id="email" label="Email address" />);
    const field = screen.getByLabelText("Email address");
    expect(field.id).toBe("email");
    expect(field.tagName).toBe("INPUT");
  });

  it("computes an accessible name from the label, not from a placeholder", () => {
    // A placeholder is not a label. It disappears when the user types, it is
    // not reliably announced, and it fails contrast on most backgrounds.
    render(<TextField id="email" label="Email address" placeholder="you@example.com" />);
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("you@example.com")).toHaveAttribute(
      "placeholder",
      "you@example.com",
    );
  });
});

describe("TextField description and error wiring", () => {
  it("points aria-describedby at the hint", () => {
    render(<TextField id="password" label="Password" hint="At least 12 characters." />);
    const field = screen.getByLabelText("Password");
    expect(describedByOf(field)).toEqual(["password-hint"]);
    expect(document.getElementById("password-hint")).toHaveTextContent("At least 12 characters.");
  });

  it("points aria-describedby at the error when there is one", () => {
    render(<TextField id="password" label="Password" error="That password is too short." />);
    const field = screen.getByLabelText("Password");
    expect(describedByOf(field)).toEqual(["password-error"]);
    expect(document.getElementById("password-error")).toHaveTextContent("That password is too short.");
  });

  it("points at both when both are present", () => {
    // Rendering a hint but forgetting to reference it produces instructions
    // that only exist for people who can see them.
    render(<TextField id="password" label="Password" hint="At least 12 characters." error="Too short." />);
    expect(describedByOf(screen.getByLabelText("Password"))).toEqual(["password-hint", "password-error"]);
  });

  it("omits aria-describedby entirely when there is nothing to describe", () => {
    // An empty aria-describedby="" is worse than none: it references nothing.
    render(<TextField id="email" label="Email address" />);
    expect(screen.getByLabelText("Email address")).not.toHaveAttribute("aria-describedby");
  });

  it("marks the field invalid only when there is an error", () => {
    const { rerender } = render(<TextField id="email" label="Email address" />);
    expect(screen.getByLabelText("Email address")).not.toHaveAttribute("aria-invalid");

    rerender(<TextField id="email" label="Email address" error="Required." />);
    expect(screen.getByLabelText("Email address")).toHaveAttribute("aria-invalid", "true");
  });

  it("announces a late-arriving error through a live region", () => {
    render(<TextField id="email" label="Email address" error="Required." />);
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("Required.");
    expect(error.id).toBe("email-error");
  });
});

describe("TextField required state", () => {
  it("sets the required attribute", () => {
    render(<TextField id="email" label="Email address" required />);
    expect(screen.getByLabelText(/Email address/)).toBeRequired();
  });

  it("announces required in text and hides the decorative asterisk", () => {
    // The screen-reader text is the accessible name contribution; the visible
    // asterisk is decoration. Announcing "asterisk" instead of "required" is a
    // small, common and entirely avoidable failure.
    render(<TextField id="email" label="Email address" required />);
    const label = screen.getByText("Email address").closest("label");
    expect(label).not.toBeNull();

    const asterisk = label?.querySelector('[aria-hidden="true"]');
    expect(asterisk).not.toBeNull();

    const srOnly = label?.querySelector(".sr-only");
    expect(srOnly).toHaveTextContent("(required)");
  });

  it("does not add required markup when not required", () => {
    render(<TextField id="email" label="Email address" />);
    const label = screen.getByText("Email address").closest("label");
    expect(label?.querySelector(".sr-only")).toBeNull();
  });
});

describe("TextField input passthrough", () => {
  it("forwards type and autocomplete so the browser can do the right thing", () => {
    render(<TextField id="password" label="Password" type="password" autoComplete="current-password" />);
    const field = screen.getByLabelText("Password");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "current-password");
  });
});