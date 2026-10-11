/**
 * The client-token-storage guard.
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 * ---------------------------------
 * The legacy application stored the session — INCLUDING the refresh token — in
 * `localStorage`:
 *
 *   > "Session — including the refresh token — is stored in `localStorage`."
 *   > (AUDIT/09, F-AUTH-01, HIGH)
 *
 * `localStorage` is readable by any script running in the origin. One XSS in
 * any dependency therefore became *persistent* account takeover, for admins
 * too, because what was stolen was a full session rather than a short-lived
 * access token. It is invisible in review, because the code looks like a
 * completely ordinary caching pattern, and it is trivially reintroduced by
 * anyone who has seen a hundred other applications do it.
 *
 * `packages/auth` prevents it on the server: every cookie it sets is `httpOnly`
 * (`advanced.defaultCookieAttributes.httpOnly`), so the session is not
 * readable by JavaScript at all. This test is the client half of the same
 * control.
 *
 * WHAT IS ASSERTED
 * ----------------
 * `localStorage`, `sessionStorage` and `document.cookie` must not appear
 * ANYWHERE in the shipped source of `apps/web` or `packages/ui` — not with a
 * token, not with a user id, not with a cache key. The rule is total rather
 * than pattern-matched on token-shaped names because:
 *
 *  1. there is no legitimate use of any of the three in this application, so a
 *     total rule costs nothing;
 *  2. a pattern that matched "session", "token", "jwt", "refresh" is a rule
 *     that can be defeated by renaming a variable — and the failure mode it
 *     protects against is an attacker-controlled one;
 *  3. a test that greps for `localStorage.setItem("token"` passes while
 *     `sessionStorage.setItem(getTokenName(), value)` ships.
 *
 * The whole file is scanned, comments included. A `// localStorage is bad`
 * comment is harmless and gets excluded explicitly, because otherwise the
 * explanation of the rule would trip the rule.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCANNED_ROOTS = [
  join(REPO_ROOT, "apps", "web", "src"),
  join(REPO_ROOT, "packages", "ui", "src"),
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Skipped because they ARE this test, or are not shipped source. */
const IGNORED_SEGMENTS = new Set(["node_modules", ".next", "dist", "coverage", "test-results"]);

/**
 * This file names every forbidden symbol in order to forbid it, so it is the
 * one file that is necessarily non-compliant. Excluded by exact filename rather
 * than by directory, so a second file in `__tests__` is still scanned.
 */
const SELF = "no-client-token-storage.test.ts";

const FORBIDDEN = [
  { token: "localStorage", label: "localStorage" },
  { token: "sessionStorage", label: "sessionStorage" },
  { token: "document.cookie", label: "document.cookie" },
  { token: "Cookies.get", label: "next/headers cookies()" },
];

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly label: string;
  readonly text: string;
}

/** Strip comments so this file's own explanation of the rule does not trip it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectSources(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (IGNORED_SEGMENTS.has(entry)) continue;
    if (entry === SELF) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
    } else {
      const dot = entry.lastIndexOf(".");
      const extension = dot === -1 ? "" : entry.slice(dot);
      if (SOURCE_EXTENSIONS.has(extension)) out.push(full);
    }
  }
  return out;
}

function scan(): Offence[] {
  const offences: Offence[] = [];

  for (const root of SCANNED_ROOTS) {
    for (const file of collectSources(root)) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      const lines = stripped.split(/\r?\n/);

      lines.forEach((text, index) => {
        for (const rule of FORBIDDEN) {
          if (text.includes(rule.token)) {
            offences.push({
              file: relative(REPO_ROOT, file).split(sep).join("/"),
              line: index + 1,
              label: rule.label,
              text: text.trim(),
            });
          }
        }
      });
    }
  }

  return offences;
}

describe("client token storage", () => {
  it("finds source files to scan — a zero-file scan would pass vacuously", () => {
    // The most dangerous failure mode for a guard like this is a bad path that
    // scans nothing and reports a pass. So the scan is asserted to have
    // covered real files first.
    const files = SCANNED_ROOTS.flatMap((root) => collectSources(root));
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.includes(join("apps", "web", "src")))).toBe(true);
    expect(files.some((file) => file.includes(join("packages", "ui", "src")))).toBe(true);
    // The guard itself is the one file that names the forbidden symbols.
    expect(files.some((file) => file.endsWith(SELF))).toBe(false);
  });

  it("no shipped source in apps/web or packages/ui touches localStorage, sessionStorage or document.cookie", () => {
    const offences = scan();
    const report = offences
      .map((offence) => `  ${offence.file}:${offence.line} — ${offence.label} → ${offence.text}`)
      .join("\n");

    expect(
      offences,
      `Client-side token storage found. The session must live only in an httpOnly cookie; storing it ` +
        `in localStorage is what made the legacy app's XSS a persistent account takeover ` +
        `(AUDIT/09, F-AUTH-01).\n${report}`,
    ).toEqual([]);
  });
});