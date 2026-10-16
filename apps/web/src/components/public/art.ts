import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Public art resolution with placeholder fallback.
 *
 * Convention: `/placeholders/<kind>-<slug>.png` wins when present (exact
 * dimensions per BRAND-ASSETS-REQUIRED.md), otherwise the generic
 * placeholder for that kind. Existence is checked server-side at render, so
 * a missing file degrades to the placeholder instead of a broken image.
 *
 * `slug` is strictly validated — handles and game slugs come from the
 * database (operator-entered), and must never become path traversal.
 */

const PLACEHOLDERS = "/placeholders";

function safeSlug(value: string): string | null {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null;
}

function fileExists(publicPath: string): boolean {
  return existsSync(join(process.cwd(), "public", ...publicPath.split("/").slice(1)));
}

export interface ResolvedArt {
  readonly src: string;
  /** False when the generic placeholder is standing in. */
  readonly real: boolean;
}

/** Division tile art for a game, else the generic tile. */
export function divisionArt(gameSlug: string): ResolvedArt {
  const slug = safeSlug(gameSlug);
  const candidate = slug === null ? null : `${PLACEHOLDERS}/division-${slug}.png`;
  if (candidate !== null && fileExists(candidate)) return { src: candidate, real: true };
  return { src: `${PLACEHOLDERS}/division.svg`, real: false };
}

/** Player portrait by handle (e.g. `RExIGRIS`), else the generic portrait. */
export function playerPortrait(handle: string): ResolvedArt {
  const slug = safeSlug(handle);
  const candidate = slug === null ? null : `${PLACEHOLDERS}/player-${slug}.png`;
  if (candidate !== null && fileExists(candidate)) return { src: candidate, real: true };
  return { src: `${PLACEHOLDERS}/player-portrait.svg`, real: false };
}
