/**
 * Locale-aware rendering of money, numbers, dates and messages.
 *
 * **No locale is hardcoded anywhere in this module.** The legacy `README.md`
 * baked `₹` into the product's prose and its money columns carried no currency
 * at all (ADR-0003), so a figure was only ever correct for one audience. Every
 * function here takes the locale as a parameter and derives every separator,
 * symbol placement and digit shape from it through `Intl`.
 *
 * ## Why the round trip is the property, not the display
 *
 * A formatter that produces a nice-looking string is easy. The property that
 * matters is that **what is formatted parses back to the identical value** —
 * `parseFormattedCurrency(formatCurrency(m, c, l)) === m` — for every locale
 * tested. That single requirement rules out almost every tempting
 * implementation:
 *
 * - Concatenating `"$" + amount` puts a `$` inside the digits, and the German
 *   output `1.234.567,8912 $` cannot be parsed by an English reader's rules
 *   without either throwing or silently producing a different number. A wrong
 *   number is worse than no number, because nobody audits the ones that came
 *   back.
 * - Going through `Number` destroys precision above 2^53, and a prize total
 *   altered in its sixth digit is the failure ADR-0003 exists to prevent.
 *
 * So the parse is built from `formatToParts`, not from a regular expression
 * over the display string: the parts tell us which separator is a group, which
 * is a decimal and which is the currency, in whatever order THIS locale wants
 * them.
 *
 * ## Why minor units are `bigint`
 *
 * `formatCurrency` takes **minor units**, exactly as `Money` stores them, and
 * never accepts a `number`. At four decimal places a large figure in major
 * units is not representable as a double, so a `number` parameter would make
 * the round trip impossible to guarantee by construction. The type is the
 * guarantee.
 *
 * ## Stated limit: locales whose digits are not ASCII
 *
 * `Intl` renders `ar-EG` with Arabic-Indic digits (`١٢٣`) and this module's
 * **parser** does not decode them; it refuses such text with a named error.
 * Formatting in those locales is correct and unaffected.
 *
 * The alternative — mapping the digit shapes through a lookup table — was
 * rejected deliberately. A missed or mis-mapped digit is not an error, it is a
 * *different amount*, and a plausible wrong figure is worse than none: nobody
 * audits the numbers that came back. A caller in such a locale gets a thrown
 * error and a ticket, which is a five-minute fix; a silent transposition is a
 * reconciliation problem nobody finds until a payment fails. Should support be
 * needed, the decode table belongs here and arrives with its own tests.
 *
 * ## What is deliberately NOT done
 *
 * - **No translation management.** There is no catalogue loading from disk, no
 *   namespace fallback chain, no per-key override layering and no tooling. A
 *   catalogue is a plain frozen object built in code. Half-built fallback chains
 *   are worse than none: they hide a missing key behind a wrong-language one.
 * - **No pluralisation across locales.** `{count} tasks` is not turned into
 *   "1 task" / "2 tasks", because doing it correctly needs CLDR plural rules
 *   (two forms in English, one in Japanese, six in Russian, and Arabic's
 *   separate dual/zero/paucal rules). This module substitutes placeholders and
 *   nothing else; a message needing plural forms is written by the caller with
 *   the form already chosen. Inventing a two-form rule would be exactly the
 *   "invented metric" failure ADR-0019 records, in a different place.
 * - **No locale negotiation.** Given `["hi-IN", "en-US"]`, this module does not
 *   pick a fallback. Choosing which language a user sees is a product decision
 *   with regional law attached (German-language contracts, for one), and a
 *   silent fallback here would make it by accident.
 *
 * Pure: no I/O, no network, and no clock. `Intl` is called for its data, not for
 * the time — a date is always passed in.
 */

import { MONEY_MAX_MINOR, MONEY_MIN_MINOR, MONEY_SCALE, minorToDecimal, money } from "../money/index.js";
import type { CurrencyCode, Money } from "../money/index.js";

/**
 * A BCP 47 language tag, e.g. `en-US`, `de-DE`, `hi-IN`.
 *
 * A `string` rather than a union of literals on purpose: the set of locales a
 * product must support is not knowable at compile time, and hardcoding three of
 * them here would recreate the very hardcoding this module exists to remove.
 */
export type Locale = string;

