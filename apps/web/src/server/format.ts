import type { Money } from "@raptor/core/money";

/**
 * Display formatting for money.
 *
 * The rule from the domain layer is absolute: money never touches a float
 * (`packages/core/money/money.ts` — `numeric(18,4)` in `bigint` minor units).
 * That rule is easy to break at the very last step, because the obvious way to
 * render an amount is `amount.toFixed(2)` and `toFixed` is a `number` method.
 * So there is no `Number` anywhere in this file.
 *
 * The integer part is grouped with `Intl.NumberFormat` fed a **`bigint`**,
 * which `Intl` accepts exactly. The fractional part is sliced out as a string.
 * Nothing is parsed into a double at any point, so a pool of
 * `99999999999999.9999` renders the same here as it does in the ledger.
 */

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  JPY: "¥",
};

const groupFormatter = new Intl.NumberFormat("en-GB", { useGrouping: true, maximumFractionDigits: 0 });

/**
 * Render a {@link Money} for display: grouped integer part, two decimals,
 * ISO 4217 code retained.
 *
 * Two decimals, not the stored four. The stored four exist so arithmetic never
 * loses precision; nobody should be shown "1234.5600" on an invoice. Rounding
 * for DISPLAY only, by truncation of the string — never by re-deriving the
 * amount from a rounded value, because the full amount is what was
 * reconciled and the displayed one is what would be disputed.
 */
export function formatMoney(value: Money): string {
  const [whole = "0", fraction = ""] = value.toDecimal().split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = groupFormatter.format(BigInt(digits === "" ? "0" : digits));
  const minor = fraction.slice(0, 2).padEnd(2, "0");
  const symbol = CURRENCY_SYMBOL[value.currency];

  return `${negative ? "-" : ""}${symbol ?? ""}${grouped}.${minor}${symbol === undefined ? ` ${value.currency}` : ""}`;
}