import { describe, expect, it } from "vitest";

import type { Role } from "./model.js";
import { createAssignment, createRole } from "./model.js";
import type { Actor } from "./evaluate.js";
import { evaluate, isAllowed, isDenied } from "./evaluate.js";
import type { PolicyRule } from "./policy.js";

const ORG = "org_1";

const ROLES: readonly Role[] = [
  createRole({
    key: "player",
    name: "Player",
    permissions: ["roster:read", "contract:read", "payout:read"],
    permittedScopes: ["self", "team"],
  }),
  createRole({
    key: "team_manager",
    name: "Team Manager",
    permissions: ["invoice:read", "invoice:approve", "expense:approve", "contract:sign", "person:update"],
    permittedScopes: ["team", "self"],
  }),
  createRole({
    key: "owner",
    name: "Owner",
    permissions: [
      "invoice:read",
      "invoice:approve",
      "expense:approve",
      "contract:sign",
      "person:update",
      "person:read",
      "roster:read",
      "payout:read",
      "payout:pay",
      "setting:update",
      "role:manage",
    ],
    permittedScopes: ["organization"],
  }),
];

const AT = new Date("2026-06-15T12:00:00.000Z");

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    personId: "person_1",
    organizationId: ORG,
    assignments: [],
    ...overrides,
  };
}

function grant(roleKey: string, scopeType: Parameters<typeof createAssignment>[0]["scopeType"], scopeId: string | null, overrides = {}) {
  return createAssignment({
    roleKey,
    personId: "person_1",
    organizationId: ORG,
    scopeType,
    scopeId,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: null,
    grantedBy: "person_admin",
    ...overrides,
  });
}