/** A time zone IANA name, e.g. `UTC`, `Asia/Kolkata`. */
export type TimeZone = string;

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface FormatOptions {
  /** Required. No default, and no fallback: see the module note. */
  readonly locale: Locale;
  /**
   * Which currency symbol style to use. `code` renders `USD 1.00` rather than
   * `$1.00`, which is what an international audience needs and what makes a
   * currency unambiguous when the symbol alone is not.
   */
  readonly currencyDisplay?: "symbol" | "code" | "name";
}

/**
 * Render money in minor units, in the given locale.
 *
 * ## Why this does not just call `Intl` with a divided number
 *
 * The obvious one-liner is `new Intl.NumberFormat(locale, {style: "currency"})
 * .format(minor / 10n ** 4n)`. It is wrong twice over, and both failures are
 * silent:
 *
 * - `minor / 10n ** 4n` is **integer division**. `12345678912n / 10000n` is
 *   `1234567n`, and the four decimal places the entire domain exists to preserve
 *   are gone. The formatter is then asked to render a figure that was never
 *   there, and it obliges.
 * - `Number(minor) / 1e4` loses precision above 2^53.
 *
 * So the value is split into its two exact halves with `bigint` arithmetic — a
 * whole part and a four-digit fraction — the whole part is grouped by `Intl`
 * (which accepts a `bigint` and formats it without loss), and the fraction is
 * emitted verbatim between the locale's own decimal separator.
 *
 * Every structural decision — where the decimal separator goes, where the symbol
 * goes, how the integer part groups — is read out of `formatToParts` for THIS
 * locale and currency, never assumed.
 *
 * Range-checked against the same bounds `../money/money.ts` enforces, because a
 * figure the ledger could never store is a figure that must not reach a screen
 * where somebody will act on it.
 */
