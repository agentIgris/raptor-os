import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";

/**
 * The minimum shape of the webpack config this file touches.
 *
 * Next types its `webpack` hook parameter as `any`. Returning and mutating an
 * `any` is exactly what the repository's type-aware lint rules exist to catch,
 * so the hook states the shape it actually relies on instead of inheriting the
 * `any`. Assigning this narrower function to the hook is sound: `any` is
 * assignable to any parameter type.
 */
interface WebpackConfigLike {
  readonly resolve: {
    extensionAlias?: Record<string, readonly string[]>;
  };
}

/**
 * Next.js configuration.
 *
 * Three decisions are load-bearing and each one exists because the legacy
 * project got it wrong.
 *
 * 1. THE BUILD-TIME GATES STAY ON (ADR-0012).
 *    `typescript.ignoreBuildErrors` is stated as `false`. The legacy
 *    `next.config.mjs` set both `ignoreBuildErrors` and `ignoreDuringBuilds`
 *    to `true` with the comment *"Relax build-time checks to prevent
 *    non-critical warnings from failing CI builds"* — and the direct result was
 *    a shipped `ReferenceError: getUserFromRequest is not defined`. It is
 *    `false` here rather than merely absent so that `build-gates.test.ts` can
 *    assert the literal value and fail if a later edit flips it back on.
 *
 *    The sibling `eslint.ignoreDuringBuilds` does not appear here because
 *    **Next.js 16 removed it**: `next lint` no longer exists and the build no
 *    longer runs ESLint, so the property is not in the `NextConfig` type and
 *    setting it would be a type error rather than a silent no-op. The lint
 *    gate in this app is the repository's own `eslint . --max-warnings 0`,
 *    which runs as its own command and cannot be relaxed from this file.
 *    `build-gates.test.ts` asserts the key is ABSENT, so that downgrading to a
 *    Next version that accepts it is a deliberate, visible act.
 *
 * 2. `transpilePackages` for the workspace source packages.
 *    Every `@raptor/*` package exports TypeScript source directly from
 *    `src/`, so the bundler has to compile them. Without this, importing
 *    `@raptor/observability` from a server component produces a build that
 *    "works" until the first request, which is the same shape of defect as
 *    the ReferenceError above.
 *
 * 3. `typedRoutes` and `reactStrictMode` are on.
 *    `typedRoutes` makes a bad `href` a type error rather than a 404 found by
 *    a user. It is on in production only, because in development it hides
 *    Fast Refresh warnings that are worth reading.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  transpilePackages: ["@raptor/ui", "@raptor/core", "@raptor/observability", "@raptor/auth", "@raptor/cms"],

  typescript: {
    // ADR-0012. See above. Do not remove; there is a test that fails if this
    // becomes `true`.
    ignoreBuildErrors: false,
  },

  typedRoutes: process.env["NODE_ENV"] === "production",

  /**
   * Resolve `./x.js` to `./x.ts` / `./x.tsx`.
   *
   * WHY THIS IS NECESSARY, AND WHAT IT COSTS
   * -----------------------------------------
   * Every `@raptor/*` package exports TypeScript source directly from its
   * `exports` map (`".": "./src/index.ts"`), and those files are written with
   * NodeNext specifiers — `import { logger } from "./logger.js"` — because that
   * is what TypeScript's `NodeNext` resolution requires for a package whose
   * output runs in Node. That is correct for the package and wrong for a
   * bundler consuming the *source*: `./logger.js` does not exist on disk, only
   * `./logger.ts` does.
   *
   * Neither Next.js 16's Turbopack nor its webpack build applies the
   * TypeScript `.js` -> `.ts` substitution out of the box, so the build fails
   * with `Module not found: Can't resolve './logger.js'` — verified, not
   * assumed; both bundlers were run and both failed this way before this block
   * existed. `extensionAlias` is the standard, declarative fix.
   *
   * THE COST, stated plainly: this is a webpack hook, and webpack is not
   * Next.js 16's default bundler. So `next build` and `next dev` must both be
   * run with `--webpack`, which the package scripts do. Turbopack cannot
   * express a relative, per-importer extension substitution, so the choice is
   * "webpack with an explicit alias" or "no domain packages in the web app at
   * all". The former is taken deliberately.
   *
   * The alternative that was rejected: aliasing `@raptor/core/money` to
   * `packages/core/dist/money/index.js` through tsconfig `paths`. That keeps
   * Turbopack but makes the web app depend on build ORDER — the app would
   * compile against whatever `dist/` happened to contain, and a stale `dist`
   * would produce a build that succeeds against last week's domain logic. A
   * correct build of the wrong code is worse than a loud failure.
   *
   * If the workspace packages ever point their `exports` at `dist` — which is
   * arguably the better monorepo shape — this block and both `--webpack` flags
   * can be deleted. That change belongs to whoever owns those packages.
   */
  webpack(config: WebpackConfigLike): WebpackConfigLike {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },

  // Synchronous: there is nothing to await. Next accepts either a plain array
  // or a promise of one.
  //
  // NOTE: the Content-Security-Policy is NOT set here. It needs a per-request
  // nonce, so it lives in `src/proxy.ts` — see the long comment there for
  // what broke when it was a static header.
  headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default withPayload(nextConfig);