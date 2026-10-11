import { describe, expect, it, vi as vitest } from "vitest";

import {
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercentage,
  MISSING_MESSAGE_KEYS,
  createCatalogue,
  messageCatalogueFor,
  moneyFromParsed,
  parseFormattedCurrency,
  requireMessage,
} from "./index.js";
import type { Locale, MessageCatalogue, MessageValues } from "./index.js";

/**
 * The three locales the design spec's audience actually spans.
 *
 * `en-US`, `de-DE` and `hi-IN` are not arbitrary samples: they differ in
 * group separator (`,` / `.` / `,`), in decimal separator (`.` / `,` / `.`), in
 * symbol placement (prefix / suffix / prefix) and in the lakh/crore grouping
 * `hi-IN` uses. A formatter that hardcodes `en-IN` passes every test written
 * against `en-IN` and produces `1,234.5678` in Germany.
 */
const EN_US: Locale = "en-US";
const DE_DE: Locale = "de-DE";
const HI_IN: Locale = "hi-IN";
const ALL_LOCALES = [EN_US, DE_DE, HI_IN] as const;

/**
 * An amount chosen to break naive implementations.
 *
 * `1234567.8912` has four decimal places (so it exercises `numeric(18,4)`'s
 * full scale), a large integer part (so grouping matters), and digits that
 * differ in every one of the three locales. Its exact value in minor units is
 * 12345678912n — nothing here may lose a digit.
 */
const AMOUNT_MINOR = 12_345_678_912n;

/**
 * One instant used by the date tests: 2026-07-14T21:30:00Z.
 *
 * Deliberately late in the UTC day. 21:30 UTC is 03:00 the NEXT day in Kolkata,
 * so this instant is a different calendar date in two zones — which is the only
 * kind of instant that demonstrates what a defaulted timezone costs. A midday
 * instant renders identically in both zones and would pass a test that proves
 * nothing.
 */
const AT_INstant = new Date("2026-07-14T21:30:00.000Z");

