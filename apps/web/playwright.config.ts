import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration.
 *
 * TWO PROJECTS, ONE BROWSER.
 *
 * `e2e` runs the functional smoke tests. `a11y` runs the accessibility suite.
 * They are separate projects so `pnpm test:a11y` can be a release gate on its
 * own — spec §9 lists "WCAG 2.2 AA on every route" as a distinct layer from
 * "every primary workflow", and they fail for different reasons and get fixed
 * by different people.
 *
 * THE SERVER IS THE PRODUCTION BUILD.
 *
 * `webServer` runs `next start`, not `next dev`. That is not a convenience.
 * axe-core's `color-contrast` rule reads COMPUTED styles from a real layout
 * engine; the development build injects a dev overlay, a Fast-Refresh runtime
 * and a large dev stylesheet, all of which change computed colours and add
 * elements. Running the accessibility gate against `next dev` would be running
 * it against a page no user ever sees.
 *
 * It also means the a11y suite exercises the same artefact that ships, including
 * the CSP from `next.config.ts`.
 *
 * The server is started with a placeholder auth secret and NO database. That is
 * deliberate and its consequences are stated in `a11y.spec.ts` and
 * `smoke.spec.ts`: routes behind the session guard cannot be reached without a
 * database, so they are covered by the jsdom suite in `src/__tests__/` and by
 * the token-level contrast arithmetic in `packages/ui`, not by pretending.
 */
const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  workers: process.env["CI"] !== undefined ? 2 : undefined,
  // The HTML report is written under `coverage/`, not the default
  // `playwright-report/`.
  //
  // The repository's flat ESLint config ignores `**/coverage/**` but not
  // `**/playwright-report/**`, and the default report ships a bundled
  // CodeMirror viewer whose `.js` files the type-aware parser then refuses to
  // lint ("was not found by the project service"). Putting the report under an
  // already-ignored, already-gitignored directory keeps `eslint .` at the repo
  // root clean without touching a config this package does not own.
  reporter: [["list"], ["html", { open: "never", outputFolder: "coverage/playwright" }]],

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Deterministic rendering: a sub-pixel difference can flip an antialiased
    // text edge and produce a flaky contrast result.
    deviceScaleFactor: 1,
  },

  projects: [
    {
      name: "e2e",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "a11y",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: process.env["CI"] === undefined,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      // Placeholder only. There is no database in this environment, so no
      // session can be established; see the module comment above.
      BETTER_AUTH_SECRET: "e2e-placeholder-not-a-real-secret-0123456789abcdef",
      BETTER_AUTH_URL: BASE_URL,
      // Point at a port nothing is listening on so the readiness probe fails
      // fast (2s) instead of hanging on a TCP connect to a black hole.
      DATABASE_URL: "postgresql://raptor_app@127.0.0.1:59999/raptor_os",
    },
  },
});