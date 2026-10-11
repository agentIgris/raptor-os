/**
 * The Content Security Policy.
 *
 * Every assertion here corresponds to something that was actually broken at
 * some point during this build, or that a well-meaning future edit would
 * plausibly break:
 *
 *  - `script-src 'self'` with no nonce blocked every inline bootstrap script,
 *    so React never hydrated. Verified by a console-error assertion in the
 *    end-to-end suite, not by reading the header.
 *  - Adding `'strict-dynamic'` to fix that blocked every EXTERNAL chunk,
 *    because Next puts the nonce on its inline scripts but not on its
 *    `<script src>` tags. Same symptom, opposite cause.
 *  - `'unsafe-inline'` would fix both, and would leave the header protecting
 *    nothing. That is the tempting fix and it is the wrong one.
 *
 * The policy is therefore asserted on directly rather than inferred from the
 * application behaving correctly, because "the app works" and "the header is
 * strict enough" are different claims.
 */

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy, proxy } from "../proxy";

const NONCE = "dGVzdC1ub25jZS12YWx1ZQ==";

function directive(policy: string, name: string): string {
  const found = policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  expect(found, `no ${name} directive in:\n${policy}`).toBeDefined();
  return found ?? "";
}

describe("Content-Security-Policy", () => {
  const policy = buildContentSecurityPolicy(NONCE);

  it("carries the nonce on script-src", () => {
    expect(directive(policy, "script-src")).toBe(`script-src 'self' 'nonce-${NONCE}'`);
  });

  it("never allows unsafe-inline or unsafe-eval scripts", () => {
    const scriptSrc = directive(policy, "script-src");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("does not use strict-dynamic, which disables host-based allowlisting", () => {
    // `'strict-dynamic'` makes the browser ignore `'self'` entirely and permit
    // only nonce-bearing scripts. Next.js does not put the nonce on its
    // external chunk tags, so every one of them is blocked and the page never
    // hydrates. This was measured in Chromium, not reasoned about.
    expect(directive(policy, "script-src")).not.toContain("'strict-dynamic'");
  });

  it("denies framing, plugins and base-tag rewriting", () => {
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
  });

  it("confines every fetch and form to this origin", () => {
    expect(directive(policy, "default-src")).toBe("default-src 'self'");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
    expect(directive(policy, "form-action")).toBe("form-action 'self'");
  });

  it("allows inline styles, and says why it is allowed", () => {
    // React sets inline `style` attributes. Inline styles are not a
    // script-execution sink, and this is the documented, deliberate exception
    // rather than a blanket loosening of script-src.
    expect(directive(policy, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
  });

  it("embeds the supplied nonce verbatim", () => {
    expect(policy).toContain(`'nonce-${NONCE}'`);
    expect(policy).not.toContain("'nonce-'");
  });
});

describe("the proxy handler", () => {
  function request(): NextRequest {
    return new NextRequest("https://raptor.test/dashboard");
  }

  it("sets the policy on the RESPONSE, which is what the browser enforces", () => {
    const response = proxy(request());
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'nonce-");
  });

  it("sets the policy on the REQUEST, which is where Next reads the nonce from", () => {
    // Both headers are required. Setting only the response header produces a
    // policy the rendered page cannot satisfy, and the symptom is a completely
    // silent failure: the page renders, every inline script is blocked, and
    // nothing anywhere reports an error.
    const response = proxy(request());
    const forwarded = response.headers.get("x-middleware-override-headers") ?? "";
    expect(forwarded.length).toBeGreaterThan(0);
  });

  it("issues a fresh nonce per request", () => {
    const nonceOf = (response: Headers): string =>
      /'nonce-([^']+)'/.exec(response.get("content-security-policy") ?? "")?.[1] ?? "";

    const first = nonceOf(proxy(request()).headers);
    const second = nonceOf(proxy(request()).headers);

    expect(first).not.toBe("");
    // A shared nonce is a static nonce: an attacker who reads one page can
    // reuse it for an injected script on another.
    expect(first).not.toBe(second);
  });

  it("does not mutate the policy template between calls", () => {
    proxy(request());
    proxy(request());
    // A module-level constant would be observable here: if `buildPolicy`
    // appended to or reused a buffer, the second call would differ from the
    // first. It must be a pure function of its argument.
    expect(buildContentSecurityPolicy(NONCE)).toBe(buildContentSecurityPolicy(NONCE));
  });
});