/**
 * Tenancy spine.
 *
 * The three decisions that make isolation real:
 *
 * 1. `org_id` is NOT NULL on every tenant-owned table, and composite indexes lead with it.
 * 2. Every foreign key between tenant-owned tables is composite and includes `org_id`,
 *    so a cross-tenant reference cannot even be expressed. See ADR-0011.
 * 3. Row Level Security is enabled *and forced*, with the tenant resolved from the
 *    session — never from a request parameter.
 *
 * `person` is deliberately the only identity that is NOT org-scoped: one human may work
 * for several organisations, so access is always derived through membership rather than
 * owned by the person row.
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const membershipStatus = pgEnum("membership_status", ["pending", "active", "suspended", "left"]);
export const identityMethod = pgEnum("identity_method", ["email", "oauth", "sso", "phone"]);
export const scopeType = pgEnum("scope_type", [
  "organization",
  "department",
  "division",
  "team",
  "campaign",
  "self",
  "assigned",
]);
export const orgStatus = pgEnum("org_status", ["provisioning", "active", "suspended", "closed"]);
export const workerClassification = pgEnum("worker_classification", [
  "employee",
  "contractor",
  "player",
  "creator",
  "intern",
  "advisor",
  "volunteer",
]);

// ---------------------------------------------------------------------------
// Platform (not tenant-scoped)
// ---------------------------------------------------------------------------

export const schemaMigration = pgTable("schema_migration", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer("duration_ms"),
});

export const platformFeatureFlag = pgTable("platform_feature_flag", {
  key: varchar("key", { length: 128 }).primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// IDENTITY — org-independent by design
// ---------------------------------------------------------------------------

/**
 * A human being. Not a login, not a role, not a team slot.
 *
 * Has no `org_id`: identity is global, and access is derived through `orgMembership`.
 * This is what allows the same person to be a player for one organisation and a
 * contractor for another without duplicating them.
 */
export const person = pgTable(
  "person",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalRef: varchar("external_ref", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("person_external_ref_key").on(table.externalRef)],
);

/** A verified login. A person may hold several. */
export const identity = pgTable(
  "identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    method: identityMethod("method").notNull(),
    identifier: text("identifier").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("identity_identifier_key").on(table.method, table.identifier)],
);

/**
 * Non-authoritative descriptive data, owned by the person.
 *
 * Never authorisation-bearing: editing this grants no access. Only `orgMembership` and
 * `roleAssignment` do.
 */
