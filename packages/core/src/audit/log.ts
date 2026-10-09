/**
 * The append-only audit log.
 *
 * Append-only is the whole point, so it is enforced **structurally** rather than
 * by convention: the object returned by {@link createAppendOnlyLog} has exactly
 * two methods, `insert` and `read`. There is no `update`, no `delete`, no
 * `upsert`, no `truncate` — not because callers are trusted not to call them,
 * but because they do not exist. A policy nobody can violate does not need a
 * review step; the legacy `communication_logs` table was granted
 * `FOR INSERT ... WITH CHECK (true)` to `public`, and the audit's recommendation
 * is the mirror image: no UPDATE or DELETE grant for any application role.
 *
 * This in-memory implementation is the reference semantics — the pure part a
 * test can assert. The Postgres table and its grants live in `packages/db`; the
 * conformance test compares them against this behaviour.
 *
 * Reads are tenant-scoped **by requirement**: `read({})` throws rather than
 * defaulting to every tenant's log. A filter that defaults to "everything" is a
 * cross-tenant data leak waiting for a call site that forgets the argument.
 */

import type { AuditEntry, AuditScope, AuditValue } from "./taxonomy.js";
import { classOfAction } from "./taxonomy.js";

const SCOPE_TYPES: ReadonlySet<string> = new Set([
  "organization",
  "department",
  "division",
  "team",
  "campaign",
  "assigned",
  "self",
]);

const ACTOR_TYPES: ReadonlySet<string> = new Set(["user", "system", "integration"]);

/**
 * Validate an entry, returning it unchanged so it composes in a pipeline.
 *
 * Throws rather than repairing. A log row is evidence; silently normalising a
 * missing correlation id or an unpaired class/action would produce a row that
 * looks fine and proves nothing.
 */
export function validateAuditEntry(entry: AuditEntry): AuditEntry {
  if (typeof entry.organizationId !== "string" || entry.organizationId === "") {
    throw new Error("Audit entry requires an organizationId: a tenant-less row can never be queried safely");
  }
  if (typeof entry.correlationId !== "string" || entry.correlationId === "") {
    throw new Error("Audit entry requires a correlationId: an unlinkable row cannot be investigated");
  }
  if (!(entry.occurredAt instanceof Date) || Number.isNaN(entry.occurredAt.getTime())) {
    throw new Error(`Audit entry requires a valid occurredAt Date, received ${String(entry.occurredAt)}`);
  }
  if (!ACTOR_TYPES.has(entry.actorType)) {
    throw new Error(`Unknown actorType ${JSON.stringify(entry.actorType)}`);
  }
  if (entry.actorType === "user") {
    if (entry.actorId === null || entry.actorId === "") {
      throw new Error("A user actor requires an actorId");
    }
    if (entry.actorName === null || entry.actorName === "") {
      throw new Error("A user actor requires an actorName snapshot; history must survive the person");
    }
  }
  if (classOfAction(entry.action) !== entry.actionClass) {
    throw new Error(
      `Audit action ${JSON.stringify(entry.action)} does not belong to class ${JSON.stringify(entry.actionClass)}`,
    );
  }
  assertScopeWellFormed(entry.scope);
  return entry;
}

function assertScopeWellFormed(scope: AuditScope): void {
  if (!SCOPE_TYPES.has(scope.type)) {
    throw new Error(`Unknown audit scope type ${JSON.stringify(scope.type)}`);
  }
  if (scope.type === "self") {
    if (scope.id !== null) {
      throw new Error(`Audit scope self must carry a null id; received ${JSON.stringify(scope.id)}`);
    }
    return;
  }
  if (scope.id === null || scope.id === "") {
    throw new Error(`Audit scope ${scope.type} requires an id identifying the boundary acted within`);
  }
}

/**
 * Validate and freeze an entry, ready to insert.
 *
 * Frozen because a handler that logs and then mutates the object it logged has
 * produced a row that disagrees with what it believed it wrote.
 */
export function createAuditEntry(entry: AuditEntry): AuditEntry {
  validateAuditEntry(entry);
  return Object.freeze({ ...entry });
}

/** Read filter. `organizationId` is mandatory; everything else narrows further. */
export interface AuditQuery {
  readonly organizationId: string;
  readonly actionClass?: AuditEntry["actionClass"];
  readonly action?: AuditEntry["action"];
  readonly actorId?: string;
  readonly correlationId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  /** Inclusive lower bound. */
  readonly from?: Date;
  /** Exclusive upper bound, matching the effective-dating convention. */
  readonly to?: Date;
}

/**
 * The append-only surface: exactly `insert` and `read`.
 *
 * The interface has no more members than these two. That is the guarantee —
 * adding an `update` would be a compile error at every call site, which is
 * stronger than a lint rule someone can disable.
 */
export interface AppendOnlyLog {
  /** Validate, freeze and store. Rejects a duplicate id. */
  insert(entry: AuditEntry): AuditEntry;
  /** Tenant-scoped read, in append order. */
  read(query: AuditQuery): readonly AuditEntry[];
}

export function createAppendOnlyLog(): AppendOnlyLog {
  const entries: AuditEntry[] = [];
  const ids = new Set<string>();

  const insert = (entry: AuditEntry): AuditEntry => {
    validateAuditEntry(entry);
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate audit entry id ${JSON.stringify(entry.id)}: an append-only log has no upsert`);
    }
    ids.add(entry.id);
    entries.push(entry);
    return entry;
  };

  const read = (query: AuditQuery): readonly AuditEntry[] => {
    if (typeof query.organizationId !== "string" || query.organizationId === "") {
      throw new Error("read requires an organizationId; an unscoped audit read would cross tenants");
    }
    if (query.from !== undefined && query.to !== undefined && query.to.getTime() < query.from.getTime()) {
      throw new Error(`read filter from ${query.from.toISOString()} is later than to ${query.to.toISOString()}`);
    }

    return Object.freeze(
      entries.filter((entry) => {
        if (entry.organizationId !== query.organizationId) return false;
        if (query.actionClass !== undefined && entry.actionClass !== query.actionClass) return false;
        if (query.action !== undefined && entry.action !== query.action) return false;
        if (query.actorId !== undefined && entry.actorId !== query.actorId) return false;
        if (query.correlationId !== undefined && entry.correlationId !== query.correlationId) return false;
        if (query.resourceType !== undefined && entry.resourceType !== query.resourceType) return false;
        if (query.resourceId !== undefined && entry.resourceId !== query.resourceId) return false;
        if (query.from !== undefined && entry.occurredAt.getTime() < query.from.getTime()) return false;
        if (query.to !== undefined && entry.occurredAt.getTime() >= query.to.getTime()) return false;
        return true;
      }),
    );
  };

  return Object.freeze({ insert, read });
}

/** Re-exported so consumers do not import from two modules for one entry type. */
export type { AuditEntry, AuditScope, AuditValue };