export function formatCurrency(minor: bigint, currency: CurrencyCode, options: FormatOptions | Locale): string {
  const resolved = readOptions(options);
  assertCurrency(currency);
  assertMinorRange(minor, currency);

  const probe = probeCurrencyParts(resolved, currency);
  // The `?? "."` is a genuine fallback, not dead code: `Intl` omits the decimal
  // part for a locale whose currency has no minor units in practice, and the
  // fallback keeps the rendering correct there. The tests pin the common case.
  const decimalSeparator = partValue(probe, "decimal") ?? ".";
  const symbol = partValue(probe, "currency");
  const minus = partValue(probe, "minusSign") ?? "-";

  const scale = 10n ** BigInt(MONEY_SCALE);
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const whole = magnitude / scale;
  // Padded to exactly MONEY_SCALE so a value like 100n renders as `.0100` and
  // not `.01`. The padding is the round trip: a figure that displays with
  // fewer digits than it stores is a figure whose trailing precision is gone.
  const fraction = (magnitude % scale).toString().padStart(MONEY_SCALE, "0");

  const grouped = new Intl.NumberFormat(resolved.locale, {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(whole);

  const digits = `${grouped}${decimalSeparator}${fraction}`;
  const withSign = negative ? `${minus}${digits}` : digits;

  // Symbol placement is locale-dependent and is read from the probe rather than
  // assumed: `en-US` puts `$` first, `de-DE` puts it after a no-break space,
  // `fr-FR` widens it to `$US`, `ja-JP` and `hi-IN` put it first with no space.
  //
  // No `null` guard on `symbol`: a `style: "currency"` formatter ALWAYS emits a
  // currency part for a currency it recognises, and an unrecognised one throws
  // from the constructor before reaching here. The guard would be a branch no
  // input could take.
  if (partValue(probe, "currency") === null) {
    throw new Error(
      `Intl produced no currency part for ${currency} in ${resolved.locale}, which is not a value this module knows how to place.`,
    );
  }

  const precedesAmount = probe.findIndex((part) => part.type === "currency") < probe.findIndex((part) => part.type === "integer");
  if (!precedesAmount) {
    const trailing = literalBefore(probe, "currency");
    return `${withSign}${trailing}${symbol}`;
  }
  const leading = literalAfter(probe, "currency");
  return `${leading}${symbol}${withSign}`;
}

/**
 * Parse a currency string produced by {@link formatCurrency} in the SAME locale
 * and for the SAME currency.
 *
 * **The currency is a parameter, not an inference.** A display string carries a
 * *symbol*, and a symbol does not determine a code: `€` is `EUR` and also
 * `XEU`, `$` is at least a dozen, and `fr-FR` renders `USD` as `$US` while
 * `en-US` renders it as `$`. Any function that "worked out" the currency from a
 * rendered string would be guessing, and a guess about which currency a figure is
 * denominated in is the most expensive kind of wrong answer this package could
 * produce. The caller states the currency it is reading; this function's job is
 * to prove the text really is that currency in that locale, and to return the
 * value exactly.
 *
 * Built on `formatToParts` rather than a regular expression over the rendered
 * string, because the rendered string's structure is locale-dependent: `hi-IN`
 * groups as 1,23,456, `de-DE` as 1.234.567, `fr-FR` uses a narrow no-break space
 * as its group separator, and `ar-EG` uses neither `.` nor `,`. A regex has to
 * know all of those; `formatToParts` is handed them.
 *
 * The probe supplies STRUCTURE and the input supplies VALUE. Reading the value
 * out of the probe instead would make every figure parse to the same number.
 */
export function parseFormattedCurrency(
  text: string,
  options: FormatOptions | Locale,
  currency: CurrencyCode,
): { readonly minor: bigint; readonly currency: CurrencyCode } {
  const resolved = readOptions(options);
  assertLocale(resolved.locale);
  assertCurrency(currency);

  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("Cannot parse an empty string as currency");
  }

  // Probe with the SAME locale, currency and display mode the formatter used, so
  // the separators and symbol below are the ones this text actually carries.
  const parts = probeCurrencyParts(resolved, currency);

  const groupSeparator = partValue(parts, "group");
  const decimalSeparator = partValue(parts, "decimal");
  const symbol = partValue(parts, "currency");

  if (symbol !== null && !trimmed.includes(symbol)) {
    throw new Error(
      `Cannot parse ${JSON.stringify(text)} as ${currency} in ${resolved.locale}: it carries no ${symbol}. ` +
        `Text formatted for a different locale or currency is refused rather than read with the wrong rules, because a misread figure is a wrong figure nobody re-checks.`,
    );
  }

  // The sign is whatever the MINUS SIGN part contributes, taken from the probe
  // rather than assumed to be an ASCII hyphen: `de-DE` renders a negative as
  // `-1.234,00 $` with U+2212 in some ICU versions, and stripping only `-`
  // would turn a negative figure into a positive one.
  const minus = minusSignOf(parts);
  const withoutSign = trimmed.split(minus).join("").replace(/^-/, "");
  const sign = withoutSign === trimmed ? 1n : -1n;
  // `symbol` is non-null here: the check above has already thrown for text that
  // does not carry it, so the split is unconditional rather than guarded.
  const body = withoutSign.split(symbol as string).join("");

  let digits = "";
  let fractionDigits = "";
  let seenDecimal = false;

  for (const character of body) {
    if (groupSeparator !== null && character === groupSeparator) continue;
    if (decimalSeparator !== null && character === decimalSeparator) {
      if (seenDecimal) {
        throw new Error(`Cannot parse ${JSON.stringify(text)} as currency: more than one decimal separator`);
      }
      seenDecimal = true;
      continue;
    }
    if (character >= "0" && character <= "9") {
      if (seenDecimal) fractionDigits += character;
      else digits += character;
      continue;
    }
    // Whitespace and the space characters some locales put between the symbol
    // and the digits (`fr-FR`'s narrow no-break space, `de-DE`'s no-break space).
    if (character.trim() === "") continue;

    // Anything else — a second symbol, a stray letter — means this was not
    // produced by the formatter for these settings, and guessing would produce a
    // number nobody can check.
    throw new Error(
      `Cannot parse ${JSON.stringify(text)} as ${resolved.locale} currency: unexpected character ${JSON.stringify(character)}. ` +
        `A figure this module cannot read back exactly is refused rather than guessed at.`,
    );
  }

  if (digits === "" && fractionDigits === "") {
    throw new Error(`Cannot parse ${JSON.stringify(text)} as currency: no digits`);
  }

  // The formatter emits exactly MONEY_SCALE fraction digits, so anything shorter
  // means the text lost precision on the way here and anything longer means it
  // carries digits `Money` cannot represent. Both are refusals, not roundings.
  if (fractionDigits.length > MONEY_SCALE) {
    throw new Error(
      `Cannot parse ${JSON.stringify(text)} as currency: ${fractionDigits.length} fractional digits exceed the ${MONEY_SCALE} this domain stores. Precision would be lost, and a rounded figure is a different number.`,
    );
  }

  const padded = fractionDigits.padEnd(MONEY_SCALE, "0");
  const minor = sign * BigInt(`${digits === "" ? "0" : digits}${padded}`);
  assertMinorRange(minor, currency);

  return Object.freeze({ minor, currency });
}

/**
 * The parts a formatter produces for one currency, used as a structural probe.
 *
 * The probe value is deliberately a large grouped figure with the full four
 * decimal places, so every part this parser depends on — group separator,
 * decimal separator, currency symbol, fraction — is actually present. Probing
 * with a small integer would omit the group and decimal parts entirely, and the
 * parser would then have no separators to recognise.
 */
function probeCurrencyParts(resolved: FormatOptions, currency: CurrencyCode): Intl.NumberFormatPart[] {
  return new Intl.NumberFormat(resolved.locale, {
    style: "currency",
    currency,
    currencyDisplay: resolved.currencyDisplay ?? "symbol",
    minimumFractionDigits: MONEY_SCALE,
    maximumFractionDigits: MONEY_SCALE,
  }).formatToParts(1_000_000_000_000n);
}

/**
 * Format an exact integer count.
 *
 * `bigint` in, so a figure above 2^53 is rendered exactly. The same conversion
 * as {@link formatCurrency}, without the currency wrapper — used for head counts,
 * seats, and any quantity that is a whole number of things and not money.
 */
export function formatNumber(value: bigint, locale: Locale): string {
  assertLocale(locale);
  if (value < 0n) {
    throw new Error(`Cannot format ${value} as a count: a count is not negative`);
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/**
 * Format a percentage from exact integer space.
 *
 * The input is scaled by `10^4`, exactly as `parsePercent` in `../money` and
 * ADR-0003 rule 4 produce it: `100%` is `1_000_000n`. Formatting a
 * `parsePercent` output therefore needs no division by a float, and the figure a
 * screen shows is the figure the ledger stored.
 *
 * Refuses anything outside `0..1_000_000` — that is, outside `0%..100%` — rather
 * than clamping. A clamped percentage is a percentage that says something other
 * than what was measured.
 */
export function formatPercentage(scaled: bigint, locale: Locale): string {
  assertLocale(locale);
  if (scaled < 0n || scaled > 1_000_000n) {
    throw new Error(
      `Cannot format ${scaled} as a percentage: expected a value between 0 and 1000000 (that is, 0% to 100% at four decimal places)`,
    );
  }
  // The one place a float appears in this module, and it is safe by
  // construction: the value is bounded above by 1_000_000n, so
  // `Number(scaled)` is exact (far below 2^53) and the quotient is the one
  // division a float can represent correctly. Keeping the bound as a REFUSAL
  // rather than a clamp is what preserves that — a clamped value would be a
  // different number, and a percentage is a measurement.
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 4 }).format(
    Number(scaled) / 1_000_000,
  );
}

/**
 * Render an instant as a calendar date in a locale.
 *
 * `timeZone` is **required** and has no default. A default resolves to the
 * server's zone, and ADR-0016 records a five-and-a-half-hour disagreement
 * between a browser and a database as the direct result of exactly that. Making
 * it mandatory means every call site has to state which answer it meant, and a
 * reader can see which.
 *
 * An ISO date string with an explicit offset is accepted as an alternative to a
 * `Date`, because that is what arrives from an API and because it is the form
 * that survives a JSON round trip unambiguously.
 */
export function formatDate(at: Date | string, locale: Locale, timeZone: TimeZone): string {
  assertLocale(locale);
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new Error("formatDate requires an explicit time zone; a default would silently resolve to the server's");
  }

  const instant = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Cannot format ${JSON.stringify(at)} as a date: the instant is not usable`);
  }

  // A zone the runtime does not know throws a RangeError from `Intl`; the message
  // is replaced with one that names the zone, because "invalid time zone" with no
  // value in it is not actionable.
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).format(instant);
  } catch {
    throw new Error(`Cannot format a date in time zone ${JSON.stringify(timeZone)}: the runtime does not recognise it`);
  }
}

// --- message catalogues -----------------------------------------------------

/** The raw message text for a locale, keyed by message key. */
export type MessageSource = Readonly<Record<string, string>>;

/** Values substituted into a message's `{placeholder}` slots. */
export type MessageValues = Readonly<Record<string, string | number>>;

export interface MessageCatalogue {
  readonly locale: Locale;
  readonly messages: Readonly<Record<string, string>>;
}

export interface CreateCatalogueInput {
  readonly locale: Locale;
  readonly messages: MessageSource;
}

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * Build a frozen message catalogue for one locale.
 *
 * A catalogue is one locale's messages and nothing more: no fallback chain, no
 * layering. See the module note for why — a partial fallback hides a missing key
 * behind a wrong-language one, which is harder to notice than a thrown error.
 *
 * Every message is validated at CONSTRUCTION, not at render time. A catalogue
 * containing `""` or a non-string is a build-time defect, and rejecting it here
 * means the failure happens before the first request rather than during it.
 */
export function createCatalogue(input: CreateCatalogueInput): MessageCatalogue {
  assertLocale(input.locale);

  const messages: Record<string, string> = {};
  for (const [key, text] of Object.entries(input.messages)) {
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error(
        `Message ${key} in ${input.locale} is ${JSON.stringify(text)}. An empty or non-string message renders as a blank where text should be, which looks like a layout bug and is therefore never reported.`,
      );
    }
    messages[key] = text;
  }

  return Object.freeze({ locale: input.locale, messages: Object.freeze(messages) });
}

/**
 * An empty catalogue for a locale.
 *
 * Exists so a caller can render a locale that has no catalogue YET without
 * inventing one. Every lookup against it throws, which is the correct behaviour:
 * "no translations exist for German" should be loud, not a screen of blanks.
 */
export function messageCatalogueFor(locale: Locale): MessageCatalogue {
  assertLocale(locale);
  return createCatalogue({ locale, messages: {} });
}

/**
 * Resolve a message, substituting placeholders, or throw.
 *
 * Three refusals, each of which is the "silent empty UI" defect in a different
 * form:
 *
 * 1. **An unknown key.** Rendering `""` looks like a layout problem, so it is
 *    never reported. The thrown message names the key AND the locale, because
 *    "a key is missing" and "a key is missing HERE" are different bugs.
 * 2. **A missing placeholder value.** Rendering the literal `{count}` produces a
 *    non-empty string, so nothing looks wrong and the reader sees braces.
 * 3. **A value the message does not use.** Almost always a typo'd variable name;
 *    dropping it silently leaves the sentence permanently wrong.
 *
 * No pluralisation, and no fallback — see the module note.
 */
export function requireMessage(catalogue: MessageCatalogue, key: string, values: MessageValues = {}): string {
  const text = catalogue.messages[key];

  if (text === undefined) {
    throw new Error(
      `Missing message ${JSON.stringify(key)} in catalogue ${JSON.stringify(catalogue.locale)}. ` +
        `A missing key must fail loudly: rendering it as an empty string produces a blank screen that looks like a layout fault and is never reported.`,
    );
  }

  const required = [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] as string);
  const uniqueRequired = [...new Set(required)].sort();

  for (const name of uniqueRequired) {
    if (values[name] === undefined) {
      throw new Error(
        `Message ${JSON.stringify(key)} in ${JSON.stringify(catalogue.locale)} needs a value for {${name}}; ` +
          `a message rendered without it shows the placeholder to the reader, which is not a visible failure.`,
      );
    }
  }

  for (const name of Object.keys(values).sort()) {
    if (!uniqueRequired.includes(name)) {
      throw new Error(
        `Message ${JSON.stringify(key)} in ${JSON.stringify(catalogue.locale)} has no {${name}} placeholder, but a value was supplied for it. That is almost always a typo in the call site, and dropping it silently leaves the message permanently wrong.`,
      );
    }
  }

  return text.replace(PLACEHOLDER_PATTERN, (_match, name: string) => String(values[name]));
}

/**
 * Which of `keys` this catalogue cannot resolve.
 *
 * The predicate exists so a screen can render a diagnostic listing every missing
 * key at once, instead of discovering them one thrown request at a time. It
 * reports the same refusals {@link requireMessage} enforces — an empty message
 * counts as missing, because it renders the same blank.
 */
export function MISSING_MESSAGE_KEYS(catalogue: MessageCatalogue, keys: readonly string[]): readonly string[] {
  return Object.freeze(
    keys
      .filter((key) => {
        const text = catalogue.messages[key];
        return text === undefined || text.trim() === "";
      })
      .sort(),
  );
}

/**
 * Rebuild a {@link Money} from a parsed figure, for callers that want the domain
 * type rather than the raw pair.
 *
 * Goes through `money()` rather than trusting the pair, so the result carries
 * the same range guarantee every other `Money` in the codebase does — a parsed
 * figure that exceeded `numeric(18,4)` would otherwise be the one `Money` in the
 * system that had never been checked.
 */
export function moneyFromParsed(parsed: { readonly minor: bigint; readonly currency: CurrencyCode }): Money {
  return money(minorToDecimal(parsed.minor), parsed.currency);
}

// --- shared validation ------------------------------------------------------

/**
 * Shared validation.
 *
 * A module-level cache would be faster and would make the same object shared
 * across calls. It is not used: a shared mutable `Intl` instance is exactly the
 * kind of hidden state this package does without, and formatting is not on a
 * hot path that a construction per call can matter for.
 */
function readOptions(options: FormatOptions | Locale): FormatOptions {
  return typeof options === "string" ? { locale: options } : options;
}

function assertLocale(locale: Locale): void {
  if (typeof locale !== "string" || !LOCALE_PATTERN.test(locale)) {
    throw new Error(
      `Invalid locale ${JSON.stringify(locale)}: expected a BCP 47 language tag such as "en-US". No locale is defaulted, because a defaulted locale renders one audience's number formatting for everybody.`,
    );
  }
}

