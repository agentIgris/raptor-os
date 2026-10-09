import { describe, expect, it } from "vitest";

import type { AuditAction, AuditActionClass, AuditEntry } from "./taxonomy.js";
import {
  AUDIT_ACTION_CLASSES,
  AUDIT_ACTION_CLASS_KEYS,
  allAuditActions,
  classOfAction,
  isAuditAction,
  isAuditActionClass,
  isSensitiveAction,
} from "./taxonomy.js";

describe("the action-class taxonomy", () => {
  it("defines exactly fifteen classes", () => {
    expect(AUDIT_ACTION_CLASS_KEYS).toHaveLength(15);
    expect(new Set(AUDIT_ACTION_CLASS_KEYS).size).toBe(15);
  });

  it("uses stable snake_case keys, because they are stored in an append-only log", () => {
    for (const key of AUDIT_ACTION_CLASS_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(isAuditActionClass(key)).toBe(true);
    }
    expect(isAuditActionClass("Prize Money")).toBe(false);
    expect(isAuditActionClass("unknown_class")).toBe(false);
  });

  it("covers the five failures the audit scored as 0 of 15", () => {
    // Authentication events were not logged app-side at all.
    expect(AUDIT_ACTION_CLASS_KEYS).toContain("authentication");
    // Permission changes wrote nothing and the endpoint was broken.
    expect(AUDIT_ACTION_CLASS_KEYS).toContain("authorization");
    // The only export produced a client-side PDF; nothing was logged.
    expect(AUDIT_ACTION_CLASS_KEYS).toContain("data_export");
    // Financial tables had no actor column at all.
    expect(AUDIT_ACTION_CLASS_KEYS).toContain("money");
    // Agreements recorded an acceptance but not the content.
    expect(AUDIT_ACTION_CLASS_KEYS).toContain("contract");
  });

  it("covers the esports-specific exposures this product actually carries", () => {
    expect(AUDIT_ACTION_CLASS_KEYS).toContain("prize_money");
    expect(AUDIT_ACTION_CLASS_KEYS).toContain("minor_consent");
    expect(AUDIT_ACTION_CLASS_KEYS).toContain("support_access");
    expect(AUDIT_ACTION_CLASS_KEYS).toContain("erasure");
  });

  it("gives every class at least one action", () => {
    for (const key of AUDIT_ACTION_CLASS_KEYS) {
      const actions = AUDIT_ACTION_CLASSES[key];
      expect(actions.length).toBeGreaterThan(0);
    }
  });

  it("gives every action a unique name across all classes, so a log row is unambiguous", () => {
    const all = allAuditActions();
    expect(new Set(all).size).toBe(all.length);
  });

  it("freezes every class list, so a consumer cannot mutate the taxonomy at runtime", () => {
    expect(Object.isFrozen(AUDIT_ACTION_CLASSES)).toBe(true);
    for (const key of AUDIT_ACTION_CLASS_KEYS) {
      expect(Object.isFrozen(AUDIT_ACTION_CLASSES[key])).toBe(true);
    }
    expect(Object.isFrozen(AUDIT_ACTION_CLASS_KEYS)).toBe(true);
  });

  it("returns actions in a stable order so a diff of the taxonomy is reviewable", () => {
    expect(allAuditActions()).toEqual([...allAuditActions()].sort());
  });
});

describe("isSensitiveAction", () => {
  it("accepts a class/action pair that exists", () => {
    expect(isSensitiveAction("money", "payout_recorded")).toBe(true);
    expect(isSensitiveAction("authentication", "login")).toBe(true);
  });

  it("rejects a real action under the wrong class", () => {
    expect(isSensitiveAction("money", "login")).toBe(false);
    expect(isSensitiveAction("authentication", "payout_recorded")).toBe(false);
  });

  it("rejects unknown classes and unknown actions without throwing", () => {
    expect(isSensitiveAction("nope" as AuditActionClass, "login")).toBe(false);
    expect(isSensitiveAction("money", "nope" as AuditAction)).toBe(false);
  });

  it("rejects junk of the wrong type without throwing", () => {
    expect(isSensitiveAction(undefined as never, "login")).toBe(false);
    expect(isSensitiveAction("money", 42 as never)).toBe(false);
  });

  it("rejects a prototype key as a class, which `in` would have accepted", () => {
    expect(isAuditActionClass("toString")).toBe(false);
    expect(isSensitiveAction("toString" as AuditActionClass, "login")).toBe(false);
  });
});

describe("classOfAction", () => {
  it("resolves an action to its single owning class", () => {
    expect(classOfAction("payout_recorded")).toBe("money");
    expect(classOfAction("prize_allocated")).toBe("prize_money");
    expect(classOfAction("support_impersonation_started")).toBe("support_access");
    expect(classOfAction("consent_recorded")).toBe("minor_consent");
  });

  it("returns null for an unknown action rather than throwing", () => {
    expect(classOfAction("roster_moved")).toBeNull();
    expect(classOfAction("")).toBeNull();
  });

  it("agrees with isSensitiveAction for every action in the taxonomy", () => {
    for (const key of AUDIT_ACTION_CLASS_KEYS) {
      for (const action of AUDIT_ACTION_CLASSES[key]) {
        expect(classOfAction(action)).toBe(key);
        expect(isSensitiveAction(key, action)).toBe(true);
      }
    }
  });
});

describe("isAuditAction", () => {
  it("recognises every action in the taxonomy", () => {
    for (const action of allAuditActions()) {
      expect(isAuditAction(action)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isAuditAction("roster_moved")).toBe(false);
    expect(isAuditAction("")).toBe(false);
  });
});

describe("the AuditEntry shape carries what an investigation needs", () => {
  it("requires actor, correlation, before/after, ip and user agent", () => {
    const entry: AuditEntry = {
      id: "aud_1",
      organizationId: "org_1",
      occurredAt: new Date("2026-06-15T12:00:00.000Z"),
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
    };

    expect(entry.actorId).toBe("person_1");
    expect(entry.correlationId).toBe("corr_1");
    expect(entry.before).toBeNull();
    expect(entry.after).toEqual({ status: "recorded" });
    expect(entry.ip).toBe("203.0.113.7");
    expect(entry.userAgent).toBe("Mozilla/5.0");
  });
});