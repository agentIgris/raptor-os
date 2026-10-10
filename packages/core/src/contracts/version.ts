/**
 * Contract versions and their content hash.
 *
 * The design spec's acceptance criterion for this phase is *"Acceptance provable
 * by content hash"*. That phrase is doing a lot of work, and it is only honest if
 * the hash actually proves something. This module is the part of that proof.
 *
 * ## What a version is
 *
 * A {@link ContractVersion} is **immutable and self-identifying**: it carries the
 * full content of one revision of a contract plus a {@link ContractVersion.contentHash}
 * over that content. There is deliberately no function here that edits a version.
 * A correction is a *new version* (see `./amendment.js`), which is the only shape
 * that leaves an auditable trail.
 *
 * ## Why the encoding is length-framed
 *
 * The obvious way to hash a document is to concatenate its fields and hash the
 * string. That is broken in a way that only shows up under attack, so this module
 * does not do it.
 *
 * A contract has adjacent free-text fields — a clause heading and its body, a
 * title and a preamble. Concatenating `["ab", "c"]` and `["a", "bc"]` yields the
 * identical byte string. Two genuinely different contracts would then hash the
 * same, and the acceptance proof would be proving nothing at all: an attacker
 * could move a character across a boundary and carry an accepted hash with them.
 *
 * {@link canonicalFrame} therefore prefixes every value with its **UTF-8 byte
 * length** (`"3:abc"`). The length header makes the byte stream self-delimiting,
 * so no rearrangement of field contents can reproduce another document's bytes.
 * The tests attack exactly this: a boundary shifted between two clauses, and a
 * boundary shifted between two scalar fields, must produce different hashes.
 *
 * Byte length rather than `String.length` because "é" is one JavaScript character
 * and two UTF-8 bytes. Framing by character count would desynchronise the decoder
 * at the first non-ASCII clause — which, in a contract with names in it, is not
 * a corner case.
 *
 * ## Why the field order is fixed by the schema, not by the caller's object
 *
 * Two callers who write the same fields in a different order are describing the
 * same contract, so they must hash the same. The encoder reads fields **by name**
 * into a fixed order rather than iterating `Object.keys`. Conversely, clause order
 * is *preserved*, because clause order is legally meaningful and sorting it away
 * would merge two different instruments.
 *
 * This module is pure: no database, no network, no clock. `createContractVersion`
 * takes the content; nothing here reads `Date.now()`.
 */

import { createHash } from "node:crypto";

/**
 * The digest used for contract content hashes.
 *
 * Named rather than inlined at the call site because the stored value has to be
 * re-verifiable in five years by code that may predate today's preferences. A
 * bare `"sha256"` in two files is two constants that will eventually drift.
 */
export const CONTRACT_HASH_ALGORITHM = "sha256";

/** Schema version of the canonical encoding, mixed into the hash. */
const CANONICAL_ENCODING_VERSION = "raptor.contract.v1";

/** One clause of a contract: a heading and the prose beneath it. */
export interface ContractClause {
  readonly heading: string;
  readonly text: string;
}

/**
 * The content of a contract version — everything the hash covers.
 *
 * `versionId` is deliberately **absent**. The id is a surrogate key the database
 * assigns; the hash has to be reproducible from the document alone, by someone
 * holding a PDF and nothing else. Everything a reader could dispute about the
 * instrument *is* here, including the version number and the supersession link, so
 * that an amendment is never hash-equal to the version it replaces.
 */
export interface ContractVersionContent {
  readonly contractId: string;
  readonly organizationId: string;
  /** 1-based and strictly increasing within a contract. */
  readonly version: number;
  readonly title: string;
  readonly body: string;
  /** Ordered. Clause order is part of the meaning, so it is never sorted away. */
  readonly clauses: readonly ContractClause[];
  readonly effectiveFrom: Date;
  /** `null` or `undefined` means open-ended. Never "expiry unknown". */
  readonly expiresAt?: Date | null;
  /** The version this one replaces, or `null` for the original. */
  readonly supersedesVersionId?: string | null;
}

