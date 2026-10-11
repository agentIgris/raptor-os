/**
 * ADR-0012 — the build-time gates stay enabled.
 *
 * The legacy `next.config.mjs` set both `eslint.ignoreDuringBuilds` and
 * `typescript.ignoreBuildErrors` to `true`, commented *"Relax build-time
 * checks to prevent non-critical warnings from failing CI builds."* The result
 * was a live `ReferenceError: getUserFromRequest is not defined` shipping in
 * the attendance DELETE handler, plus nine endpoints broken by RLS changes,
 * plus every failed sign-in leaving no trace. All of it would have been caught
 * by the two checks that had been turned off.
 *
 * ADR-0012 requires "a CI check [that] fails the build if either becomes true".
 * This file is that check, scoped to the one config this app owns.
 *
 * It reads the file as TEXT and matches the property literally. Parsing and
 * evaluating the config would be stricter, but it would also stop being a check
 * on the artefact a reviewer actually reads — and the way this flag comes back
 * is a human typing `true`, not a clever refactor.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const NEXT_CONFIG_PATH = fileURLToPath(new URL("../../next.config.ts", import.meta.url));
const source = readFileSync(NEXT_CONFIG_PATH, "utf8");

/**
 * Comments are excluded from the "how many times is this flag mentioned" check.
 *
 * The config's own header explains, at length, which flags must stay `false` —
 * and that explanation names them. Counting the prose would make the assertion
 * meaningless, and it would fail on the day someone improved the comment.
 */
const sourceWithoutComments = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * Extract the value of a property inside a named config object.
 *
 * Deliberately narrow: it looks for `key: <boolean literal>` inside that one
 * object's own braces. Anything it cannot read — a spread, a variable, a
 * function call — is reported as "not a literal false", which is the fail-closed
 * answer, because the question being asked is "can a reviewer see that this is
 * off?".
 */
function readBooleanProperty(objectPath: string, key: string): string | undefined {
  const objectPattern = new RegExp(`${objectPath.replaceAll(".", "\\.")}\\s*:\\s*\\{`);
  const objectStart = objectPattern.exec(sourceWithoutComments);
  if (objectStart === null) return undefined;

  // Walk forward counting braces to find this object's own extent, so a nested
  // object's keys are never mistaken for this one's.
  const openIndex = sourceWithoutComments.indexOf("{", objectStart.index);
  let depth = 0;
  let endIndex = -1;
  for (let index = openIndex; index < sourceWithoutComments.length; index += 1) {
    const char = sourceWithoutComments[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
    }
  }
  if (endIndex === -1) return undefined;

  const body = sourceWithoutComments.slice(openIndex, endIndex + 1);
  const match = new RegExp(`\\b${key}\\s*:\\s*(true|false)\\b`).exec(body);
  return match?.[1];
}

describe("ADR-0012 build gates", () => {
  it("typescript.ignoreBuildErrors is not true", () => {
    const value = readBooleanProperty("typescript", "ignoreBuildErrors");
    expect(value, `typescript.ignoreBuildErrors reads as ${String(value)}`).toBe("false");
  });

  it("eslint.ignoreDuringBuilds is not true", () => {
    const value = readBooleanProperty("eslint", "ignoreDuringBuilds");
    expect(value, `eslint.ignoreDuringBuilds reads as ${String(value)}`).not.toBe("true");
  });

  it("never mentions the relaxed flags outside the explicit false", () => {
    // A second, subtler way to disable a gate: comment it out, or set it from
    // a variable. This asserts the only occurrence of each flag in the
    // executable config is the `false` assignment asserted above.
    expect(sourceWithoutComments.match(/ignoreBuildErrors/g) ?? []).toHaveLength(1);
  });

  it("does not set eslint.ignoreDuringBuilds — Next 16 removed build-time linting entirely", () => {
    // `next lint` no longer exists in Next 16 and the property is not in the
    // `NextConfig` type, so writing it would be a compile error rather than a
    // silent no-op. Asserting its ABSENCE means downgrading to a Next version
    // that accepts the flag again is a visible, deliberate act rather than
    // something that happens as a side effect of a dependency bump.
    expect(sourceWithoutComments).not.toContain("ignoreDuringBuilds");
    expect(sourceWithoutComments).not.toMatch(/\beslint\s*:\s*\{/);
  });

  it("keeps the lint gate as a separate command rather than a build-time one", () => {
    // The replacement for build-time linting is an explicit script, run on its
    // own and failing on its own.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(manifest.scripts?.["lint"]).toBe("eslint .");
    expect(manifest.scripts?.["ci"]).toBe("pnpm lint && pnpm typecheck && pnpm test");
  });
});

describe("next.config.ts content that is load-bearing", () => {
  it("transpiles the workspace source packages", () => {
    // Without this the build succeeds and the first request fails: the
    // packages export TypeScript source directly, and an untranspiled
    // workspace import only breaks once something actually evaluates it.
    for (const name of ["@raptor/ui", "@raptor/core", "@raptor/observability", "@raptor/auth"]) {
      expect(source, `${name} is not in transpilePackages`).toContain(`"${name}"`);
    }
  });

  it("does not block pinch-to-zoom", () => {
    // `userScalable: false` / `maximumScale: 1` is a WCAG 1.4.4 failure that
    // has no business appearing in this repo.
    expect(source).not.toMatch(/maximumScale\s*:\s*1\b/);
    expect(source).not.toMatch(/userScalable\s*:\s*false/);
  });

  it("does not allow unsafe-inline or unsafe-eval scripts", () => {
    // `script-src` needs `'unsafe-inline'` for neither Next's own bootstrap
    // scripts nor anything else: those carry a per-request nonce instead, set
    // in `src/proxy.ts`. See the comment there for what broke when the policy
    // was a static header with no nonce.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies ?? {}).toHaveProperty("next");

    const middleware = readFileSync(
      fileURLToPath(new URL("../../src/proxy.ts", import.meta.url)),
      "utf8",
    );

    // Comments are stripped first. The proxy's own documentation QUOTES the
    // policy — including a fragment that looks exactly like a directive — and
    // matching against prose would assert on the explanation rather than on
    // the code.
    const executable = middleware.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const scriptSrc = /`script-src[^`]*`/.exec(executable)?.[0] ?? "";

    expect(scriptSrc).not.toBe("");
    expect(scriptSrc).toContain("'nonce-");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    // `'strict-dynamic'` disables host-based allowlisting, and Next.js does not
    // put the nonce on its external chunk tags — so every chunk was blocked.
    expect(scriptSrc).not.toContain("'strict-dynamic'");
  });
});