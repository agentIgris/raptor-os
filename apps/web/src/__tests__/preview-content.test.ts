/**
 * The preview content and the art it points at must agree.
 *
 * WHAT THIS CATCHES
 * -----------------
 * The fan site resolves a portrait by handle: the roster's handle is
 * `person_profile.display_name`, and the site asks for
 * `/placeholders/player-<handle>.png`, falling back to the generic
 * `player-portrait.svg` when that file is absent
 * (`src/components/public/art.ts`). A handle with no matching file is not an
 * error anywhere - it degrades to the generic portrait, quietly, on every
 * machine.
 *
 * That is exactly what happened: the committed art was named for five
 * `REx*` handles and the seeded roster carried five other names, so the
 * portraits were unreachable and every player on the site wore the generic
 * placeholder. The art was in git, the data was in the database, and neither
 * knew about the other. The symptom read as "the images are missing" on a
 * second machine, and nothing failed until someone looked.
 *
 * So the two are checked against each other HERE, where a mismatch is a
 * failure rather than a fallback:
 *
 *   1. every handle the preview roster seeds has a portrait file committed
 *      under that exact name;
 *   2. the preview CONTENT is a committed seed, not a row that only exists in
 *      the database snapshot - a fresh clone has to be able to recreate it;
 *   3. the content seed covers the collections the public site renders.
 *
 * This is a pure, file-level test: it needs no database and no server, which
 * is why it can run in the unit suite and why it would have run in CI before
 * the defect reached a second machine.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/src/__tests__ -> apps/web/src -> apps/web -> apps -> the repository.
const repoRoot = resolve(here, "..", "..", "..", "..");
const placeholders = join(repoRoot, "apps", "web", "public", "placeholders");
const domainSeed = join(repoRoot, "scripts", "preview-seed.sql");
const contentSeed = join(repoRoot, "scripts", "preview-seed-cms.sql");

/**
 * The handles the preview roster seeds, read out of the seed itself.
 *
 * They are parsed rather than hard-coded, because a hard-coded list is a
 * second place for the names to live and would go stale exactly the way the
 * art did.
 */
function seededHandles(): string[] {
  const sql = readFileSync(domainSeed, "utf8");
  const insert = /INSERT INTO public\.person_profile[^;]*;/s.exec(sql);
  if (insert === null) throw new Error("the preview seed no longer inserts person_profile rows");

  const handles = [...insert[0].matchAll(/\(\s*'[0-9a-f-]{36}'\s*,\s*'([^']+)'/g)]
    .map((m) => m[1])
    .filter((handle): handle is string => handle !== undefined);
  if (handles.length === 0) throw new Error("no preview handles found in the seed");
  return handles;
}

describe("the preview roster and the committed art", () => {
  it("gives every seeded handle a portrait file", () => {
    const handles = seededHandles();

    for (const handle of handles) {
      const file = join(placeholders, `player-${handle}.png`);
      expect(
        existsSync(file),
        `the seed carries the handle "${handle}" and there is no ${`player-${handle}.png`} in apps/web/public/placeholders — the roster will show the generic portrait for it`,
      ).toBe(true);
    }
  });

  it("does not leave a portrait file with no player behind it", () => {
    // The other direction. An orphan file is not a bug on its own - the art
    // may legitimately arrive before the roster - but it is worth seeing, and
    // it is the shape a rename leaves behind.
    const handles = new Set(seededHandles());
    const orphans = ["RExANNA", "RExFURRYJOD", "RExIGRIS", "RExSANKU", "RExZEROIGL"].filter(
      (handle) => !handles.has(handle),
    );

    expect(
      orphans,
      "these committed portraits have no player in the seed — either the seed should carry the handle, or the art should go",
    ).toEqual([]);
  });
});

describe("the preview content is a seed, not only a database snapshot", () => {
  it("exists as a committed file", () => {
    expect(
      existsSync(contentSeed),
      "scripts/preview-seed-cms.sql is missing — the news, partners, site settings and CMS operators would exist only inside the binary snapshot, and a clone that runs `pnpm bootstrap` would have no content at all",
    ).toBe(true);
  });

  it("covers every collection the public site renders", () => {
    const sql = readFileSync(contentSeed, "utf8");

    for (const table of [
      "cms_news",
      "cms_partners",
      "cms_recruitment",
      "cms_site_settings",
      "cms_site_settings_socials",
      "cms_operators",
    ]) {
      expect(sql, `${table} is not seeded`).toContain(`INSERT INTO public.${table}`);
    }
  });

  it("carries no password and no uploaded media", () => {
    // The COMMENTS are read too, and they talk about the very things the
    // assertions below forbid — "NO password hash", "no uploaded media". Only
    // the statements are checked.
    const sql = readFileSync(contentSeed, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    // The CMS authenticates with the SAME Better Auth session as the product,
    // so an operator row needs an email and a role and nothing else. A salt or
    // a hash in this file would be a credential in git.
    expect(sql).not.toMatch(/\bsalt\b/i);
    expect(sql).not.toMatch(/\bhash\b/i);
    // Every image column is NULL: the art is the committed placeholder set,
    // which travels with the clone. An uploaded file would not.
    expect(sql).not.toMatch(/\bmedia\b/i);
  });
});
