import type { Access } from "payload";

/**
 * Shared CMS access rules.
 *
 * Two identities exist in this system and they must not be confused:
 *
 * - `req.user` is a Payload CMS operator (`cms_operators`). It is set only by
 *   Payload's own auth (local accounts now, Better Auth session strategy in
 *   Task 9). Product users from Better Auth NEVER appear here.
 * - Tenant scope comes from the `orgId` field on each document, validated
 *   against the operator's assignments in Task 9. Until then every operator
 *   is trusted across the single initial organization — stated, not hidden.
 *
 * Everything denies by default; each rule below opens exactly one door.
 */

/** Authenticated CMS operators only. `null` AND `undefined` both refuse: a
 * missing user that compared unequal to `null` would be an operator. */
export const isOperator: Access = ({ req }): boolean =>
  req.user !== null && req.user !== undefined;

/**
 * Published documents are public; anything else needs an operator.
 *
 * Returned as a Payload `where` constraint for logged-out callers so the
 * database filters, not the UI. Requires `versions: { drafts: true }` on the
 * collection (that is what maintains `_status`).
 */
export const publishedOrOperator: Access = ({ req }) => {
  if (req.user !== null && req.user !== undefined) return true;
  return { _status: { equals: "published" } };
};