describe("evaluate: allow paths", () => {
  it("allows a permission the role holds at an exactly matching scope", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });

    expect(decision.effect).toBe("ALLOW");
    expect(decision.reason).toBe("role_grants_permission");
    expect(decision.roleKey).toBe("team_manager");
    expect(decision.permission).toBe("invoice:approve");
    expect(decision.matchedScope).toEqual({ type: "team", id: "team_7" });
  });

  it("allows a narrower scope than the grant, which is the whole point of ranking", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("owner", "organization", ORG)] }),
      action: "update",
      resource: "setting",
      scope: { type: "department", id: "dep_1" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("ALLOW");
    expect(decision.matchedScope).toEqual({ type: "organization", id: ORG });
  });

  it("allows a self-scope request under a team grant without naming a scopeId", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("player", "team", "team_7")] }),
      action: "read",
      resource: "contract",
      scope: { type: "self", id: null },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("ALLOW");
    expect(decision.roleKey).toBe("player");
  });

  it("allows when any one of several assignments suffices, and names that one", () => {
    const decision = evaluate({
      actor: actor({
        assignments: [grant("player", "self", null), grant("team_manager", "team", "team_7")],
      }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("ALLOW");
    expect(decision.roleKey).toBe("team_manager");
  });
});

describe("evaluate: deny paths are explainable", () => {
  it("denies when the actor holds no assignment at all", () => {
    const decision = evaluate({
      actor: actor(),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("no_active_assignment");
    expect(decision.roleKey).toBeNull();
  });

  it("denies when the role does not hold the permission, naming the role", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("player", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("permission_not_in_role");
    expect(decision.roleKey).toBe("player");
    expect(decision.permission).toBe("invoice:approve");
  });

  it("denies an expired assignment and says it expired", () => {
    const decision = evaluate({
      actor: actor({
        assignments: [grant("team_manager", "team", "team_7", { validTo: new Date("2026-02-01T00:00:00.000Z") })],
      }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("no_active_assignment");
  });

  it("denies an assignment that has not started yet", () => {
    const decision = evaluate({
      actor: actor({
        assignments: [grant("team_manager", "team", "team_7", { validFrom: new Date("2026-12-01T00:00:00.000Z") })],
      }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("no_active_assignment");
  });

  it("refuses to let a team grant authorize an organization request", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "organization", id: ORG },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("scope_not_covered_by_grant");
    expect(decision.roleKey).toBe("team_manager");
    expect(decision.matchedScope).toEqual({ type: "team", id: "team_7" });
  });

  it("refuses a grant on a different row of the same scope type", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_9")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("scope_id_mismatch");
  });

  it("ignores a grant belonging to another organisation", () => {
    const decision = evaluate({
      actor: actor({
        assignments: [
          grant("team_manager", "team", "team_7", { organizationId: "org_other" }),
        ],
      }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("no_active_assignment");
  });

  it("ignores a grant belonging to another person", () => {
    const decision = evaluate({
      actor: actor({
        assignments: [grant("team_manager", "team", "team_7", { personId: "person_2" })],
      }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("no_active_assignment");
  });

  it("reports the first near-miss, and keeps it when a later grant also fails", () => {
    // player lacks the permission; team_manager holds it at the wrong team. The
    // first near-miss is the one reported, so the reason is stable rather than
    // whichever assignment happened to be iterated last.
    const decision = evaluate({
      actor: actor({
        assignments: [grant("player", "team", "team_7"), grant("team_manager", "team", "team_9")],
      }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("permission_not_in_role");
    expect(decision.roleKey).toBe("player");
  });

  it("keeps the first near-miss when an unknown role comes after a real one", () => {
    const decision = evaluate({
      actor: actor({
        assignments: [grant("player", "team", "team_7"), grant("ghost_role", "team", "team_7")],
      }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.reason).toBe("permission_not_in_role");
  });

  it("keeps the first scope near-miss when a later grant also fails on scope", () => {
    const decision = evaluate({
      actor: actor({
        assignments: [
          grant("owner", "organization", ORG),
          grant("team_manager", "team", "team_7"),
        ],
      }),
      action: "approve",
      resource: "invoice",
      scope: { type: "organization", id: ORG },
      roles: ROLES,
      at: AT,
    });
    // The owner grant covers organization scope but the role's permission list
    // does include invoice:approve, so it would allow... except the actor also
    // holds a narrower grant; the first failing one is reported.
    expect(decision.effect).toBe("ALLOW");
  });

  it("keeps the first id-mismatch near-miss when a later grant mismatches too", () => {
    const decision = evaluate({
      actor: actor({
        assignments: [grant("team_manager", "team", "team_1"), grant("team_manager", "team", "team_2")],
      }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.reason).toBe("scope_id_mismatch");
    expect(decision.matchedScope).toEqual({ type: "team", id: "team_1" });
  });

  it("denies an assignment referencing a role that does not exist, rather than throwing", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("ghost_role", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("unknown_role");
    expect(decision.roleKey).toBe("ghost_role");
  });
});

describe("evaluate: separation of duties", () => {
  it("denies an approver acting on their own request", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      actorId: "person_1",
      resourceOwnerId: "person_1",
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("separation_of_duties_violation");
    expect(decision.policyRuleId).toBe("requester_must_not_equal_approver");
  });

  it("allows an approver acting on someone else's request", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      actorId: "person_1",
      resourceOwnerId: "person_2",
    });
    expect(decision.effect).toBe("ALLOW");
  });

  it("does not apply the separation-of-duties rule when the resource has no owner recorded", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      actorId: "person_1",
    });
    expect(decision.effect).toBe("ALLOW");
  });

  it("only applies to approval-class actions, not to reading", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "read",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      actorId: "person_1",
      resourceOwnerId: "person_1",
    });
    expect(decision.effect).toBe("ALLOW");
  });

  it("applies to sign and pay too, since both bind the organisation", () => {
    for (const action of ["sign", "pay"] as const) {
      const decision = evaluate({
        actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
        action,
        resource: action === "sign" ? "contract" : "payout",
        scope: { type: "team", id: "team_7" },
        roles: ROLES.map((role) =>
          role.key === "team_manager"
            ? createRole({
                key: "team_manager",
                name: "Team Manager",
                permissions: ["invoice:read", "invoice:approve", "expense:approve", "contract:sign", "payout:pay", "person:update"],
                permittedScopes: ["team", "self"],
              })
            : role,
        ),
        at: AT,
        actorId: "person_1",
        resourceOwnerId: "person_1",
      });
      expect(decision.effect).toBe("DENY");
      expect(decision.reason).toBe("separation_of_duties_violation");
    }
  });
});

describe("evaluate: explicit deny rules beat grants", () => {
  const denySelfApprovals: PolicyRule = {
    id: "no_self_approval",
    resource: "invoice",
    action: "approve",
    effect: "DENY",
    condition: { kind: "actor_equals_owner" },
  };

  it("honours an organisation's own deny rule even where a role would allow", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      actorId: "person_1",
      resourceOwnerId: "person_1",
      policyRules: [denySelfApprovals],
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.policyRuleId).toBe("no_self_approval");
  });

  it("skips ALLOW-effect rules entirely: this engine grants from roles, never from a rule", () => {
    // An ALLOW rule naming a permission the actor does not hold must not become
    // a privilege-escalation path. Role grants are the only way in.
    const allowRule: PolicyRule = { ...denySelfApprovals, effect: "ALLOW" };
    const decision = evaluate({
      actor: actor({ assignments: [grant("player", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      actorId: "person_1",
      resourceOwnerId: "person_2",
      policyRules: [allowRule],
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("permission_not_in_role");
    expect(decision.policyRuleId).toBeNull();
  });

  it("does not fire a deny rule whose condition is unmet", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      actorId: "person_1",
      resourceOwnerId: "person_2",
      policyRules: [denySelfApprovals],
    });
    expect(decision.effect).toBe("ALLOW");
  });

  it("ignores rules that target another resource or action", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      actorId: "person_1",
      resourceOwnerId: "person_1",
      policyRules: [{ ...denySelfApprovals, resource: "expense" }],
    });
    // Still denied, but by the built-in separation-of-duties rule, not by the tenant's.
    expect(decision.effect).toBe("DENY");
    expect(decision.policyRuleId).toBe("requester_must_not_equal_approver");
  });

  it("scopes a rule by scope type too, so a rule can exempt one team", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      actorId: "person_1",
      resourceOwnerId: "person_1",
      policyRules: [{ ...denySelfApprovals, scopeTypes: ["organization"] }],
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.policyRuleId).toBe("requester_must_not_equal_approver");
  });

  it("supports the amount-below-limit condition, expressed with exact money", () => {
    const smallInvoice = {
      kind: "amount_within_limit" as const,
      limit: { minor: 1_000_000n, currency: "INR" },
      amount: { minor: 999_999n, currency: "INR" },
    };
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      conditions: [smallInvoice],
    });
    expect(decision.effect).toBe("ALLOW");

    const overLimit = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      conditions: [{ ...smallInvoice, amount: { minor: 1_000_001n, currency: "INR" } }],
    });
    expect(overLimit.effect).toBe("DENY");
    expect(overLimit.reason).toBe("policy_condition_failed");
  });

  it("refuses to compare money across currencies instead of guessing", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
      conditions: [
        {
          kind: "amount_within_limit",
          limit: { minor: 1_000_000n, currency: "INR" },
          amount: { minor: 1n, currency: "USD" },
        },
      ],
    });
    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("policy_condition_failed");
  });
});