export const personProfile = pgTable("person_profile", {
  personId: uuid("person_id")
    .primaryKey()
    .references(() => person.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 200 }),
  legalName: varchar("legal_name", { length: 200 }),
  pronouns: varchar("pronouns", { length: 60 }),
  locale: varchar("locale", { length: 16 }).notNull().default("en"),
  timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
  bio: text("bio"),
  avatarUrl: text("avatar_url"),
  profileVisibility: varchar("profile_visibility", { length: 16 }).notNull().default("private"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Consent, recorded per purpose and revocable. */
export const consentRecord = pgTable(
  "consent_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),
    purpose: varchar("purpose", { length: 64 }).notNull(),
    granted: boolean("granted").notNull(),
    policyVersion: varchar("policy_version", { length: 64 }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("consent_person_idx").on(table.personId),
    uniqueIndex("consent_person_purpose_version_key").on(table.personId, table.purpose, table.policyVersion),
  ],
);

/**
 * Guardian consent for a minor. Referenced before an under-18 can participate, and is
 * itself a document (see the documents domain).
 */
export const guardianConsent = pgTable("guardian_consent", {
  id: uuid("id").primaryKey().defaultRandom(),
  personId: uuid("person_id")
    .notNull()
    .references(() => person.id, { onDelete: "cascade" }),
  guardianName: varchar("guardian_name", { length: 200 }).notNull(),
  documentAssetId: uuid("document_asset_id"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// ORGANISATION — the tenant
// ---------------------------------------------------------------------------

export const organization = pgTable(
  "organization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    legalName: varchar("legal_name", { length: 240 }),
    status: orgStatus("status").notNull().default("provisioning"),
    defaultCurrency: varchar("default_currency", { length: 3 }).notNull(),
    defaultTimezone: varchar("default_timezone", { length: 64 }).notNull().default("UTC"),
    defaultLocale: varchar("default_locale", { length: 16 }).notNull().default("en"),
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
    /**
     * Fixed at creation, not a soft setting. It determines infrastructure, and changing
     * it is a migration, not a toggle.
     */
    dataRegion: varchar("data_region", { length: 32 }).notNull().default("local"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("organization_slug_key").on(table.slug)],
);

/** A person's relationship to one organisation. */
export const orgMembership = pgTable(
  "org_membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    status: membershipStatus("status").notNull().default("pending"),
    invitedByPersonId: uuid("invited_by_person_id"),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("org_membership_org_person_key").on(table.orgId, table.personId),
    index("org_membership_org_idx").on(table.orgId),
    index("org_membership_person_idx").on(table.personId),
  ],
);

/**
 * A person's work for an organisation, effective-dated.
 *
 * A person may hold several concurrent engagements — the single most common real career
 * path in esports is competing, streaming and coaching in the same week, which the legacy
 * single-role enum could not represent at all.
 */
export const engagement = pgTable(
  "engagement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    classification: workerClassification("classification").notNull(),
    title: varchar("title", { length: 160 }),
    /** Set on the engagement, not the person: it is a property of the relationship. */
    isAgeRestricted: boolean("is_age_restricted").notNull().default(false),
    isPrimary: boolean("is_primary").notNull().default(false),
    scopeType: scopeType("scope_type").notNull().default("organization"),
    scopeId: uuid("scope_id"),
    reportingLinePersonId: uuid("reporting_line_person_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    endedReason: varchar("ended_reason", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("engagement_id_org_key").on(table.orgId, table.id),
    index("engagement_org_idx").on(table.orgId),
    index("engagement_org_person_idx").on(table.orgId, table.personId),
    // Effective dating: never more than one current engagement per classification.
    uniqueIndex("engagement_current_per_classification_key")
      .on(table.orgId, table.personId, table.classification)
      .where(sql`${table.validTo} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// AUTHORISATION — Role + Permission + Resource + Action + Scope
// ---------------------------------------------------------------------------

export const role = pgTable(
  "role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("role_org_key_key").on(table.orgId, table.key),
    index("role_org_idx").on(table.orgId),
  ],
);

/** The noun, the verb, and how risky the pair is. */
export const permission = pgTable(
  "permission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null = system permission, shared across every tenant. */
    orgId: uuid("org_id").references(() => organization.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 128 }).notNull(),
    resource: varchar("resource", { length: 64 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    riskLevel: varchar("risk_level", { length: 16 }).notNull().default("low"),
    description: text("description"),
  },
  (table) => [
    uniqueIndex("permission_key_key").on(table.key),
    index("permission_org_idx").on(table.orgId),
  ],
);

export const rolePermission = pgTable(
  "role_permission",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permission.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    index("role_permission_org_idx").on(table.orgId),
  ],
);

/** The scope boundary a role is permitted to be granted at. */
export const roleScopeRule = pgTable(
  "role_scope_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "cascade" }),
    scopeType: scopeType("scope_type").notNull(),
    maxScopeRank: integer("max_scope_rank").notNull().default(0),
  },
  (table) => [
    uniqueIndex("role_scope_rule_unique_key").on(table.roleId, table.scopeType),
    index("role_scope_rule_org_idx").on(table.orgId),
  ],
);

/**
 * A grant: effective-dated, scope-bound, attributed.
 *
 * `scopeId` is chosen by the server from the set permitted by `roleScopeRule`. The client
 * never supplies it — in the legacy system a nullable `team_id` doubled as a scope marker
 * the caller could choose, which is how a coach gained org-wide reach.
 */
export const roleAssignment = pgTable(
  "role_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => role.id, { onDelete: "restrict" }),
    scopeType: scopeType("scope_type").notNull().default("organization"),
    scopeId: uuid("scope_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    grantedByPersonId: uuid("granted_by_person_id"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("role_assignment_org_idx").on(table.orgId),
    index("role_assignment_org_person_idx").on(table.orgId, table.personId),
    index("role_assignment_current_key")
      .on(table.orgId, table.personId, table.roleId)
      .where(sql`${table.validTo} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// AUDIT — append-only, never updated or deleted
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organization.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: varchar("actor_type", { length: 16 }).notNull(),
    actorId: uuid("actor_id"),
    /** Denormalised so history survives deletion of the actor. */
    actorLabel: varchar("actor_label", { length: 240 }),
    actionClass: varchar("action_class", { length: 64 }).notNull(),
    action: varchar("action", { length: 128 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }),
    resourceId: varchar("resource_id", { length: 128 }),
    correlationId: uuid("correlation_id"),
    ip: varchar("ip", { length: 64 }),
    userAgent: text("user_agent"),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    index("audit_log_org_occurred_idx").on(table.orgId, table.occurredAt),
    index("audit_log_action_class_idx").on(table.actionClass),
    index("audit_log_correlation_idx").on(table.correlationId),
  ],
);

// ---------------------------------------------------------------------------
// OUTBOX — the only legitimate path to the outside world
// ---------------------------------------------------------------------------

/**
 * Transactional outbox. A business fact and the intent to react to it commit atomically;
 * a relay publishes afterwards. Nothing sends an email or webhook from inside a
 * transaction.
 */
export const outboxEvent = pgTable(
  "outbox_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organization.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: varchar("actor_type", { length: 16 }).notNull(),
    actorId: uuid("actor_id"),
    correlationId: uuid("correlation_id"),
    causationId: uuid("causation_id"),
    /** Unique per org, which is what makes redelivery safe. */
    dedupeKey: text("dedupe_key").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("outbox_event_dedupe_key").on(table.dedupeKey),
    index("outbox_event_unpublished_idx").on(table.publishedAt, table.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const organizationRelations = relations(organization, ({ many }) => ({
  memberships: many(orgMembership),
  engagements: many(engagement),
  roles: many(role),
}));

export const personRelations = relations(person, ({ many, one }) => ({
  identities: many(identity),
  profile: one(personProfile),
  memberships: many(orgMembership),
  engagements: many(engagement),
  roleAssignments: many(roleAssignment),
}));

export const orgMembershipRelations = relations(orgMembership, ({ one }) => ({
  organization: one(organization, { fields: [orgMembership.orgId], references: [organization.id] }),
  person: one(person, { fields: [orgMembership.personId], references: [person.id] }),
}));

export const engagementRelations = relations(engagement, ({ one }) => ({
  organization: one(organization, { fields: [engagement.orgId], references: [organization.id] }),
  person: one(person, { fields: [engagement.personId], references: [person.id] }),
}));

export const roleAssignmentRelations = relations(roleAssignment, ({ one }) => ({
  organization: one(organization, { fields: [roleAssignment.orgId], references: [organization.id] }),
  person: one(person, { fields: [roleAssignment.personId], references: [person.id] }),
  role: one(role, { fields: [roleAssignment.roleId], references: [role.id] }),
}));

export type Organization = typeof organization.$inferSelect;
export type Person = typeof person.$inferSelect;
export type OrgMembership = typeof orgMembership.$inferSelect;
export type Engagement = typeof engagement.$inferSelect;
export type Role = typeof role.$inferSelect;
export type RoleAssignment = typeof roleAssignment.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type OutboxEvent = typeof outboxEvent.$inferSelect;