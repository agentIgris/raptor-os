import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    /**
     * Raised from the 5s default.
     *
     * `auth-server.test.ts` re-imports `@raptor/auth` — and therefore all of
     * `better-auth` — three times, because `tryGetAuth` memoises its instance
     * and each test needs a clean module registry. That import takes about a
     * second on an idle machine and materially longer when the runner has
     * every core busy.
     *
     * This accommodates a real, measured cost; it is not a hidden hang. The
     * assertions themselves are synchronous, and nothing in this package's
     * tests waits on a network or a timer.
     */
    testTimeout: 20_000,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // The `@raptor/*` packages export TypeScript source directly from `src/`.
    // Vitest externalises anything under node_modules by default, and an
    // externalised `.ts` file cannot be transformed — the failure shows up as
    // "Unexpected token 'export'" from deep inside a workspace package. Inlining
    // them makes Vite compile the same source Next compiles.
    server: {
      deps: {
        inline: [/@raptor\//],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Only the modules a unit test can reach without a Next.js runtime.
      //
      // `src/app/**` is deliberately EXCLUDED rather than counted: those are
      // React Server Components that need the framework's renderer, the RSC
      // payload and a request to execute at all. Counting them would have
      // produced a coverage number dominated by files no unit test could ever
      // load — 22% for `apps/web` at the time this comment was written — which
      // is a number that measures the framework, not the code.
      //
      // `src/app/**` is covered instead by the Playwright suite, which runs the
      // real production build: `e2e/smoke.spec.ts` exercises the routes, the
      // health endpoints, the session guard and the response headers, and
      // `e2e/a11y.spec.ts` runs axe-core over the rendered markup.
      include: ["src/server/**/*.ts", "src/proxy.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test/**"],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});