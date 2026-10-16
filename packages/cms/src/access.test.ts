import type { Access } from "payload";
import { describe, expect, it } from "vitest";

import { isOperator, publishedOrOperator } from "./access.js";

type AccessArgs = Parameters<Access>[0];

function argsFor(user: unknown): AccessArgs {
  return { req: { user } } as unknown as AccessArgs;
}

/**
 * The CMS access rules, asserted without a database.
 *
 * These are pure functions over `{ req }`, so the deny-by-default posture is
 * provable in milliseconds. Anything involving `_status` filtering against
 * real rows belongs in Task 3's live publish-flow check, not here.
 */
describe("cms access rules", () => {
  it("refuses anonymous callers everywhere", () => {
    const anon = argsFor(null);
    expect(isOperator(anon)).toBe(false);
    expect(publishedOrOperator(anon)).toEqual({ _status: { equals: "published" } });
  });

  it("admits operators to everything", () => {
    const operator = argsFor({ id: "op-1", email: "op@example.com" });
    expect(isOperator(operator)).toBe(true);
    expect(publishedOrOperator(operator)).toBe(true);
  });

  it("never returns an operator-shaped answer for a missing user", () => {
    const missing = argsFor(undefined);
    expect(isOperator(missing)).toBe(false);
  });
});