describe("currency formatting across locales", () => {
  it("renders the same money three different ways, which is the point", () => {
    const en = formatCurrency(AMOUNT_MINOR, "USD", EN_US);
    const de = formatCurrency(AMOUNT_MINOR, "USD", DE_DE);
    const hi = formatCurrency(AMOUNT_MINOR, "USD", HI_IN);

    // Three distinct display strings for one value. If any two of these were
    // equal, one of them would be ignoring its locale.
    expect(new Set([en, de, hi]).size).toBe(3);
    expect(en).toContain("$");
    expect(de).toContain("$");
    expect(hi).toContain("$");
  });

  it("ROUND-TRIPS exactly in every locale: what is formatted parses back identically", () => {
    // This is the property that matters, and the reason formatting is not done
    // by string concatenation. `money("1234567.8912")` is exact; `"$" +
    // decimal` in a locale with a comma decimal separator is NOT parseable
    // back, and a figure that cannot be read back cannot be checked.
    for (const locale of ALL_LOCALES) {
      const formatted = formatCurrency(AMOUNT_MINOR, "USD", locale);

      expect(parseFormattedCurrency(formatted, locale, "USD"), `round trip failed for ${locale}`).toEqual({
        minor: AMOUNT_MINOR,
        currency: "USD",
      });
    }
  });

  it("round-trips an amount that is NOT a whole number of major units", () => {
    // A trailing-zero amount is where a formatter quietly drops precision: the
    // value is 100n, which is 0.0100, and a formatter that trims trailing zeros
    // renders `0.01`, which is a DIFFERENT minor-unit figure unless the scale is
    // restored. The round trip is what proves it was not lost.
    for (const locale of ALL_LOCALES) {
      const formatted = formatCurrency(100n, "INR", locale);
      expect(parseFormattedCurrency(formatted, locale, "INR").minor).toBe(100n);
    }
  });

  it("round-trips zero, and negative money", () => {
    for (const locale of ALL_LOCALES) {
      expect(parseFormattedCurrency(formatCurrency(0n, "EUR", locale), locale, "EUR").minor).toBe(0n);
      // Negative amounts are where a sign is most easily lost: a formatter that
      // renders the sign inside the symbol run ("$-1.00") parses back as -100n
      // on one locale and as a POSITIVE on another, and a silently inverted
      // total is worse than a refused one.
      expect(parseFormattedCurrency(formatCurrency(-AMOUNT_MINOR, "EUR", locale), locale, "EUR").minor).toBe(
        -AMOUNT_MINOR,
      );
    }
  });

  it("rejects a currency code that is not ISO 4217 alphabetic", () => {
    // The same rule `../money/money.ts` enforces. Allowing "US$" or "dollars"
    // here would produce a display string no parser could read back.
    for (const bad of ["usd", "US", "USDD", "123", ""]) {
      expect(() => formatCurrency(100n, bad, EN_US)).toThrow(/currenc/i);
      expect(() => parseFormattedCurrency("$1.00", EN_US, bad)).toThrow(/currenc/i);
    }
  });

  it("refuses to parse a currency display that was NOT produced for this locale", () => {
    const de = formatCurrency(AMOUNT_MINOR, "USD", DE_DE);

    // Parsing "1.234.567,8912 $" with the English parser would read `.` as the
    // group separator and `,` as the decimal, and produce a figure that is
    // wrong by three orders of magnitude rather than an error. Refusing is the
    // only safe answer: a wrong number is worse than no number, because nobody
    // checks the ones that came back.
    expect(() => parseFormattedCurrency(de, EN_US, "USD")).toThrow();
  });

  it("refuses to parse a display carrying the wrong currency's symbol", () => {
    const dollars = formatCurrency(AMOUNT_MINOR, "USD", EN_US);

    // `€` does not determine `EUR` uniquely, so the currency is stated by the
    // caller and checked here rather than guessed from the symbol. Reading a USD
    // figure as EUR would be the most expensive wrong answer this package could
    // produce.
    expect(() => parseFormattedCurrency(dollars, EN_US, "EUR")).toThrow(/carries no/i);
  });

  it("refuses to parse text carrying a different CURRENCY's symbol", () => {
    const dollars = formatCurrency(AMOUNT_MINOR, "USD", EN_US);

    // `€` does not determine `EUR` uniquely, so the currency is stated by the
    // caller and checked here rather than guessed from the symbol.
    expect(() => parseFormattedCurrency(dollars, EN_US, "JPY")).toThrow(/carries no/i);
  });

  it("refuses to parse text that is not a currency amount at all", () => {
    expect(() => parseFormattedCurrency("not money", EN_US, "USD")).toThrow();
    expect(() => parseFormattedCurrency("", EN_US, "USD")).toThrow(/empty/i);
  });

  it("refuses to parse a currency symbol with no digits behind it", () => {
    // The bare symbol passes the symbol check and then has nothing to read. It
    // must be an error rather than a silent zero — `$` parsed as `0.0000` is a
    // figure that looks like a real amount.
    expect(() => parseFormattedCurrency("$", EN_US, "USD")).toThrow(/no digits/i);
    expect(() => parseFormattedCurrency("$  ", EN_US, "USD")).toThrow(/no digits/i);
  });

  it("refuses to parse text carrying a second currency symbol", () => {
    // "$US$1.00" contains the symbol this locale uses, so it passes the symbol
    // check — and then the trailing "$" has no meaning. Guessing past it would
    // produce a number from text this module did not produce.
    expect(() => parseFormattedCurrency("$US$1.0000", EN_US, "USD")).toThrow(/unexpected character/i);
  });

  it("refuses a second decimal separator rather than picking one", () => {
    // Two decimal separators means the text was not produced by this formatter,
    // and picking one of them would silently rescale the figure.
    expect(() => parseFormattedCurrency("$1.0000.0000", EN_US, "USD")).toThrow(/decimal separator/i);
  });

  it("refuses a fractional precision this domain cannot store", () => {
    // Five fractional digits cannot round-trip through `numeric(18,4)`.
    // Truncating here would be exactly the silent rounding ADR-0003 forbids.
    expect(() => parseFormattedCurrency("$1.23456", EN_US, "USD")).toThrow(/fractional digits|precision/i);
  });

  it("refuses an unusable locale on every entry point", () => {
    for (const bad of ["", "  ", "e", "not a locale"]) {
      expect(() => formatCurrency(100n, "USD", bad as never)).toThrow(/locale/i);
      expect(() => formatNumber(100n, bad as never)).toThrow(/locale/i);
      expect(() => formatPercentage(100_000n, bad as never)).toThrow(/locale/i);
      expect(() => formatDate(AT_INstant, bad as never, "UTC")).toThrow(/locale/i);
    }
  });

  it("refuses a minor-unit value that cannot be represented", () => {
    // Beyond `numeric(18,4)` a figure cannot be stored, so rendering one would
    // put a number on screen that the ledger could never accept back.
    expect(() => formatCurrency(10n ** 30n, "USD", EN_US)).toThrow(/numeric\(18,4\)|range/i);
  });
});

