/**
 * The audit action-class taxonomy.
 *
 * The audit's verdict on the legacy system was blunt: **0 of 15 sensitive
 * action classes properly logged** (`AUDIT/49_AUDIT_LOGGING.md` §1). No
 * `*_audit` table existed, no `updated_by` column anywhere, and `next.config`
 * compiled `console.*` out of production — so even the accidental trail was
 * gone. Worse, the one audit-like table that existed was `FOR INSERT ... WITH
 * CHECK (true)` granted to `public`, so it had no evidentiary value either.
 *
 * This module is the answer to "what must be written down". It is a fixed,
 * frozen set of exactly fifteen classes, because a taxonomy that grows without
 * review stops being a set of obligations and becomes a log format.
 *
 * Each class below is chosen for *this* product, not copied from a list. The
 * justification for every one is in the comment above it, referencing the audit
 * finding or the domain risk that makes the class non-optional for an esports
 * organisation OS:
 *
 * | # | Class | Why it is non-optional here |
 * * - | ----- | ---------------------------- |
 * | 1 | `authentication`  | Sign-in was never logged app-side; only the auth provider's own logs, which were never surfaced. |
 * | 2 | `authorization`   | `PUT /api/users` wrote nothing and was broken (undefined RPC). A privilege change with no record is unmanageable. |
 * | 3 | `data_export`     | The only export produced a client-side PDF. Nothing logged. GDPR Art. 15 access requests cannot be evidenced. |
 * | 4 | `erasure`         | Erasure was not implemented at all, and `social_links` jsonb meant "search for the needle" erasure. |
 * | 5 | `minor_consent`   | The audience skews 16. Onboarding collected DOB, address, emergency contacts and device telemetry with no consent step. |
 * | 6 | `contract`        | A contract change was only "partially" recorded — the content lived in a world-writable `admin_config` row. |
 * | 7 | `agreement`       | Acceptances recorded role/version/IP/UA but not the content or a hash, so the text proved nothing. |
 * | 8 | `money`           | `slot_expenses`, `winnings`, `tier_defaults` had **no actor column at all**. No way to prove who approved a spend. |
 * | 9 | `prize_money`     | The product's differentiator is prize allocation. An unexplained allocation to a 16-year-old is a trust and legal incident. |
 * | 10 | `roster`          | `rosters` had `created_at` only — no actor, no before/after. Roster moves are the core HR dispute. |
 * | 11 | `travel`          | Tournament travel for minors involves guardian-sensitive logistics and real spend; both were untracked. |
 * | 12 | `support_access`  | "Any authenticated user can impersonate any identity" was logged nowhere, so support access was ungoverned. |
 * | 13 | `config`          | `admin_config` had no `updated_by`, no `updated_at` — and no RLS. Highest-risk class per unit of code. |
 * | 14 | `deletion`        | `DELETE /api/admin/settings` cascaded seven tables away with no record, no transaction, no confirmation. CRITICAL. |
 * | 15 | `security`        | Failed logins and privilege-escalation attempts need to reach an alerting path, not just a table. |
 *
 * Keys are stable snake_case strings because rows are append-only: renaming one
 * orphans every historical row that referenced it.
 */

