import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request Content Security Policy, with a nonce.
 *
 * FILE NAME
 * ---------
 * `proxy.ts`, exporting `proxy`. Next.js 16 deprecated the `middleware`
 * convention outright ("The 'middleware' file convention is deprecated. Please
 * use 'proxy' instead."), so the current name is used rather than a convention
 * that prints a deprecation warning on every build.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * The first version of this app shipped `script-src 'self'` with no nonce,
 * written straight into `next.config.ts`. It broke the application in a way
 * that no build, lint or unit test could see:
 *
 *   - Next.js emits INLINE bootstrap scripts carrying the RSC flight payload.
 *     `script-src 'self'` blocks every inline script.
 *   - With those scripts blocked, React never hydrates.
 *   - Every client component is inert. The mobile navigation's disclosure
 *     button reported `aria-expanded="false"` forever, and the console showed
 *     "Executing inline script violates the following Content Security Policy
 *     directive" plus React error #412.
 *
 * It was caught by an end-to-end test asserting there were no console errors,
 * which is the whole reason that assertion exists.
 *
 * WHY A NONCE RATHER THAN `'unsafe-inline'`
 * ----------------------------------------
 * Adding `'unsafe-inline'` would make the header stop protecting anything: any
 * injected `<script>` would then execute, which is precisely the XSS that this
 * product is built to survive (see the session-storage guard in
 * `src/__tests__/no-client-token-storage.test.ts`). A per-response nonce keeps
 * the policy strict: only scripts this server emitted for THIS response may
 * run, and an injected one has no nonce.
 *
 * A hash-based policy is not an option here: the flight payload changes on
 * every response, so its hash is not stable.
 *
 * THE COST, stated plainly: a nonce cannot be known at build time, so every
 * matched route is dynamically rendered. That is correct — the landing page of
 * a multi-tenant product is per-tenant anyway — but it is a real trade and is
 * recorded here rather than discovered later.
 */

/** Generate a fresh nonce for one response. */
function createNonce(): string {
  // `btoa` is available in both the Node and edge runtimes; `Buffer` is not.
  return btoa(crypto.randomUUID());
}

/**
 * The policy.
 *
 * EXPORTED so it can be asserted on directly. A Content-Security-Policy is the
 * one header where "looks right" is indistinguishable from "is right", and a
 * policy assembled inline in a request handler is the easiest thing in a
 * codebase to weaken by accident.
 *
 * `script-src` is `'self'` plus the nonce, and DELIBERATELY NOT
 * `'strict-dynamic'`. With `'strict-dynamic'` in the list the browser ignores
 * host-based allowlisting entirely and permits a script only if it carries the
 * nonce — and Next.js puts the nonce on its inline bootstrap scripts but not on
 * the `<script src="…/_next/static/chunks/…">` tags it emits. Every external
 * chunk was therefore blocked and the app never hydrated. That was measured,
 * not assumed: the browser logged one CSP violation per chunk.
 *
 * Without `'strict-dynamic'`, `'self'` allowlists same-origin chunks and the
 * nonce covers the inline ones, which is the documented Next.js arrangement.
 * The residual risk is the standard one for any `'self'` policy: an injected
 * same-origin file. That is a narrower hole than `'unsafe-inline'`, which
 * would let an injected `<script>` run at all.
 *
 * `style-src` DOES need `'unsafe-inline'`: React sets inline `style`
 * attributes for the dynamic values the components use. Inline *styles* are not
 * a script-execution sink, and removing them would mean a substantial refactor
 * for a materially smaller risk than the script one.
 */
export function buildContentSecurityPolicy(nonce: string): string {
  // `'unsafe-eval'` in development ONLY. Next.js Fast Refresh evaluates
  // compiled modules as strings, so the dev server cannot hydrate without it —
  // without hydration the sign-in form degrades to a native GET submit, which
  // puts the password in the URL query string (browser history, server logs).
  // Production builds (`next build`) contain no eval, so the production policy
  // omits it. `csp.test.ts` asserts the production policy never contains the
  // token: a development convenience that leaks into production is how a CSP
  // becomes decorative.
  const scriptSrc =
    process.env["NODE_ENV"] === "production"
      ? `script-src 'self' 'nonce-${nonce}'`
      : `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // `connect-src 'self'` covers /api/auth, which is the only origin this app
    // talks to. No external analytics, no CDN, no third-party embed.
    "connect-src 'self'",
    "form-action 'self'",
    // The session cookie is SameSite=Lax; framing is denied outright because
    // nothing here has any business being embedded.
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy(nonce);

  // The renderer reads the nonce off the REQUEST so it can stamp it onto the
  // inline scripts it emits; the RESPONSE header is what the browser enforces.
  // Both are required — setting only the response header produces a policy the
  // page cannot satisfy.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  // API routes return JSON and need no policy; `_next/static` is immutable
  // fingerprinted assets. Everything else gets a document response.
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon\\.ico|robots\\.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};