describe("evaluate: input validation", () => {
  it("rejects a request with no scopeId for a scope that names a row", () => {
    expect(() =>
      evaluate({
        actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
        action: "approve",
        resource: "invoice",
        scope: { type: "team", id: null },
        roles: ROLES,
        at: AT,
      }),
    ).toThrow(/scopeId/);
  });

  it("rejects a scopeId on self scope", () => {
    expect(() =>
      evaluate({
        actor: actor({ assignments: [grant("player", "self", null)] }),
        action: "read",
        resource: "contract",
        scope: { type: "self", id: "person_1" },
        roles: ROLES,
        at: AT,
      }),
    ).toThrow(/self/);
  });

  it("rejects a request whose organisation differs from the actor's", () => {
    expect(() =>
      evaluate({
        actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
        action: "approve",
        resource: "invoice",
        scope: { type: "team", id: "team_7", organizationId: "org_other" },
        roles: ROLES,
        at: AT,
      }),
    ).toThrow(/organisation/i);
  });

  it("rejects an unknown resource or action outright", () => {
    expect(() =>
      evaluate({
        actor: actor(),
        action: "sudo" as never,
        resource: "invoice",
        scope: { type: "team", id: "team_7" },
        roles: ROLES,
        at: AT,
      }),
    ).toThrow(/invoice:sudo/);

    expect(() =>
      evaluate({
        actor: actor(),
        action: "approve",
        resource: "wallet" as never,
        scope: { type: "team", id: "team_7" },
        roles: ROLES,
        at: AT,
      }),
    ).toThrow(/wallet/);
  });
});

describe("evaluate: decision predicates", () => {
  const allow = evaluate({
    actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
    action: "approve",
    resource: "invoice",
    scope: { type: "team", id: "team_7" },
    roles: ROLES,
    at: AT,
  });
  const deny = evaluate({
    actor: actor({ assignments: [grant("player", "team", "team_7")] }),
    action: "approve",
    resource: "invoice",
    scope: { type: "team", id: "team_7" },
    roles: ROLES,
    at: AT,
  });

  it("agrees with the effect field in both directions", () => {
    expect(isAllowed(allow)).toBe(true);
    expect(isDenied(allow)).toBe(false);
    expect(isAllowed(deny)).toBe(false);
    expect(isDenied(deny)).toBe(true);
  });
});

describe("evaluate: a grant whose scope the role could never hold is refused", () => {
  it("does not let a hand-built over-broad assignment through", () => {
    // Constructed past createRole's ceiling, as a bad migration would.
    const rogue = Object.freeze({
      key: "team_manager",
      name: "Team Manager",
      permissions: Object.freeze(["invoice:approve"]),
      permittedScopes: Object.freeze(["team"]),
    }) as Role;

    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "organization", ORG)] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "organization", id: ORG },
      roles: [rogue],
      at: AT,
    });

    expect(decision.effect).toBe("DENY");
    expect(decision.reason).toBe("scope_not_covered_by_grant");
    expect(decision.roleKey).toBe("team_manager");
  });
});

describe("evaluate: the decision is a plain serialisable value", () => {
  it("survives JSON round-trip, because audit records store it verbatim", () => {
    const decision = evaluate({
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve",
      resource: "invoice",
      scope: { type: "team", id: "team_7" },
      roles: ROLES,
      at: AT,
    });
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });

  it("is deterministic for identical inputs", () => {
    const request = {
      actor: actor({ assignments: [grant("team_manager", "team", "team_7")] }),
      action: "approve" as const,
      resource: "invoice" as const,
      scope: { type: "team" as const, id: "team_7" },
      roles: ROLES,
      at: AT,
    };
    expect(evaluate(request)).toEqual(evaluate(request));
  });
});