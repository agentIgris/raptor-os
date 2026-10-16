import { describe, expect, it, vi } from "vitest";

import {
  gateOperatorMfa,
  resolveOperatorSession,
  sessionTokenFromCookieHeader,
  type OperatorSessionRow,
} from "./better-auth-strategy.js";

/**
 * The session strategy without a session: cookie parsing, the MFA gate, and
 * the resolve-then-decide flow against a stubbed drizzle surface. Live
 * proof (real cookie → real operator) runs against the server in Task 9.
 */
const ROW: OperatorSessionRow = {
  operator_id: 7,
  email: "op@example.com",
  cms_role: "editor",
  product_role: "player",
  product_mfa: false,
};

describe("session cookie parsing", () => {
  it("takes the token half of either session cookie", () => {
    expect(sessionTokenFromCookieHeader("raptor.session_token=abc123.sig")).toBe("abc123");
    expect(sessionTokenFromCookieHeader("other=1; raptor-session_token=tok9.sig9; x=2")).toBe("tok9");
  });

  it("refuses everything else", () => {
    expect(sessionTokenFromCookieHeader(null)).toBeNull();
    expect(sessionTokenFromCookieHeader("")).toBeNull();
    expect(sessionTokenFromCookieHeader("session=abc")).toBeNull();
    expect(sessionTokenFromCookieHeader("raptor.session_token=")).toBeNull();
  });
});

describe("CMS MFA gate", () => {
  it("admits non-privileged roles without MFA", () => {
    expect(gateOperatorMfa(ROW)).toBe(true);
  });

  it("refuses privileged roles without TOTP", () => {
    expect(gateOperatorMfa({ ...ROW, product_role: "manager", product_mfa: false })).toBe(false);
    expect(gateOperatorMfa({ ...ROW, product_role: "owner", product_mfa: false })).toBe(false);
  });

  it("admits privileged roles with TOTP", () => {
    expect(gateOperatorMfa({ ...ROW, product_role: "admin", product_mfa: true })).toBe(true);
  });
});

describe("operator resolution", () => {
  it("returns the row the function returns", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [ROW] }) };
    await expect(resolveOperatorSession(db, "raptor.session_token=t.s")).resolves.toEqual(ROW);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("is null on missing cookie, null db, empty rows, bad rows and db errors", async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [ROW] }) };
    expect(await resolveOperatorSession(db, null)).toBeNull();
    expect(await resolveOperatorSession(null, "raptor.session_token=t.s")).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();

    const empty = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await resolveOperatorSession(empty, "raptor.session_token=t.s")).toBeNull();

    const bad = { execute: vi.fn().mockResolvedValue({ rows: [{ nope: 1 }] }) };
    expect(await resolveOperatorSession(bad, "raptor.session_token=t.s")).toBeNull();

    const failing = {
      execute: vi.fn().mockRejectedValue(new Error("down")),
    };
    expect(await resolveOperatorSession(failing, "raptor.session_token=t.s")).toBeNull();
  });
});
