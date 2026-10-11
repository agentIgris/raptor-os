/**
 * Global test setup.
 *
 * Intentionally almost empty. `apps/web` has no shared test harness to
 * configure — the accessibility test needs jsdom and the rest do not, so the
 * environment is chosen per file with a `@vitest-environment` docblock rather
 * than forced on everything here.
 */

export {};