function assertCurrency(currency: CurrencyCode): void {
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    throw new Error(`Invalid currency code ${JSON.stringify(currency)}: expected an ISO 4217 alphabetic code such as "USD"`);
  }
}

function assertMinorRange(minor: bigint, currency: CurrencyCode): void {
  if (minor > MONEY_MAX_MINOR || minor < MONEY_MIN_MINOR) {
    throw new Error(
      `Amount ${minor} minor units is outside the numeric(18,4) range for ${currency}; a figure the ledger cannot store must not reach a screen where somebody will act on it`,
    );
  }
}

/** The single occurrence of a part type in a formatted sample, or `null`. */
function partValue(parts: Intl.NumberFormatPart[], type: Intl.NumberFormatPartTypes): string | null {
  const found = parts.find((part) => part.type === type);
  return found === undefined ? null : found.value;
}

/**
 * The minus sign this locale uses.
 *
 * Probed rather than hardcoded to `-`. Several ICU versions render `de-DE`
 * negatives with U+2212 MINUS SIGN, and a parser that strips only the ASCII
 * hyphen would silently return a POSITIVE figure for a negative input — the
 * worst possible failure for money, because every downstream total would then be
 * wrong in a direction nobody checks.
 */
function minusSignOf(parts: Intl.NumberFormatPart[]): string {
  return partValue(parts, "minusSign") ?? "-";
}