/** Every action inside every class, sorted, so a consumer can build a `CHECK` constraint. */
const ACTIONS_BY_CLASS = {
  /**
   * Who got in, and who got out. Auth-provider logs were never surfaced, so
   * app-side records are the only record.
   */
  authentication: [
    "login",
    "logout",
    "failed_login",
    "password_changed",
    "password_reset_requested",
    "mfa_enrolled",
    "mfa_disabled",
    "recovery_codes_regenerated",
    "session_revoked",
    "account_locked",
  ],

  /**
   * Every change to what somebody may do. The legacy permission-change endpoint
   * wrote nothing at all, which is how a stale admin grant goes unnoticed for
   * years.
   */
  authorization: [
    "role_granted",
    "role_revoked",
    "role_created",
    "role_updated",
    "permission_denied",
    "scope_escalated",
    "policy_rule_changed",
  ],

  /**
   * Data leaving the system. Read access to personal data is itself regulated
   * (GDPR Art. 15), so a bulk read is logged as well as an export.
   */
  data_export: ["export_requested", "export_approved", "export_completed", "export_denied", "bulk_read"],

  /**
   * The right-to-be-forgotten. Separated from export because the two have
   * opposite retention and opposite approval paths, and conflating them makes
   * the retention rule impossible to write.
   */
  erasure: ["erasure_requested", "erasure_approved", "erasure_completed", "erasure_partial", "erasure_refused"],

  /**
   * Minors' and guardians' consent. Non-optional for this audience: the audit
   * rated "PII collected from a potentially minor audience with no consent
   * step" HIGH/HIGH, and the only defence is a log showing when consent was
   * captured, by whom, and against which document version.
   */
  minor_consent: [
    "age_verified",
    "age_verification_failed",
    "guardian_registered",
    "guardian_contact_changed",
    "consent_recorded",
    "consent_withdrawn",
    "consent_version_changed",
  ],

  /**
   * Binding agreements. The content must be hashed onto the record; an
   * acceptance that does not name the text proves nothing in a dispute.
   */
  contract: ["contract_drafted", "contract_sent", "contract_signed", "contract_amended", "contract_terminated"],

  /**
   * Policy documents a person accepts in-product (code of conduct, media
   * release, prize terms). Separate from `contract` because these are unilateral
   * acceptances of a versioned document, not negotiated instruments.
   */
  agreement: ["agreement_accepted", "agreement_declined", "agreement_withdrawn", "agreement_version_changed"],

  /**
   * Money entering or leaving beyond prize money. These tables had no actor
   * column whatsoever, so "who approved this spend" was unanswerable.
   */
  money: [
    "expense_submitted",
    "expense_approved",
    "expense_rejected",
    "payment_initiated",
    "payout_recorded",
    "payout_failed",
    "refund_issued",
    "rate_card_changed",
  ],

  /**
   * Prize allocation and dispute. Separated from `money` because the allocation
   * decision is the product's differentiator and is reproducible from a rule
   * version plus a frozen roster; the log must record which rule version ran.
   */
  prize_money: [
    "prize_pool_created",
    "prize_pool_published",
    "prize_allocated",
    "prize_adjusted",
    "prize_forfeited",
    "prize_disputed",
  ],

  /**
   * Roster movement. `rosters` recorded only `created_at`; roster changes are
   * the employment dispute this product will have first.
   */
  roster: [
    "roster_member_added",
    "roster_member_removed",
    "roster_role_changed",
    "roster_locked",
    "tryout_applied",
    "tryout_selected",
    "tryout_rejected",
  ],

  /**
   * Tournament travel. Logged separately because travel for minors carries
   * guardian-sensitive detail and real spend, and both were untracked.
   */
  travel: [
    "travel_plan_submitted",
    "travel_plan_approved",
    "travel_plan_rejected",
    "travel_booking_changed",
    "travel_cost_exceeded",
  ],

  /**
   * Support acting as a user. The legacy app let any authenticated user
   * impersonate any identity, with no log — so support access was entirely
   * ungoverned and undetectable after the fact.
   */
  support_access: [
    "support_case_opened",
    "support_case_closed",
    "support_impersonation_started",
    "support_impersonation_ended",
    "break_glass_used",
  ],

  /**
   * Configuration. `admin_config` had no `updated_by` and no RLS; a settings
   * change is the highest-consequence write in the product per unit of code.
   */
  config: ["setting_changed", "feature_flag_changed", "integration_changed", "automation_changed", "webhook_changed"],

  /**
   * Destruction and restoration. The bulk purge endpoint deleted seven tables'
   * worth of history with no record and no confirmation; CRITICAL in the audit.
   */
  deletion: ["record_deleted", "record_restored", "bulk_delete_executed", "purge_executed", "retention_enforced"],

  /**
   * The alerting path. Separated from `authentication` so that credential
   * stuffing and privilege-escalation attempts can be routed to a detector
   * with a different retention and latency requirement than routine sign-ins.
   */
  security: [
    "brute_force_detected",
    "anomaly_detected",
    "rate_limit_exceeded",
    "incident_opened",
    "incident_resolved",
  ],
} as const satisfies Record<string, readonly string[]>;

/** The fifteen class keys, frozen and in a stable order. */
export const AUDIT_ACTION_CLASS_KEYS = Object.freeze(
  Object.keys(ACTIONS_BY_CLASS).sort() as AuditActionClassKey[],
);

/** Every class key. */
export type AuditActionClassKey = keyof typeof ACTIONS_BY_CLASS;

/** Alias kept short because it appears on every `AuditEntry`. */
export type AuditActionClass = AuditActionClassKey;

/** Every action name across every class. */
export type AuditAction = (typeof ACTIONS_BY_CLASS)[AuditActionClassKey][number];

