import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],

    // These suites share ONE PGlite instance's worth of schema per worker, and
    // each file empties every auth table in its own `beforeEach`/`beforeAll`.
    // Running the files concurrently would have them truncating each other's
    // fixtures mid-test. (Before the move to PGlite they shared a real server
    // database, `raptor_os_test`; each file now builds its OWN in-memory
    // instance, but the truncation coupling inside a file is unchanged.)
    //
    // Serialising the files is the honest fix. The alternative — a database per
    // worker — buys real parallelism at the cost of provisioning N databases and
    // N sets of credentials, which is disproportionate for a package this size.
    // Tests still run concurrently WITHIN a file where they do not share state.
    fileParallelism: false,

    // The integration tests run against an in-process PGlite instance
    // (PostgreSQL 18.3 in WebAssembly), NOT a native PostgreSQL server. Native
    // PostgreSQL cannot start a backend on this machine — every child dies with
    // 0xC0000142, 0 of 30 connections succeeded — so ADR-0014's claim that
    // removing antivirus fixed it was superseded by
    // `docs/adr/0015-pglite-restored-after-native-postgres-retest.md`, which
    // restores ADR-0002's original conclusion. See `test-database.ts`.
    //
    // PGlite is not a stub for the properties asserted here: FORCE ROW LEVEL
    // SECURITY, a `timestamptz` comparison against `now()`, and rate-limit
    // counters persisted in a table are all engine behaviour, and
    // `packages/db/scripts/pglite-capability.ts` records that it enforces them.
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