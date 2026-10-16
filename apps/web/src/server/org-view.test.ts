import { describe, expect, it } from "vitest";

import { isUuid, parseRecentOrgs, splitSessionToken } from "./org-view";

/**
 * Switch-form guards without a session: malformed ids, token shapes, and
 * hostile cookie contents are all refused before any database is involved.
 */
describe("org switch guards", () => {
  it("accepts only UUID organisation ids", () => {
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isUuid("not-an-id")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000; DROP TABLE organization;")).toBe(false);
  });

  it("takes the token half of a signed session cookie", () => {
    expect(splitSessionToken("abc123.sig-here")).toBe("abc123");
    expect(splitSessionToken(undefined)).toBeNull();
    expect(splitSessionToken("")).toBeNull();
  });

  it("reads recent orgs defensively", () => {
    expect(parseRecentOrgs(undefined)).toEqual([]);
    expect(parseRecentOrgs("not json{{")).toEqual([]);
    expect(parseRecentOrgs('{"id":"x"}')).toEqual([]);
    expect(
      parseRecentOrgs(JSON.stringify([{ id: "a", name: "A" }, { id: 1 }, null])),
    ).toEqual([{ id: "a", name: "A" }]);
  });
});
