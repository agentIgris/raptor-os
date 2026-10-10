/**
 * Structural guarantees for the content package, tested rather than asserted in
 * prose.
 *
 * The mutator check follows `contracts/structure.test.ts`. The clock check is the
 * one that matters most here: "publish time is a parameter, never `Date.now()`" is
 * a promise about the *source*, and the only way to keep a promise about source is
 * to read the source.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as content from "./index.js";

/** Reads a module's own source, so a guarantee about the text can be tested. */
function sourceOf(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/**
 * Names that would mean "change an existing record in place".
 *
 * `retract` is absent from the pattern because this package has no retraction
 * path at all: cancelling a schedule *appends* a `ScheduleCancellation` and is
 * named `unschedule*`, which is listed below rather than pattern-matched.
 */
const MUTATOR_PATTERN = /(amend|update|mutate|delete|remove|patch|purge|void|rewrite|backdate|overwrite|undo|correct)/i;

const ALLOWED_EDIT_LIKE = new Set(["unschedulePublication"]);

describe("the content package exports no in-place mutator", () => {
  it("exports nothing named as an edit, a delete or a correction", () => {
    const offenders = Object.keys(content).filter(
      (name) => !ALLOWED_EDIT_LIKE.has(name) && MUTATOR_PATTERN.test(name),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist honest: every listed name still exists", () => {
    for (const name of ALLOWED_EDIT_LIKE) {
      expect(name in content).toBe(true);
    }
  });

  it("demonstrates that cancelling a schedule appends and leaves the schedule alone", () => {
    const scheduled = content.schedulePublication({
      contentId: "content_1",
      organizationId: "org_1",
      publishAt: new Date("2026-04-05T09:00:00.000Z"),
      at: new Date("2026-04-01T09:00:00.000Z"),
      scheduledBy: "person_editor",
    });

    const cancelled = content.unschedulePublication({
      schedule: scheduled,
      at: new Date("2026-04-02T09:00:00.000Z"),
      cancelledBy: "person_editor",
      reason: "embargo moved",
    });

    expect(cancelled).not.toBe(scheduled);
    expect(scheduled.publishAt.toISOString()).toBe("2026-04-05T09:00:00.000Z");
  });
});

describe("no module in this package reads a clock", () => {
  // "Publish time is a parameter, never `Date.now()`" is a claim about the source
  // text, and a claim about source text is only checkable by reading source text.
  // A behavioural test cannot catch a `Date.now()` used only on a branch the
  // suite happens not to take.
  const MODULES = ["./lifecycle.ts", "./approval.ts", "./item.ts", "./scheduling.ts", "./creator.ts"] as const;

  it.each(MODULES)("%s contains no clock read", (modulePath) => {
    const source = sourceOf(modulePath);

    // `Date.now(`, `new Date()` with no argument, and `performance.now()` are the
    // three ways to reach the wall clock from pure code. Comments are stripped
    // first so a sentence *about* `Date.now()` does not trip the check.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/performance\.now\s*\(/);
    expect(code).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });

  it("still has real code after the comments are stripped, so the check is not vacuous", () => {
    // A check that passes because the file is entirely comments passes forever.
    const code = sourceOf("./scheduling.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(code).toContain("export function schedulePublication");
    expect(code.length).toBeGreaterThan(1000);
  });
});

describe("a creator is a person, and only one identity exists here", () => {
  it("keys the creator profile on a personId and carries no other identity field", () => {
    // ADR-0018: two competing identity models, nothing joining them, and a
    // function that could not execute. A third would be the same defect again.
    const profile = content.createCreatorProfile({
      creatorProfileId: "creator_profile_1",
      organizationId: "org_1",
      personId: "person_creator",
      handle: "@raptor",
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
    });

    expect(Object.keys(profile)).toContain("personId");
    expect(Object.keys(profile)).not.toContain("email");
    expect(Object.keys(profile)).not.toContain("userId");
    expect(Object.keys(profile)).not.toContain("identityId");
  });

  it("keys the content item on the same person id space as the profile", () => {
    const item = content.createContentItem({
      contentId: "content_1",
      organizationId: "org_1",
      creatorPersonId: "person_creator",
      title: "Grand final highlights",
      createdAt: new Date("2026-03-20T08:00:00.000Z"),
    });

    const profile = content.createCreatorProfile({
      creatorProfileId: "creator_profile_1",
      organizationId: "org_1",
      personId: "person_creator",
      handle: "@raptor",
      createdAt: new Date("2026-01-05T00:00:00.000Z"),
    });

    // One person, two records, the same identifier. That is the whole requirement.
    expect(item.creatorPersonId).toBe(profile.personId);
  });

  it("refuses a content item whose creator is not named", () => {
    expect(() =>
      content.createContentItem({
        contentId: "content_1",
        organizationId: "org_1",
        creatorPersonId: "",
        title: "Grand final highlights",
        createdAt: new Date("2026-03-20T08:00:00.000Z"),
      }),
    ).toThrow(/creatorPersonId/i);
  });

  it("refuses a content item with no identity, title or creation instant", () => {
    const base = {
      contentId: "content_1",
      organizationId: "org_1",
      creatorPersonId: "person_creator",
      title: "Grand final highlights",
      createdAt: new Date("2026-03-20T08:00:00.000Z"),
    };

    // An unnamed, untitled or undated item cannot be reviewed, scheduled or
    // published, and each of those is discovered at the far end of a workflow
    // rather than at the point somebody wrote it.
    expect(() => content.createContentItem({ ...base, contentId: " " })).toThrow(/contentId/i);
    expect(() => content.createContentItem({ ...base, organizationId: "" })).toThrow(/organizationId/i);
    expect(() => content.createContentItem({ ...base, title: "  " })).toThrow(/title/i);
    expect(() => content.createContentItem({ ...base, createdAt: new Date("never") })).toThrow(/createdAt/i);
  });

  it("refuses an approval of nothing at all", () => {
    // A null item would otherwise surface as a property access on the next line,
    // which is a crash rather than a message.
    expect(() =>
      content.approveContent({ content: null as never, approvedBy: "person_editor", at: new Date(0) }),
    ).toThrow(/requires the item/i);
  });

  it("carries no state on the content item, because state is replayed from transitions", () => {
    const item = content.createContentItem({
      contentId: "content_1",
      organizationId: "org_1",
      creatorPersonId: "person_creator",
      title: "Grand final highlights",
      createdAt: new Date("2026-03-20T08:00:00.000Z"),
    });

    expect(Object.keys(item).sort()).toEqual(["contentId", "createdAt", "creatorPersonId", "organizationId", "title"]);
  });
});

describe("the editorial controls are reachable from the package entry point", () => {
  it("exposes the table, the separation-of-duties guard and the schedule boundary together", () => {
    for (const name of [
      "canTransition",
      "isIrreversibleTransition",
      "approveContent",
      "schedulePublication",
      "isDueForPublication",
      "createContentItem",
      "createCreatorProfile",
    ] as const) {
      expect(typeof content[name]).toBe("function");
    }
  });

  it("exposes the transition table itself, not only a predicate over it", () => {
    expect(Object.keys(content.CONTENT_TRANSITIONS)).toEqual([...content.CONTENT_STATES]);
  });
});