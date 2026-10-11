/**
 * @vitest-environment jsdom
 *
 * `cn()` — the class-merge helper, and the bug it once caused.
 *
 * WHAT HAPPENED
 * -------------
 * The primary button rendered with the WRONG TEXT COLOUR. Its classes were:
 *
 *   bg-[var(--accent-base)] text-[var(--text-on-accent)] px-4 text-[var(--text-sm)]
 *
 * `tailwind-merge` classifies a bare `text-[var(--x)]` as a **colour**, not a
 * font size. Measured against the installed version rather than assumed:
 *
 *   twMerge(["text-on-accent", "text-[var(--text-sm)]"])      -> "text-[var(--text-sm)]"
 *   twMerge(["text-accent",   "text-[var(--text-sm)]"])      -> "text-[var(--text-sm)]"
 *   twMerge(["text-accent",   "text-sm"])                     -> "text-accent text-sm"
 *   twMerge(["text-accent",   "text-[length:var(--text-sm)]"]) -> both survive
 *
 * So the later size class silently WON and the colour was dropped from the DOM.
 * The button inherited `color: #10131a` — near-black on a violet fill — and a
 * primary call to action shipped at 2.35:1. axe-core in a real browser caught
 * it. Nothing in the unit tests did: the component test asserted on the class
 * NAME (`toContain("min-h-11")`) and never on the rendered colour.
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * Every font-size utility carries an explicit `[length:...]` type hint, and
 * every colour utility is a plain name. The hint is what tells `tailwind-merge`
 * — and Tailwind — which property is being set, and it is what stops one of
 * them from deleting the other.
 */

import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn — colour and size must never collide", () => {
  it("keeps a named colour alongside a type-hinted font size", () => {
    // This is the exact shape of class list the primary button ships.
    const result = cn("bg-accent", "text-on-accent", "px-4", "text-[length:var(--text-sm)]");

    expect(result).toContain("bg-accent");
    expect(result).toContain("text-on-accent");
    expect(result).toContain("text-[length:var(--text-sm)]");
    expect(result).toContain("px-4");
  });

  it("a bare arbitrary text utility would silently delete the colour — this is that bug", () => {
    // Asserted so the regression cannot return unnoticed. If a future
    // tailwind-merge changes this behaviour, THIS test is what tells you the
    // type hints can be dropped — rather than the hint-free version quietly
    // shipping an unreadable button again.
    expect(cn("bg-accent", "text-on-accent", "text-[var(--text-sm)]")).not.toContain("text-on-accent");
    expect(cn("bg-accent", "text-on-accent", "text-[length:var(--text-sm)]")).toContain("text-on-accent");
  });

  it("resolves a genuine colour conflict — the caller's value wins", () => {
    // The point of using tailwind-merge at all: an override beats a default.
    expect(cn("bg-accent", "bg-danger")).toBe("bg-danger");
    expect(cn("text-ink-muted", "text-danger")).toBe("text-danger");
  });

  it("resolves a genuine size conflict without touching colour", () => {
    expect(cn("text-[length:var(--text-sm)]", "text-[length:var(--text-xs)]")).toBe(
      "text-[length:var(--text-xs)]",
    );
  });

  it("does not treat a border width as a border colour", () => {
    expect(cn("border", "border-control")).toBe("border border-control");
  });

  it("handles conditional inputs", () => {
    const excluded = false as boolean;
    expect(cn("a", excluded && "b", undefined, null, ["c"], { d: true, e: false })).toBe("a c d");
  });
});