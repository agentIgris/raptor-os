/**
 * Money display formatting.
 *
 * The whole file is about one property: no `Number` ever touches a monetary
 * value. `packages/core/money` holds money as `bigint` minor units because a
 * float cannot represent 0.1, and a prize pool that loses a cent is a prize
 * pool nobody trusts. The obvious way to render an amount — `toFixed(2)` — is
 * a `number` method, and reaching for it here would throw the whole guarantee
 * away at the last step, where nothing would catch it.
 *
 * `apps/web/src/server/format.ts` is therefore written without `parseFloat`,
 * `parseInt`, `Number(...)` or arithmetic on the decimal string, and this test
 * asserts the outputs that would be wrong if any of them appeared.
 */

import { money } from "@raptor/core/money";
import { describe, expect, it } from "vitest";

import { formatMoney } from "../server/format";

describe("formatMoney", () => {
  it("renders a whole amount with two decimals", () => {
    expect(formatMoney(money("48000", "EUR"))).toBe("€48,000.00");
  });

  it("renders the symbol for the currencies it knows and the ISO code for the ones it does not", () => {
    expect(formatMoney(money("1200", "USD"))).toBe("$1,200.00");
    expect(formatMoney(money("1200", "ZAR"))).toBe("1,200.00 ZAR");
  });

  it("keeps the sign outside the currency symbol", () => {
    expect(formatMoney(money("-250.5", "USD"))).toBe("-$250.50");
  });

  it("pads a single decimal place", () => {
    expect(formatMoney(money("10.5", "GBP"))).toBe("£10.50");
  });

  it("truncates the stored fourth decimal for display rather than rounding it into the total", () => {
    // 4 decimals are stored so arithmetic is exact. Nobody should be shown
    // four of them, but the amount that was reconciled is the four-decimal
    // one, so display truncates and never re-derives.
    expect(formatMoney(money("100.1299", "USD"))).toBe("$100.12");
  });

  it("renders a very large amount without going through a double", () => {
    // numeric(18,4) tops out at 99999999999999.9999. Through a double this
    // would arrive as 100000000000000 and quietly lose the top digit.
    expect(formatMoney(money("99999999999999.9999", "USD"))).toBe("$99,999,999,999,999.99");
  });

  it("handles zero", () => {
    expect(formatMoney(money("0", "EUR"))).toBe("€0.00");
  });
});