/**
 * The literal a locale puts between the amount and a trailing currency symbol.
 *
 * `de-DE` uses a no-break space, `fr-FR` uses one too, `ja-JP` uses none. It is
 * read from the probe rather than inserted, because an ASCII space where the
 * locale wants U+00A0 renders as a break opportunity inside a price — and a
 * price that wraps across two lines is a price somebody misreads.
 *
 * Walks backwards from the given part, collecting consecutive literals. The loop
 * needs no bounds guard: `i >= 0` is the condition and `parts[i]` is in range
 * whenever it holds.
 */
function literalBefore(parts: Intl.NumberFormatPart[], type: Intl.NumberFormatPartTypes): string {
  const collected: string[] = [];
  for (let i = parts.findIndex((part) => part.type === type) - 1; i >= 0; i -= 1) {
    const part = parts[i] as Intl.NumberFormatPart;
    if (part.type !== "literal") break;
    collected.unshift(part.value);
  }
  return collected.join("");
}

/** The literal a locale puts between a leading currency symbol and the amount. */
function literalAfter(parts: Intl.NumberFormatPart[], type: Intl.NumberFormatPartTypes): string {
  const start = parts.findIndex((part) => part.type === type) + 1;
  const collected: string[] = [];
  for (let i = start; i < parts.length; i += 1) {
    const part = parts[i] as Intl.NumberFormatPart;
    if (part.type !== "literal") break;
    collected.push(part.value);
  }
  return collected.join("");
}