describe("number formatting", () => {
  it("formats an exact integer across locales and never uses a float", () => {
    // `bigint` in, `string` out. Routing this through `Number` would lose
    // precision above 2^53, and a prize total silently altered in its sixth
    // digit is the failure ADR-0003 is about.
    const big = 9_007_199_254_740_993n;

    expect(formatNumber(big, EN_US)).toBe("9,007,199,254,740,993");
    expect(formatNumber(big, DE_DE)).toBe("9.007.199.254.740.993");
    // `hi-IN` groups in threes then twos, so this figure renders differently from
    // BOTH of the above — which is the concrete reason a hardcoded separator
    // cannot work.
    expect(formatNumber(big, HI_IN)).not.toBe(formatNumber(big, EN_US));
    expect(formatNumber(big, HI_IN)).not.toBe(formatNumber(big, DE_DE));
  });

  it("refuses a negative count, because a count is a count", () => {
    expect(() => formatNumber(-1n, EN_US)).toThrow(/negative/i);
  });
});

describe("percentage formatting", () => {
  it("renders a percentage from exact integer space, not a float", () => {
    // ADR-0003 rule 4: percentages parse into integer space. A win rate computed
    // as a float and then formatted is a rate that cannot be reproduced from
    // its stored inputs, which ADR-0019 forbids.
    expect(formatPercentage(1_000_000n, EN_US)).toBe("100%");
    expect(formatPercentage(875_000n, EN_US)).toBe("87.5%");
  });

  it("renders a non-whole percentage with the locale's own decimal separator", () => {
    expect(formatPercentage(875_000n, DE_DE)).toContain(",5");
    expect(formatPercentage(875_000n, DE_DE)).toContain("%");
  });

  it("refuses a percentage outside 0%..100% rather than clamping it", () => {
    // A clamped percentage is a percentage that says something other than what
    // was measured — the ADR-0019 failure in its simplest form.
    expect(() => formatPercentage(-1n, EN_US)).toThrow(/percent/i);
    expect(() => formatPercentage(1_000_001n, EN_US)).toThrow(/percent/i);
  });
});

