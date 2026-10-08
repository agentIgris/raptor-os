import { describe, expect, it } from "vitest";

import { allocateByLargestRemainder, allocateByShareNumerators, money, parsePercent, sumMoney, zero } from "./index.js";

const INR = "INR";
const USD = "USD";

describe("money arithmetic", () => {
  it("adds amounts", () => {
    expect(money("10.50", INR).add(money("4.25", INR)).toDecimal()).toBe("14.7500");
  });

  it("subtracts amounts", () => {
    expect(money("10.50", INR).subtract(money("0.25", INR)).toDecimal()).toBe("10.2500");
  });

  it("multiplies by a whole number", () => {
    expect(money("250.00", INR).multiply(4n).toDecimal()).toBe("1000.0000");
  });

  it("negates and absolutises", () => {
    expect(money("10.00", INR).negate().toDecimal()).toBe("-10.0000");
    expect(money("-10.00", INR).absolute().toDecimal()).toBe("10.0000");
    expect(money("10.00", INR).absolute().toDecimal()).toBe("10.0000");
  });

  it("compares and detects equality", () => {
    expect(money("1.00", INR).compare(money("2.00", INR))).toBe(-1);
    expect(money("2.00", INR).compare(money("1.00", INR))).toBe(1);
    expect(money("1.00", INR).compare(money("1.00", INR))).toBe(0);
    expect(money("1.00", INR).equals(money("1.00", INR))).toBe(true);
    expect(money("1.00", INR).equals(money("1.00", USD))).toBe(false);
  });

  it("reports sign", () => {
    expect(money("-0.0001", INR).isNegative()).toBe(true);
    expect(money("0.0000", INR).isZero()).toBe(true);
    expect(money("0.0001", INR).isZero()).toBe(false);
  });

  it("accepts bigint input", () => {
    expect(money(42n, INR).toDecimal()).toBe("42.0000");
  });

  it("accepts number input", () => {
    expect(money(1.5, INR).toDecimal()).toBe("1.5000");
  });

  it("rejects non-finite numbers", () => {
    expect(() => money(Number.NaN, INR)).toThrow();
    expect(() => money(Number.POSITIVE_INFINITY, INR)).toThrow();
  });

  it("rejects amounts carrying more than four decimals", () => {
    expect(() => money("1.123456", INR)).toThrow(/precision/i);
  });

  it("rejects malformed amounts and bad currencies", () => {
    expect(() => money("", INR)).toThrow();
    expect(() => money("1.2.3", INR)).toThrow();
    expect(() => money("abc", INR)).toThrow();
    expect(() => money("1.00", "inr")).toThrow(/currency/i);
    expect(() => money("1.00", "IN")).toThrow(/currency/i);
  });

  it("rejects currency mixing on every operation", () => {
    expect(() => money("1.00", INR).add(money("1.00", USD))).toThrow(/currency/i);
    expect(() => money("1.00", INR).subtract(money("1.00", USD))).toThrow(/currency/i);
    expect(() => money("1.00", INR).compare(money("1.00", USD))).toThrow(/currency/i);
  });

  it("produces zero in a currency", () => {
    expect(zero(INR).toDecimal()).toBe("0.0000");
    expect(zero(USD).currency).toBe(USD);
  });

  it("sums a list", () => {
    const values = [money("1.10", INR), money("2.20", INR), money("3.30", INR)];
    expect(sumMoney(values, INR).toDecimal()).toBe("6.6000");
    expect(sumMoney([], INR).toDecimal()).toBe("0.0000");
  });

  it("renders a readable string including the currency", () => {
    expect(money("1234.5", INR).toString()).toBe("1234.5000 INR");
  });

  it("is frozen so money cannot be mutated in place", () => {
    expect(Object.isFrozen(money("1.00", INR))).toBe(true);
  });

  it("renders negative amounts correctly", () => {
    expect(money("-1.2345", INR).toDecimal()).toBe("-1.2345");
  });
});

