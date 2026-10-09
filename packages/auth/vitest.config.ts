import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],

    // These suites share ONE PostgreSQL database (`raptor_os_test`), and each
    // empties every auth table in its own `beforeEach`. Running the files
    // concurrently therefore has them truncating each other's fixtures
    // mid-test: sign-ins return "User not found", rate-limit counters collide
    // on their UNIQUE key, and concurrent TRUNCATE deadlocks.
    //
    // Serialising the files is the honest fix. The alternative — a database per
    // worker — buys real parallelism at the cost of provisioning N databases and
    // N sets of credentials, which is disproportionate for a package this size.
    // Tests still run concurrently WITHIN a file where they do not share state.
    fileParallelism: false,

    // The integration tests talk to the real local PostgreSQL 18.6 instance
    // (`raptor_os_test`) rather than a PGlite stub, because the properties being
    // asserted — FORCE ROW LEVEL SECURITY, a `timestamptz` comparison against
    // `now()`, and rate-limit counters persisted in a table — are exactly the
    // behaviours a stub would silently approximate.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});