/** The taxonomy as data: class key -> frozen, sorted action names. */
export const AUDIT_ACTION_CLASSES: Readonly<Record<AuditActionClass, readonly AuditAction[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ACTIONS_BY_CLASS)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, actions]) => [key, Object.freeze([...actions].sort())]),
  ) as Record<AuditActionClass, readonly AuditAction[]>,
);

const ACTION_INDEX: ReadonlyMap<string, AuditActionClass> = new Map(
  Object.entries(ACTIONS_BY_CLASS).flatMap(([classKey, actions]) =>
    (actions as readonly string[]).map((action) => [action, classKey as AuditActionClass]),
  ),
);

/**
 * Narrows an untrusted string to a class key.
 *
 * `hasOwnProperty` rather than `in`, so a key like `"toString"` is rejected
 * instead of resolving to `Object.prototype` and passing.
 */
export function isAuditActionClass(value: string): value is AuditActionClass {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ACTIONS_BY_CLASS, value);
}

/**
 * Narrows an untrusted string to an action name, anywhere in the taxonomy.
 *
 * Exists because action names arrive from route handlers and job bodies, which
 * are exactly where a typo would otherwise become a silently unlogged class.
 */
export function isAuditAction(value: string): value is AuditAction {
  return ACTION_INDEX.has(value);
}

/**
 * Whether `action` belongs to `class`.
 *
 * Both halves must be right. An action that exists under a different class is
 * **not** sensitive under this one, because a consumer filtering by class would
 * otherwise log a payout under `authentication` and never alert on it.
 */
export function isSensitiveAction(actionClass: AuditActionClass, action: AuditAction): boolean {
  return ACTION_INDEX.get(action) === actionClass;
}

/** The class an action belongs to, or `null` when the action is unknown. */
export function classOfAction(action: string): AuditActionClass | null {
  return ACTION_INDEX.get(action) ?? null;
}

/** Every action in the taxonomy, sorted. */
export function allAuditActions(): AuditAction[] {
  return Object.values(AUDIT_ACTION_CLASSES)
    .flatMap((actions) => [...actions])
    .sort();
}

/**
 * A JSON-shaped value. Deliberately narrower than `unknown`: an audit row that
 * could hold a class instance or a `Date` would not be reconstructable in
 * another language, and the log has to be readable during an incident.
 */
export type AuditValue = null | boolean | number | string | readonly AuditValue[] | { readonly [key: string]: AuditValue };

/** Who acted. `system` covers cron and triggers; `integration` covers bots and webhooks. */
export type AuditActorType = "user" | "system" | "integration";

/** The boundary an action was taken within. Mirrors the authorisation engine's scope. */
export interface AuditScope {
  readonly type: "organization" | "department" | "division" | "team" | "campaign" | "assigned" | "self";
  readonly id: string | null;
}

/**
 * One audit row.
 *
 * The actor is **denormalised**: `actorId`, `actorName` and `actorRole` are
 * captured at write time, not joined. The audit found that audit-relevant
 * foreign keys had no `ON DELETE`, so deleting a user either fails on them or —
 * once someone "fixes" it with `CASCADE` — destroys the history that pointed at
 * them. A snapshot has neither problem.
 *
 * `before` and `after` are nullable because not every class is a mutation
 * (`login`, `permission_denied`, `bulk_read`), and forcing `before: {}` on those
 * would make "nothing changed" indistinguishable from "we forgot to record it".
 */
export interface AuditEntry {
  /** Monotonic, assigned by the writer. Also the append-order tie-breaker. */
  readonly id: string;
  readonly organizationId: string;
  readonly occurredAt: Date;
  readonly actorType: AuditActorType;
  /** Null for `system` actors that have no person behind them. */
  readonly actorId: string | null;
  /** Snapshot, so history survives the person being deleted. */
  readonly actorName: string | null;
  /** Snapshot of the role held *at the time of the action*, not today's. */
  readonly actorRole: string | null;
  readonly actionClass: AuditActionClass;
  readonly action: AuditAction;
  readonly resourceType: string;
  /** Null for class-wide events such as `bulk_read` over a whole table. */
  readonly resourceId: string | null;
  readonly scope: AuditScope;
  readonly before: AuditValue;
  readonly after: AuditValue;
  /** Why it happened, in the actor's words. The first thing an investigation reads. */
  readonly reason: string | null;
  /** Ties every row produced by one request together, across services. */
  readonly correlationId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}