describe("parsePercent", () => {
  it("scales whole percentages by 1e4", () => {
    expect(parsePercent("100", "p")).toBe(1_000_000n);
    expect(parsePercent("30", "p")).toBe(300_000n);
  });

  it("handles decimal percentages", () => {
    expect(parsePercent("33.3333", "p")).toBe(333_333n);
  });

  it("rejects malformed, over-precise and negative percentages", () => {
    expect(() => parsePercent("abc", "p")).toThrow();
    expect(() => parsePercent("1.123456", "p")).toThrow();
    expect(() => parsePercent("-5", "p")).toThrow(/negative/i);
  });
});

describe("allocateByShareNumerators", () => {
  it("splits proportionally and sums exactly", () => {
    const result = allocateByShareNumerators(1000n, [
      { key: "a", numerator: 3n },
      { key: "b", numerator: 1n },
    ]);
    expect(result.get("a")).toBe(750n);
    expect(result.get("b")).toBe(250n);
  });

  it("assignes the residual by largest remainder then stable key order", () => {
    // 10 across 3 equal shares -> floors 3,3,3 residual 1 -> goes to first key.
    const result = allocateByShareNumerators(10n, [
      { key: "c", numerator: 1n },
      { key: "a", numerator: 1n },
      { key: "b", numerator: 1n },
    ]);
    expect(result.get("a")).toBe(4n);
    expect(result.get("b")).toBe(3n);
    expect(result.get("c")).toBe(3n);
  });

  it("rejects an empty share set", () => {
    expect(() => allocateByShareNumerators(100n, [])).toThrow(/empty/i);
  });

  it("rejects a zero total weight", () => {
    expect(() => allocateByShareNumerators(100n, [{ key: "a", numerator: 0n }])).toThrow(/positive/i);
  });

  it("rejects negative weights", () => {
    expect(() => allocateByShareNumerators(100n, [{ key: "a", numerator: -1n }])).toThrow(/negative/i);
  });

  it("allocates nothing when the pool is zero", () => {
    const result = allocateByShareNumerators(0n, [
      { key: "a", numerator: 1n },
      { key: "b", numerator: 1n },
    ]);
    expect(result.get("a")).toBe(0n);
    expect(result.get("b")).toBe(0n);
  });

  it("distributes no residual when the division is already exact", () => {
    const result = allocateByShareNumerators(900n, [
      { key: "a", numerator: 1n },
      { key: "b", numerator: 1n },
      { key: "c", numerator: 1n },
    ]);
    expect([...result.values()]).toEqual([300n, 300n, 300n]);
  });

  it("orders residuals by fractional size before falling back to key order", () => {
    // 'z' has the largest fractional remainder, so it wins the single residual unit
    // even though 'a' sorts first.
    const result = allocateByShareNumerators(100n, [
      { key: "a", numerator: 1n },
      { key: "z", numerator: 2n },
    ]);
    expect(result.get("a")).toBe(33n);
    expect(result.get("z")).toBe(67n);
  });

  it("never loses a unit across many randomised splits", () => {
    let seed = 42n;
    const next = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return seed >> 40n;
    };

    for (let trial = 0; trial < 300; trial++) {
      const total = next() % 1_000_000n;
      const count = 1 + Number(next() % 7n);
      const shares = Array.from({ length: count }, (_, i) => ({ key: `k${i}`, numerator: 1n + (next() % 5n) }));

      const result = allocateByShareNumerators(total, shares);
      const sum = [...result.values()].reduce((acc, v) => acc + v, 0n);

      expect(sum, `trial ${trial}`).toBe(total);
      expect([...result.values()].every((v) => v >= 0n)).toBe(true);
    }
  });
});

describe("allocateByLargestRemainder", () => {
  it("splits into equal parts that sum exactly", () => {
    const parts = allocateByLargestRemainder(1000n, 3);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1000n);
  });

  it("rejects a non-positive or fractional count", () => {
    expect(() => allocateByLargestRemainder(100n, 0)).toThrow(/positive integer/i);
    expect(() => allocateByLargestRemainder(100n, -1)).toThrow(/positive integer/i);
    expect(() => allocateByLargestRemainder(100n, 2.5)).toThrow(/positive integer/i);
  });
});