/** An immutable contract revision, with its content hash already computed. */
export interface ContractVersion {
  readonly versionId: string;
  readonly contractId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly clauses: readonly ContractClause[];
  readonly effectiveFrom: Date;
  readonly expiresAt: Date | null;
  readonly supersedesVersionId: string | null;
  /** sha-256 over {@link encodeContractVersion} of this version's content. */
  readonly contentHash: string;
}

export interface CreateContractVersionInput {
  readonly versionId: string;
  readonly content: ContractVersionContent;
}

/**
 * Length-frame a single value: `"<utf8 byte length>:<value>"`.
 *
 * The header is what makes the concatenated stream decodable. Without it, "where
 * does this field end?" has no answer that does not depend on the fields either
 * side of it, which is precisely the ambiguity an acceptance hash must not have.
 */
export function canonicalFrame(text: string): string {
  return `${Buffer.byteLength(text, "utf8")}:${text}`;
}

/**
 * Frame a list as `<count>:<item><item>...`, each item itself framed.
 *
 * The count is what stops one item from impersonating the next: without it,
 * `["1:a", "b"]` and `["a", "1:b"]` are the same token.
 */
function canonicalFrameList(items: readonly string[]): string {
  return `${items.length}:${items.join("")}`;
}

/**
 * The one unframed sentinel in this format: "no value".
 *
 * A present value is always a framed token. `~` begins with a character no
 * length header can begin with — a header starts with a digit, and the smallest
 * digit-headed token for a real value is `1:` — so no present value can produce
 * this token, and an attacker cannot forge an absent one.
 */
const NO_VALUE = "~";

function canonicalOptional(text: string | null | undefined): string {
  return text === null || text === undefined ? NO_VALUE : canonicalFrame(text);
}

/**
 * Freeze and copy the caller's clauses.
 *
 * Copied rather than referenced so a later mutation of the array the caller
 * still holds cannot change what this version claims to say. A version that can
 * be changed from outside its own object is not immutable, whatever `readonly`
 * says in the type.
 */
export function canonicalizeContractVersion(clauses: readonly ContractClause[]): readonly ContractClause[] {
  return Object.freeze(clauses.map((clause) => Object.freeze({ heading: clause.heading, text: clause.text })));
}

/**
 * The canonical byte-source for a contract version.
 *
 * Every field is written in a fixed order, read by name rather than by
 * `Object.keys`, and **both the field name and the field value are length
 * framed**. Two consequences, both tested:
 *
 * - Reordering the *caller's* object literal changes nothing.
 * - Moving a single character across any internal boundary changes the output —
 *   including an attacker who writes a field value that *imitates the framing*
 *   (`title: "A4:bodyZ"`). Framing only the containers and not the scalars
 *   passes every obvious test and still collides; see the attack test of that
 *   name, which is the reason this function frames both halves.
 */
export function encodeContractVersion(content: ContractVersionContent): string {
  const clauses = canonicalizeContractVersion(content.clauses);

  const fields: readonly string[] = [
    framedField("encoding", CANONICAL_ENCODING_VERSION),
    framedField("contractId", content.contractId),
    framedField("organizationId", content.organizationId),
    framedField("version", String(content.version)),
    framedField("title", content.title),
    framedField("body", content.body),
    framedToken(
      "clauses",
      canonicalFrameList(
        clauses.map((clause) => canonicalFrameList([canonicalFrame(clause.heading), canonicalFrame(clause.text)])),
      ),
    ),
    framedField("effectiveFrom", content.effectiveFrom.toISOString()),
    framedToken("expiresAt", canonicalOptional(dateToNullableIso(content.expiresAt))),
    framedToken("supersedesVersionId", canonicalOptional(content.supersedesVersionId ?? null)),
  ];

  return CANONICAL_ENCODING_VERSION + "\u0000" + fields.join("");
}

/**
 * `"<len>:name" + "<len>:value"` — the field name and a plain string value, both
 * framed.
 *
 * Framing both halves is what makes the stream self-delimiting: a reader walks
 * field to field using the name lengths alone, so no value can shift a boundary
 * in either direction.
 */
