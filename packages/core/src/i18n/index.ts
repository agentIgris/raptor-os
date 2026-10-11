/**
 * i18n: locale-aware rendering, and message lookup that fails loudly.
 *
 * Two properties, both of which exist because the alternative is a defect the
 * reader cannot see:
 *
 * 1. **No locale is hardcoded.** Every function takes one. The legacy product
 *    baked `₹` into its prose and its money columns carried no currency at all
 *    (ADR-0003), so a figure was only ever right for one audience. Separators,
 *    symbol placement and digit shapes all come from `Intl`.
 * 2. **A missing message throws.** Rendering an unresolvable key as `""` looks
 *    like a layout fault, so it is never reported. `requireMessage` names the
 *    key and the locale instead.
 *
 * The round trip is the property that makes currency formatting trustworthy:
 * `parseFormattedCurrency(formatCurrency(m, c, l), l, c).minor === m`, tested in
 * `en-US`, `de-DE` and `hi-IN`. Formatting is easy; being able to read a figure
 * back exactly is what stops it being a decoration.
 *
 * **What is deliberately not here** — translation management, CLDR plural
 * forms, and locale negotiation. The reasons are given in `./format.ts`, and the
 * short version is that a half-built fallback chain hides a missing key behind a
 * wrong-language one, and a two-form plural rule is an invented rule.
 *
 * Pure: no I/O, no network, no clock. `Intl` is called for its data, not for the
 * time.
 */

export {
  MISSING_MESSAGE_KEYS,
  createCatalogue,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercentage,
  messageCatalogueFor,
  moneyFromParsed,
  parseFormattedCurrency,
  requireMessage,
} from "./format.js";
export type {
  CreateCatalogueInput,
  FormatOptions,
  Locale,
  MessageCatalogue,
  MessageSource,
  MessageValues,
  TimeZone,
} from "./format.js";