describe("date formatting", () => {
  it("renders the same instant differently per locale", () => {
    const en = formatDate(AT_INstant, EN_US, "UTC");
    const de = formatDate(AT_INstant, DE_DE, "UTC");

    expect(en).not.toBe(de);
    expect(en).toContain("2026");
    expect(de).toContain("2026");
  });

  it("accepts an ISO string as well as a Date, because that is what an API sends", () => {
    // An ISO string with an explicit offset survives a JSON round trip
    // unambiguously, and a bare timestamp with no offset does not.
    expect(formatDate("2026-07-14T09:30:00.000Z", EN_US, "UTC")).toBe(formatDate(AT_INstant, EN_US, "UTC"));
  });

  it("refuses to render an unusable instant", () => {
    // Rendering `Invalid Date` into a report is how an unreadable date becomes
    // a plausible-looking row that nobody queries again.
    expect(() => formatDate(new Date(Number.NaN), EN_US, "UTC")).toThrow(/instant/i);
    expect(() => formatDate("not a date", EN_US, "UTC")).toThrow(/instant/i);
  });

  it("takes the timezone as a required parameter, never a default", () => {
    // A default timezone is a silent dependence on the SERVER's zone, and ADR-0016
    // records a five-and-a-half-hour disagreement between browser and database as
    // a direct result of exactly that. The instant below is 09:30 UTC, which is
    // 15:00 in Kolkata — a DIFFERENT DAY'S worth of hours in a different zone,
    // so a silent default would put a booking on the wrong date.
    const inUtc = formatDate(AT_INstant, EN_US, "UTC");
    const inKolkata = formatDate(AT_INstant, EN_US, "Asia/Kolkata");

    // The SAME instant is the 14th in UTC and the 15th in Kolkata. This is the
    // failure ADR-0016 recorded — a five-and-a-half-hour gap with nothing
    // reconciling it — reduced to the one line that decides which day a booking
    // appears on.
    expect(inUtc).toContain("07/14/2026");
    expect(inKolkata).toContain("07/15/2026");
  });

  it("refuses a blank or unrecognised time zone", () => {
    // `Intl` throws a bare "Invalid time zone" with no value in it, which is not
    // actionable; the message here names the zone.
    expect(() => formatDate(AT_INstant, EN_US, "")).toThrow(/time zone/i);
    expect(() => formatDate(AT_INstant, EN_US, "  ")).toThrow(/time zone/i);
    expect(() => formatDate(AT_INstant, EN_US, "Not/AZone")).toThrow(/Not\/AZone/);
  });
});