function framedField(name: string, value: string): string {
  return canonicalFrame(name) + canonicalFrame(value);
}

/**
 * `"<len>:name" + token`, for values that are **already** a framed token — a
 * framed list, or the {@link NO_VALUE} sentinel.
 *
 * Separated from {@link framedField} on purpose. Folding them into one function
 * that always framed would double-frame lists; folding them into one that never
 * framed would silently leave scalars unframed, which is exactly the collision
 * the attack test in `version.test.ts` is built to catch. Two names, two
 * obligations.
 */
function framedToken(name: string, token: string): string {
  return canonicalFrame(name) + token;
}

function dateToNullableIso(date: Date | null | undefined): string | null {
  return date === null || date === undefined ? null : date.toISOString();
}

/**
 * The content hash of a contract version.
 *
 * Pure and total: the same content always yields the same hash, on any machine,
 * in any process. That is what makes an acceptance recorded today re-verifiable
 * by an auditor in five years with a different build of this code.
 */
export function hashContractVersion(content: ContractVersionContent): string {
  return createHash(CONTRACT_HASH_ALGORITHM).update(encodeContractVersion(content), "utf8").digest("hex");
}

/**
 * Validate, stamp and deep-freeze a contract version.
 *
 * Rejects the shapes that would make the hash a hash of nothing meaningful: no
 * clauses, a blank title, a version number below 1, an expiry that is not after
 * the effective date. Each of those produces a document that is indistinguishable
 * from a load failure six months later.
 */
export function createContractVersion(input: CreateContractVersionInput): ContractVersion {
  const { content } = input;

  if (content.clauses.length === 0) {
    throw new Error(`Contract ${content.contractId} version ${content.version} has no clauses: there is nothing to sign`);
  }
  if (!Number.isInteger(content.version) || content.version < 1) {
    throw new Error(
      `Contract ${content.contractId} version ${content.version} is not a positive integer; version numbers start at 1`,
    );
  }
  if (content.title.trim() === "") {
    throw new Error(`Contract ${content.contractId} version ${content.version} has a blank title`);
  }
  for (const clause of content.clauses) {
    if (clause.heading.trim() === "") {
      throw new Error(
        `Contract ${content.contractId} version ${content.version} has a clause with a blank heading; an unheaded clause is not identifiable when someone disputes it`,
      );
    }
  }

  const expiresAt = content.expiresAt ?? null;
  if (expiresAt !== null && expiresAt.getTime() <= content.effectiveFrom.getTime()) {
    throw new Error(
      `Contract ${content.contractId} version ${content.version} expires at ${expiresAt.toISOString()}, at or before its effective date ${content.effectiveFrom.toISOString()}`,
    );
  }

  const clauses = canonicalizeContractVersion(content.clauses);

  return Object.freeze({
    versionId: input.versionId,
    contractId: content.contractId,
    organizationId: content.organizationId,
    version: content.version,
    title: content.title,
    body: content.body,
    clauses,
    effectiveFrom: content.effectiveFrom,
    expiresAt,
    supersedesVersionId: content.supersedesVersionId ?? null,
    contentHash: hashContractVersion(content),
  });
}

/**
 * Whether a version's recorded hash still matches its content.
 *
 * Returns a boolean so a caller can report over a batch. Call sites that are
 * about to *trust* the version should prefer {@link assertContractVersionVerified},
 * which cannot be ignored by accident.
 */
export function verifyContractVersion(version: ContractVersion): boolean {
  return hashContractVersion(version) === version.contentHash;
}

/**
 * {@link verifyContractVersion} as a throw.
 *
 * Two call sites with different names, because a boolean and a guarantee are not
 * the same thing: a `false` that a caller ignores proves nothing, while a throw
 * cannot be ignored by accident.
 */
export function assertContractVersionVerified(version: ContractVersion): void {
  if (!verifyContractVersion(version)) {
    throw new Error(
      `Contract version ${version.versionId} does not match its recorded content hash (recorded ${version.contentHash}, recomputed ${hashContractVersion(version)}). The content was altered after it was hashed.`,
    );
  }
}