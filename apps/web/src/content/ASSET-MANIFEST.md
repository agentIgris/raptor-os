# Asset Manifest — Raptor Esports Frontend

Every file below is a **labeled placeholder** (dark frame + `PLACEHOLDER` text).
Nothing here is a real brand mark, photo, or result. A section stays on its
designed empty state until its row flips to `approved` with a verified source.
Never hotlink third-party URLs; approved files are committed here (or the
project CDN pipeline) with credit/license noted.

Base path: `apps/web/public/placeholders/`

| File | Exact size (px) | Ratio | Used in | Alt text | Status | Approved source |
|---|---|---|---|---|---|---|
| `logo.svg` | 512 × 512 | 1:1 | Site header, footer, app sidebar tenant mark | Raptor Esports logo | **approved** (operator-supplied 2026-10-15) | operator media kit |
| `favicon.svg` | 64 × 64 | 1:1 | Browser tab icon (wire via metadata icons) | Raptor Esports favicon | **approved** (operator-supplied 2026-10-15) | operator media kit |
| `hero.svg` → **`hero.png`** | 1920 × 1080 | 16:9 | Public home hero (LCP image, `priority`, never lazy) | Raptor team or match photo | **approved** (operator-supplied 2026-10-15) | operator media kit |
| `division.svg` + **`division-bgmi.png`** | 800 × 600 | 4:3 | Game-division tiles (BGMI first) | Division artwork for {game} | **approved BGMI** (2026-10-15); other titles placeholder | operator media kit |
| `team-mark.svg` | 256 × 256 | 1:1 | Team badges in roster/results | {team} mark | **approved** (operator-supplied 2026-10-15) | operator media kit |
| `player-portrait.svg` + **`player-REx{ANNA,FURRYJOD,IGRIS,SANKU,ZEROIGL}.png`** | 600 × 600 | 1:1 | Roster grid portraits | Portrait of {ign} | **approved portraits** (2026-10-15); other handles fall back to placeholder until their files land | operator media kit |
| `news-featured.svg` → **`news-featured.png`** | 1200 × 630 | 1.91:1 | Lead news story | {headline} lead visual | **approved** house art (2026-10-15) | operator media kit |
| `news-thumb.svg` → **`news-thumb.png`** | 800 × 450 | 16:9 | News list thumbnails (lazy) | {headline} thumbnail | **approved** house art (2026-10-15) | operator media kit |
| `partner-logo.svg` | 400 × 200 | 2:1 | Partners strip — approved sponsor marks ONLY | {partner} logo | placeholder (`partner-logo-template.svg` is a blank template, never a sponsor) | — |
| `og-default.svg` | 1200 × 630 | 1.91:1 | Default social preview (OG/Twitter) | Raptor Esports | **approved** (operator-supplied 2026-10-15) | operator media kit |

## Replacement rules
1. One approved file per row, same filename (or update all references + this table).
2. Keep the exact pixel size and ratio unless the layout task changes it deliberately.
3. Record source + credit/license in `Approved source` before marking approved.
4. Photographic replacements: AVIF/WebP via the Next image pipeline, responsive sizes, explicit dimensions (no layout shift).
5. Partner logos require written approval; otherwise the strip stays hidden.
6. The hero replacement must be an authorized Raptor photo; it keeps `priority` loading.