describe("message catalogues", () => {
  const MESSAGES = {
    "task.blocked": "{actor} blocked {title}",
    "task.count": "{count} tasks",
    "greeting": "Welcome back",
  };

  it("resolves a key and substitutes every placeholder", () => {
    const catalogue = createCatalogue({ locale: EN_US, messages: MESSAGES });
    const values: MessageValues = { actor: "Priya", title: "the visa renewal" };

    expect(requireMessage(catalogue, "task.blocked", values)).toBe("Priya blocked the visa renewal");
  });

  it("FAILS LOUDLY on a missing key rather than rendering an empty string", () => {
    // The defect this exists to prevent: a UI that silently renders blank where
    // a translation should be. A blank looks like a layout problem, so it is
    // never reported; a throw is reported on the first request.
    const catalogue = createCatalogue({ locale: EN_US, messages: MESSAGES });

    expect(() => requireMessage(catalogue, "task.doesNotExist")).toThrow(/task\.doesNotExist/);
    // The message names the locale too, because "it is missing" and "it is
    // missing HERE" are different bugs.
    expect(() => requireMessage(catalogue, "task.doesNotExist")).toThrow(new RegExp(EN_US));
  });

  it("refuses to build a catalogue containing an empty message", () => {
    // An empty translation is the same defect one step removed: the key resolves,
    // so nothing throws at render time, and the screen is blank. Catching it at
    // CONSTRUCTION means the failure happens before the first request rather than
    // during one.
    expect(() => createCatalogue({ locale: EN_US, messages: { empty: "" } })).toThrow(/empty/i);
    expect(() => createCatalogue({ locale: EN_US, messages: { blank: "   " } })).toThrow(/blank|empty/i);
  });

  it("fails loudly on a MISSING placeholder value, rather than rendering `{count}`", () => {
    // Rendering a literal `{count}` on screen is the same class of defect: the
    // string is non-empty, so nothing looks wrong, and the reader sees braces.
    const catalogue = createCatalogue({ locale: EN_US, messages: MESSAGES });

    expect(() => requireMessage(catalogue, "task.count")).toThrow(/count/);
  });

  it("refuses a placeholder the catalogue does not use", () => {
    // A typo'd variable name in a call site would otherwise be silently dropped,
    // leaving the message reading "Priya blocked " forever.
    const catalogue = createCatalogue({ locale: EN_US, messages: MESSAGES });

    expect(() =>
      requireMessage(catalogue, "task.blocked", { actor: "Priya", title: "x", othr: "y" }),
    ).toThrow(/othr/);
  });

  it("round-trips in a locale that puts the symbol FIRST with a spacing literal", () => {
    // `nl-NL` and `pt-BR` both lead with the symbol and follow it with a
    // no-break space — and `nl-NL` widens the symbol to `US$`, which is why the
    // assertion is on POSITION rather than on the literal characters. Reading
    // that literal out of the probe rather than hardcoding an ASCII space is what
    // keeps the symbol from being glued onto the amount, and an ASCII space where
    // a locale wants U+00A0 would put a break opportunity inside a price.
    const rendered = formatCurrency(1_000_000n, "USD", "nl-NL");

    // Not starting with a digit is the meaningful claim: the symbol leads.
    expect(/^\D/.test(rendered)).toBe(true);
    expect(parseFormattedCurrency(rendered, "nl-NL", "USD").minor).toBe(1_000_000n);
  });

  it("reports rather than guesses when the runtime omits the currency part", () => {
    // A `style: "currency"` formatter always emits a currency part, so this guard
    // cannot fire on any runtime this suite runs against. It is tested by
    // simulating a runtime that does not, because an untested error path is one
    // nobody has run — and this particular one exists to stop a currency-less
    // rendering being shown as though it were a figure.
    const spy = vitest.spyOn(Intl.NumberFormat.prototype, "formatToParts").mockReturnValue([
      { type: "integer", value: "1" },
      { type: "decimal", value: "." },
      { type: "fraction", value: "0000" },
    ] as Intl.NumberFormatPart[]);

    try {
      expect(() => formatCurrency(1_000n, "USD", EN_US)).toThrow(/no currency part/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("round-trips in a locale that puts the symbol LAST", () => {
    // The mirror image: `de-DE` and `fr-FR` both suffix the symbol after a
    // no-break space, so the amount is not where the string starts.
    const rendered = formatCurrency(1_000_000n, "USD", "fr-FR");

    expect(rendered.startsWith("$")).toBe(false);
    expect(parseFormattedCurrency(rendered, "fr-FR", "USD").minor).toBe(1_000_000n);
  });

  it("REFUSES a locale whose digits are not ASCII, rather than misreading them", () => {
    // A stated limit, and it is a refusal rather than a silent wrong answer.
    //
    // `ar-EG` renders digits as Arabic-Indic (`١٢٣`), which `Intl` handles but
    // this parser does not decode. The tempting alternative — mapping the
    // non-ASCII digits through a lookup — is exactly the kind of half-measure
    // that produces a plausible wrong number: a missed digit is not an error,
    // it is a smaller amount. Refusing means a caller in that locale gets an
    // error and a ticket rather than a figure nobody can reconcile.
    const rendered = formatCurrency(1_000_000n, "USD", "ar-EG");

    // Formatting works — that is `Intl`'s job and it is correct.
    expect(rendered).not.toBe(formatCurrency(1_000_000n, "USD", EN_US));
    // Parsing refuses, and says why.
    expect(() => parseFormattedCurrency(rendered, "ar-EG", "USD")).toThrow(/unexpected character/i);
  });

  it("parses a small amount whose whole part is a single zero", () => {
    // `0.0100` is the smallest amount this domain can show that is not zero. It
    // exercises the whole-part parsing path with a one-digit integer, which is
    // the case where a group-separator confusion would be invisible.
    expect(parseFormattedCurrency("$0.0100", EN_US, "USD").minor).toBe(100n);
  });

  it("refuses a figure with no currency symbol at all, even when the digits parse", () => {
    // `"0.0100"` is a well-formed number and a completely ambiguous one: it
    // names no currency, so there is nothing to attach it to. Refusing is right
    // — this is the same reason the currency is a parameter and not an
    // inference.
    expect(() => parseFormattedCurrency("0.0100", EN_US, "USD")).toThrow(/carries no/i);
  });

  it("rebuilds a Money from a parsed figure, carrying the currency through", () => {
    // `moneyFromParsed` goes back through `money()` so the result carries the
    // same `numeric(18,4)` range guarantee every other Money in the codebase
    // does — a parsed figure that skipped it would be the one unchecked Money.
    const parsed = parseFormattedCurrency(formatCurrency(123_456_789n, "GBP", EN_US), EN_US, "GBP");
    const rebuilt = moneyFromParsed(parsed);

    expect(rebuilt.currency).toBe("GBP");
    expect(rebuilt.minor).toBe(123_456_789n);
    expect(rebuilt.equals(moneyFromParsed(parsed))).toBe(true);
  });

  it("carries its own locale onto every catalogue it creates", () => {
    // Without this a caller formatting a number could reach for the wrong
    // locale's rules while the text came from the right one.
    expect(messageCatalogueFor(EN_US).locale).toBe(EN_US);
    expect(messageCatalogueFor(DE_DE).locale).toBe(DE_DE);
    // An empty catalogue is still a catalogue for a locale — and every lookup
    // against it throws, which is correct: "no translations exist for German"
    // should be loud, not a screen of blanks.
    expect(() => requireMessage(messageCatalogueFor(HI_IN), "task.blocked")).toThrow(/hi-IN/);
  });

  it("refuses a blank or non-string message", () => {
    expect(() => createCatalogue({ locale: EN_US, messages: { bad: 42 as never } })).toThrow(/bad/);
    expect(() => createCatalogue({ locale: EN_US, messages: { bad: "  " } })).toThrow(/bad/);
  });

  it("refuses a catalogue with a blank locale", () => {
    expect(() => createCatalogue({ locale: "  " as Locale, messages: MESSAGES })).toThrow(/locale/i);
  });

  it("knows a key is missing without being asked to throw", () => {
    // The predicate exists so a screen can render a diagnostic panel listing
    // every missing key, instead of discovering them one 500 at a time.
    const catalogue = createCatalogue({ locale: EN_US, messages: MESSAGES });

    expect(MISSING_MESSAGE_KEYS(catalogue, ["task.blocked", "task.nope"])).toEqual(["task.nope"]);
    expect(MISSING_MESSAGE_KEYS(catalogue, ["task.blocked"])).toEqual([]);
  });

  it("accepts options as an object as well as a bare locale string", () => {
    // The object form carries `currencyDisplay`, which a bare string cannot. Both
    // spell the same locale, and both must format identically.
    const bare = formatCurrency(1_234n, "USD", EN_US);
    const object = formatCurrency(1_234n, "USD", { locale: EN_US });

    expect(object).toBe(bare);
  });

  it("renders the currency code rather than the symbol when asked", () => {
    // `code` is what an international audience needs: a bare `$` is ambiguous
    // across a dozen currencies, and this module refuses to GUESS which one on
    // the way back in — so the display has to be able to be unambiguous.
    const asCode = formatCurrency(1_234n, "USD", { locale: EN_US, currencyDisplay: "code" });

    expect(asCode).toContain("USD");
    expect(parseFormattedCurrency(asCode, { locale: EN_US, currencyDisplay: "code" }, "USD").minor).toBe(1_234n);
  });

  it("freezes the catalogue, so a message cannot be rewritten at runtime", () => {
    const catalogue: MessageCatalogue = createCatalogue({ locale: EN_US, messages: MESSAGES });

    expect(Object.isFrozen(catalogue)).toBe(true);
    expect(Object.isFrozen(catalogue.messages)).toBe(true);
  });
});
