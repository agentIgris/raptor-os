import { describe, expect, it } from "vitest";

import type { AuditEntry } from "./taxonomy.js";
import type { AuditQuery } from "./log.js";
import { createAppendOnlyLog, createAuditEntry, validateAuditEntry } from "./log.js";

const AT = new Date("2026-06-15T12:00:00.000Z");

function draft(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "aud_1",
    organizationId: "org_1",
    occurredAt: AT,
    actorType: "user",
    actorId: "person_1",
    actorName: "A. Player",
    actorRole: "team_manager",
    actionClass: "money",
    action: "payout_recorded",
    resourceType: "payout",
    resourceId: "pay_9",
    scope: { type: "team", id: "team_7" },
    before: null,
    after: { status: "recorded" },
    reason: "Tournament 4 placement payout",
    correlationId: "corr_1",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    ...overrides,
  };
}

describe("createAuditEntry", () => {
  it("freezes the entry so a handler cannot mutate what it just logged", () => {
    const entry = createAuditEntry(draft());
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it("validates the class/action pairing on the way in", () => {
    expect(() => createAuditEntry(draft({ action: "login" as AuditEntry["action"] }))).toThrow(/login/);
  });

  it("requires a correlation id, because an unlinkable row cannot be investigated", () => {
    expect(() => createAuditEntry(draft({ correlationId: "" }))).toThrow(/correlationId/);
  });

  it("requires an organisation id, so a row can never be tenant-less", () => {
    expect(() => createAuditEntry(draft({ organizationId: "" }))).toThrow(/organizationId/);
  });

  it("requires an actor name snapshot alongside the id", () => {
    expect(() => createAuditEntry(draft({ actorName: null }))).toThrow(/actorName/);
  });

  it("allows a null actor only for system actors, which have no person behind them", () => {
    expect(() => createAuditEntry(draft({ actorType: "system", actorId: null, actorName: null }))).not.toThrow();
    expect(() => createAuditEntry(draft({ actorType: "user", actorId: null }))).toThrow(/actorId/);
  });

  it("keeps before/after null for a non-mutating class instead of inventing {} ", () => {
    const entry = createAuditEntry(
      draft({ actionClass: "authentication", action: "login", before: null, after: null }),
    );
    expect(entry.before).toBeNull();
    expect(entry.after).toBeNull();
  });
});

describe("validateAuditEntry", () => {
  it("returns the entry unchanged when it is valid, so it composes in a pipeline", () => {
    const entry = draft();
    expect(validateAuditEntry(entry)).toBe(entry);
  });

  it("rejects a non-Date occurredAt rather than coercing it", () => {
    expect(() => validateAuditEntry(draft({ occurredAt: "2026-06-15" as unknown as Date }))).toThrow(/occurredAt/);
  });

  it("rejects an invalid Date", () => {
    expect(() => validateAuditEntry(draft({ occurredAt: new Date("nonsense") }))).toThrow(/occurredAt/);
  });

  it("rejects a scope that names a row without an id", () => {
    expect(() => validateAuditEntry(draft({ scope: { type: "team", id: null } }))).toThrow(/scope/);
  });

  it("rejects an id on self scope", () => {
    expect(() => validateAuditEntry(draft({ scope: { type: "self", id: "person_1" } }))).toThrow(/scope/);
  });

  it("rejects an unknown actor type", () => {
    expect(() => validateAuditEntry(draft({ actorType: "robot" as AuditEntry["actorType"] }))).toThrow(/actorType/);
  });

  it("rejects an unknown scope type", () => {
    expect(() => validateAuditEntry(draft({ scope: { type: "planet" as never, id: "p1" } }))).toThrow(/planet/);
  });

  it("accepts a well-formed self scope", () => {
    expect(() => validateAuditEntry(draft({ scope: { type: "self", id: null } }))).not.toThrow();
  });
});

describe("the append-only log", () => {
  it("exposes insert and read, and structurally no update or delete", () => {
    const log = createAppendOnlyLog();
    expect(Object.keys(log).sort()).toEqual(["insert", "read"]);
    expect("update" in log).toBe(false);
    expect("delete" in log).toBe(false);
    expect("upsert" in log).toBe(false);
    expect("truncate" in log).toBe(false);
  });

  it("returns a frozen log object, so methods cannot be replaced later", () => {
    const log = createAppendOnlyLog();
    expect(Object.isFrozen(log)).toBe(true);
  });

  it("reads back what was inserted, in append order", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft({ id: "aud_1" })));
    log.insert(createAuditEntry(draft({ id: "aud_2", action: "payout_failed" })));
    expect(log.read({ organizationId: "org_1" }).map((entry) => entry.id)).toEqual(["aud_1", "aud_2"]);
  });

  it("starts empty", () => {
    expect(createAppendOnlyLog().read({ organizationId: "org_1" })).toEqual([]);
  });

  it("rejects a duplicate id, because an append-only log has no upsert", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft({ id: "aud_1" })));
    expect(() => log.insert(createAuditEntry(draft({ id: "aud_1" })))).toThrow(/aud_1/);
    expect(log.read({ organizationId: "org_1" })).toHaveLength(1);
  });

  it("freezes stored entries and the returned list", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft()));
    expect(Object.isFrozen(log.read({ organizationId: "org_1" })[0])).toBe(true);
    expect(Object.isFrozen(log.read({ organizationId: "org_1" }))).toBe(true);
  });

  it("filters reads by organisation, so one tenant cannot read another's log", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft({ id: "aud_1", organizationId: "org_1" })));
    log.insert(createAuditEntry(draft({ id: "aud_2", organizationId: "org_2" })));
    expect(log.read({ organizationId: "org_1" }).map((entry) => entry.id)).toEqual(["aud_1"]);
    expect(log.read({ organizationId: "org_3" })).toEqual([]);
  });

  it("requires an organisation filter rather than defaulting to every tenant's log", () => {
    // A filter that defaults to "every tenant" is a cross-tenant leak waiting for
    // the call site that forgets the argument, so an absent one must throw.
    expect(() => createAppendOnlyLog().read({} as AuditQuery)).toThrow(/organizationId/);
    expect(() => createAppendOnlyLog().read({ organizationId: "" })).toThrow(/organizationId/);
  });

  it("filters by action class, action, actor and correlation id", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft({ id: "aud_1", actionClass: "money", action: "payout_recorded" })));
    log.insert(createAuditEntry(draft({ id: "aud_2", actionClass: "authentication", action: "login", actorId: "person_2" })));
    log.insert(createAuditEntry(draft({ id: "aud_3", correlationId: "corr_9" })));

    expect(log.read({ organizationId: "org_1", actionClass: "authentication" }).map((e) => e.id)).toEqual(["aud_2"]);
    expect(log.read({ organizationId: "org_1", action: "login" }).map((e) => e.id)).toEqual(["aud_2"]);
    expect(log.read({ organizationId: "org_1", actorId: "person_2" }).map((e) => e.id)).toEqual(["aud_2"]);
    expect(log.read({ organizationId: "org_1", correlationId: "corr_9" }).map((e) => e.id)).toEqual(["aud_3"]);
  });

  it("filters by resource type alone, which is how one table's history is assembled", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft({ id: "aud_1", resourceType: "payout", resourceId: "pay_1" })));
    log.insert(createAuditEntry(draft({ id: "aud_2", resourceType: "invoice", resourceId: "inv_1" })));
    expect(log.read({ organizationId: "org_1", resourceType: "invoice" }).map((e) => e.id)).toEqual(["aud_2"]);
  });

  it("excludes entries older than `from` when a window is given", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft({ id: "aud_1", occurredAt: new Date("2025-01-01T00:00:00.000Z") })));
    log.insert(createAuditEntry(draft({ id: "aud_2", occurredAt: new Date("2026-06-01T00:00:00.000Z") })));
    const found = log.read({ organizationId: "org_1", from: new Date("2026-01-01T00:00:00.000Z") });
    expect(found.map((e) => e.id)).toEqual(["aud_2"]);
  });

  it("filters by resource, which is how one player's history is assembled", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft({ id: "aud_1", resourceId: "pay_1" })));
    log.insert(createAuditEntry(draft({ id: "aud_2", resourceId: "pay_2" })));
    expect(log.read({ organizationId: "org_1", resourceType: "payout", resourceId: "pay_2" }).map((e) => e.id)).toEqual([
      "aud_2",
    ]);
  });

  it("filters by time window, half-open, matching the effective-dating convention", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft({ id: "aud_1", occurredAt: new Date("2026-01-01T00:00:00.000Z") })));
    log.insert(createAuditEntry(draft({ id: "aud_2", occurredAt: new Date("2026-06-01T00:00:00.000Z") })));
    log.insert(createAuditEntry(draft({ id: "aud_3", occurredAt: new Date("2026-12-01T00:00:00.000Z") })));

    const found = log.read({
      organizationId: "org_1",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-12-01T00:00:00.000Z"),
    });
    expect(found.map((e) => e.id)).toEqual(["aud_1", "aud_2"]);
  });

  it("requires from to be no later than to", () => {
    const log = createAppendOnlyLog();
    log.insert(createAuditEntry(draft()));
    expect(() =>
      log.read({
        organizationId: "org_1",
        from: new Date("2026-12-01T00:00:00.000Z"),
        to: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/from/);
  });

  it("insert validates a hand-built entry the caller skipped createAuditEntry for", () => {
    const log = createAppendOnlyLog();
    expect(() => log.insert(draft({ correlationId: "" }))).toThrow(/correlationId/);
    expect(log.read({ organizationId: "org_1" })).toEqual([]);
  });

  it("returns the stored entry from insert, so a handler can log and reference in one step", () => {
    const log = createAppendOnlyLog();
    const inserted = log.insert(createAuditEntry(draft()));
    expect(inserted.id).toBe("aud_1");
  });

  it("keeps each log independent", () => {
    const first = createAppendOnlyLog();
    const second = createAppendOnlyLog();
    first.insert(createAuditEntry(draft({ id: "aud_1" })));
    expect(second.read({ organizationId: "org_1" })).toEqual([]);
  });
});