import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_EMAIL_FROM, sendPasswordResetEmail, sendVerificationEmail } from "./email.js";
/**
 * The mailer without a mail server: Resend speaks HTTPS, so `fetch` is the
 * only seam. Every test asserts on the request that WOULD leave the process
 * and on the failures the caller would see — never on a real delivery.
 */
function mockResend(response: unknown): { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    (url: string, init: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { entries: () => [] as [string, string][] },
        json: () => Promise.resolve(response),
        text: () => Promise.resolve(JSON.stringify(response)),
      });
    },
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const TRANSPORT = { apiKey: "re_test_key", from: DEFAULT_EMAIL_FROM };

describe("development fallback (no key, NODE_ENV=development)", () => {
  function spyConsoleWarn(): { lines: string[] } {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((first: unknown) => {
      lines.push(String(first));
    });
    return { lines };
  }

  it("prints the verification link to the console and sends nothing", async () => {
    const { calls } = mockResend({ data: { id: "msg-1" }, error: null });
    const { lines } = spyConsoleWarn();
    vi.stubEnv("NODE_ENV", "development");

    await sendVerificationEmail({ apiKey: undefined, from: DEFAULT_EMAIL_FROM }, {
      user: { email: "new@example.com" },
      url: "https://app.example/verify?token=bearer-credential",
    });

    expect(calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("bearer-credential");
    expect(lines.join("\n")).toContain("new@example.com");
  });

  it("prints the reset link the same way", async () => {
    const { calls } = mockResend({ data: { id: "msg-2" }, error: null });
    const { lines } = spyConsoleWarn();
    vi.stubEnv("NODE_ENV", "development");

    await sendPasswordResetEmail({ apiKey: undefined, from: DEFAULT_EMAIL_FROM }, {
      user: { email: "owner@example.com" },
      url: "https://app.example/reset?token=bearer-credential",
    });

    expect(calls).toHaveLength(0);
    expect(lines.join("\n")).toContain("bearer-credential");
  });

  it("never triggers outside development — a missing key still refuses in staging/production", async () => {
    mockResend({ data: { id: "msg-3" }, error: null });
    spyConsoleWarn();
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      sendVerificationEmail({ apiKey: undefined, from: DEFAULT_EMAIL_FROM }, {
        user: { email: "new@example.com" },
        url: "https://app.example/verify?token=t",
      }),
    ).rejects.toThrow("RESEND_API_KEY");
  });
});

describe("verification email", () => {
  it("sends to the user with the verification URL and no secrets in the envelope", async () => {
    const { calls } = mockResend({ data: { id: "msg-1" }, error: null });
    await sendVerificationEmail(TRANSPORT, {
      user: { email: "new@example.com" },
      url: "https://app.example/verify?token=bearer-credential",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body["to"]).toBe("new@example.com");
    expect(calls[0]?.body["subject"]).toContain("Verify");
    expect(JSON.stringify(calls[0]?.body)).toContain("bearer-credential");
  });

  it("refuses loudly without a key instead of swallowing the signup", async () => {
    mockResend({ data: { id: "msg-1" }, error: null });
    await expect(
      sendVerificationEmail({ apiKey: undefined, from: DEFAULT_EMAIL_FROM }, {
        user: { email: "new@example.com" },
        url: "https://app.example/verify?token=t",
      }),
    ).rejects.toThrow("RESEND_API_KEY");
  });

  it("surfaces provider refusals without leaking the address", async () => {
    const refusal = { message: "rejected: test mode" };
    vi.stubGlobal(
      "fetch",
      () =>
        Promise.resolve({
          ok: false,
          status: 400,
          headers: { entries: () => [] as [string, string][] },
          json: () => Promise.resolve({ data: null, error: refusal }),
          text: () => Promise.resolve(JSON.stringify({ error: refusal })),
        }),
    );
    const failure = await sendVerificationEmail(TRANSPORT, {
      user: { email: "new@example.com" },
      url: "https://app.example/verify?token=t",
    }).catch((error: unknown) => (error instanceof Error ? error.message : ""));
    expect(failure).toContain("refused");
    expect(failure).not.toContain("new@example.com");
  });
});

describe("password-reset email", () => {
  it("sends the reset URL to the account holder", async () => {
    const { calls } = mockResend({ data: { id: "msg-2" }, error: null });
    await sendPasswordResetEmail(TRANSPORT, {
      user: { email: "owner@example.com" },
      url: "https://app.example/reset?token=bearer-credential",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body["to"]).toBe("owner@example.com");
    expect(JSON.stringify(calls[0]?.body)).toContain("bearer-credential");
  });
});
