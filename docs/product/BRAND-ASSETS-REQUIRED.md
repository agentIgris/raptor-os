# Raptor Esports — Brand Asset Requirements

**Status:** all rows `needed`. Placeholders with these exact filenames/sizes live in
`apps/web/public/placeholders/` and are referenced by that path in code.
To replace: drop the approved file over the same filename (or update the code
reference + this table in the same change). Never hotlink third-party URLs.

**Design constraints both themes must satisfy:** the site ships a light AND a
dark theme (toggle in every header). Marks must legible on both — prefer
neutral marks, or supply `-light` / `-dark` variants and note it below.
Photography sits under a dark scrim on the hero; portraits sit on dark cards.

## 1. Identity (headers, sidebar, tabs, sharing)

| File | Exact size (px) | Ratio | Format | Rules |
|---|---|---|---|---|
| `logo.svg` | 512 × 512 | 1:1 | SVG (vector) | Primary mark. Works on dark + light, or supply variants. No photographic detail (must stay crisp at 28–32px). |
| `favicon.svg` | 64 × 64 | 1:1 | SVG | Simplified mark: legible at 16px tab size. May be a monogram subset of the logo. |
| `og-default.svg` | 1200 × 630 | 1.91:1 | SVG or PNG ≤ 300KB | Default social preview (WhatsApp/X/Discord). Safe area: keep text inside central 1000×500. Replaced per-article by news covers where set. |

## 2. Home hero

| File | Exact size (px) | Ratio | Format | Rules |
|---|---|---|---|---|
| `hero.svg` | 1920 × 1080 | 16:9 | AVIF/WebP (fallback JPG) ≤ 400KB | One authorized Raptor photo: team lineup, match stage, or trophy moment. Landscape, subject clear of the left third (headline sits left). LCP image: ships with `priority`, never lazy. Needs: photographer credit + written approval recorded in `ASSET-MANIFEST.md`. |

## 3. Divisions, teams, players

| File | Exact size (px) | Ratio | Format | Rules |
|---|---|---|---|---|
| `division.svg` | 800 × 600 | 4:3 | AVIF/WebP ≤ 200KB | One per game title (BGMI first): key art, arena shot, or authorized game art. Landscape crop safe. |
| `team-mark.svg` | 256 × 256 | 1:1 | SVG or transparent PNG | Per-team badge. Transparent background (sits on dark cards). |
| `player-portrait.svg` | 600 × 600 | 1:1 | AVIF/WebP ≤ 150KB | Per player: head-and-shoulders, face centered in middle 60% (uniform grid crop). **Requires the player's consent.** No photos scraped from other orgs, streams, or socials. |

## 4. News & media

| File | Exact size (px) | Ratio | Format | Rules |
|---|---|---|---|---|
| `news-featured.svg` | 1200 × 630 | 1.91:1 | AVIF/WebP ≤ 300KB | Lead-story visual. Same safe-area rule as OG (doubles as social image when set). |
| `news-thumb.svg` | 800 × 450 | 16:9 | AVIF/WebP ≤ 150KB | List thumbnails (lazy-loaded). Readable at 320px wide. |

## 5. Partners (approval-gated)

| File | Exact size (px) | Ratio | Format | Rules |
|---|---|---|---|---|
| `partner-logo.svg` | 400 × 200 | 2:1 | SVG or transparent PNG | Per sponsor: official lockup on transparent. **Written approval required before publishing — no exceptions.** Grayscale/monochrome versions preferred for strip uniformity. |

## 6. How to deliver a batch
1. One file per row above, exact filename, exact pixel size (SVGs: exact `width`/`height` + `viewBox`).
2. State for each file: **source** (who shot/designed it), **approval** (who signed off), **players depicted** (consent on file Y/N).
3. Text inside images stays minimal (headlines live in HTML for accessibility/SEO, never baked into art).
4. Alt text is written at implementation from the manifest — you don't need to author it, but flag any image whose meaning isn't obvious from context.

## 7. What is NOT needed from you
- Icons, buttons, backgrounds, textures: the design system draws these in code.
- Fonts: headlines use Oswald (bundled at build), body uses system sans.
- Favicon ICO / apple-touch variants: generated from `favicon.svg` at build time if ever required.
- Copy: headlines, bios, and articles are written from verified facts at implementation — send facts, not Lorem Ipsum.
