# Asset Manifest — Raptor Esports Frontend

Every file below is a **labeled placeholder** (dark frame + `PLACEHOLDER` text).
Nothing here is a real brand mark, photo, or result. A section stays on its
designed empty state until its row flips to `approved` with a verified source.
Never hotlink third-party URLs; approved files are committed here (or the
project CDN pipeline) with credit/license noted.

Base path: `apps/web/public/placeholders/`

| File | Exact size (px) | Ratio | Used in | Alt text | Status | Approved source |
|---|---|---|---|---|---|---|
| `logo.svg` | 512 × 512 | 1:1 | Site header, footer, app sidebar tenant mark | Raptor Esports logo | placeholder | — |
| `favicon.svg` | 64 × 64 | 1:1 | Browser tab icon (wire via metadata icons) | Raptor Esports favicon | placeholder | — |
| `hero.svg` | 1920 × 1080 | 16:9 | Public home hero (LCP image, `priority`, never lazy) | Raptor team or match photo | placeholder | — |
| `division.svg` | 800 × 600 | 4:3 | Game-division tiles (BGMI first) | Division artwork for {game} | placeholder | — |
| `team-mark.svg` | 256 × 256 | 1:1 | Team badges in roster/results | {team} mark | placeholder | — |
| `player-portrait.svg` | 600 × 600 | 1:1 | Roster grid portraits | Portrait of {ign} | placeholder | — |
| `news-featured.svg` | 1200 × 630 | 1.91:1 | Lead news story | {headline} lead visual | placeholder | — |
| `news-thumb.svg` | 800 × 450 | 16:9 | News list thumbnails (lazy) | {headline} thumbnail | placeholder | — |
| `partner-logo.svg` | 400 × 200 | 2:1 | Partners strip — approved sponsor marks ONLY | {partner} logo | placeholder | — |
| `og-default.svg` | 1200 × 630 | 1.91:1 | Default social preview (OG/Twitter) | Raptor Esports | placeholder | — |

## Replacement rules
1. One approved file per row, same filename (or update all references + this table).
2. Keep the exact pixel size and ratio unless the layout task changes it deliberately.
3. Record source + credit/license in `Approved source` before marking approved.
4. Photographic replacements: AVIF/WebP via the Next image pipeline, responsive sizes, explicit dimensions (no layout shift).
5. Partner logos require written approval; otherwise the strip stays hidden.
6. The hero replacement must be an authorized Raptor photo; it keeps `priority` loading.
