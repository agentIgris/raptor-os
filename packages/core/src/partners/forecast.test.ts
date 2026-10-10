import { describe, expect, it } from "vitest";

import { MONEY_FACTOR, money } from "../money/index.js";
import { computeWeightedForecast, dealWeightedValue, stageDefaultProbability } from "./forecast.js";
import type { PartnerDeal } from "./forecast.js";

/** `30%` as the `bigint` scaled by 1e4 that `parsePercent` produces. */
const THIRTY_PERCENT = 300_000n;

function deal(overrides: Partial<PartnerDeal> & Pick<PartnerDeal, "dealId" | "value">): PartnerDeal {
  return {
    partnerId: "partner_1",
    organizationId: "org_1",
    stage: "negotiation",
    probability: THIRTY_PERCENT,
    ...overrides,
  };
}

describe("stageDefaultProbability", () => {
  it("declares a probability for every stage, so the table cannot grow a hole", () => {
    expect(Object.keys(stageDefaultProbability).sort()).toEqual(
      ["active", "lapsed", "lead", "negotiation", "qualified", "signed"].sort(),
    );
  });

  it("treats a signed and an active deal as certain, and a lapsed one as worthless", () => {
    expect(stageDefaultProbability.signed).toBe(1_000_000n);
    expect(stageDefaultProbability.active).toBe(1_000_000n);
    expect(stageDefaultProbability.lapsed).toBe(0n);
  });

  it("weighs earlier stages below later ones, so a forecast is not flat", () => {
    const ordered = [
      stageDefaultProbability.lead,
      stageDefaultProbability.qualified,
      stageDefaultProbability.negotiation,
      stageDefaultProbability.signed,
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index]).toBeGreaterThan(ordered[index - 1] as bigint);
    }
  });

  it("keeps every value inside the 0..10000 range a scaled percentage can express", () => {
    for (const value of Object.values(stageDefaultProbability)) {
      expect(value).toBeGreaterThanOrEqual(0n);
      expect(value).toBeLessThanOrEqual(1_000_000n);
    }
  });

  it("is frozen, so a caller cannot recalibrate the whole pipeline by assignment", () => {
    expect(Object.isFrozen(stageDefaultProbability)).toBe(true);
  });
});

describe("dealWeightedValue", () => {
  it("multiplies value by probability in exact integer minor units", () => {
    const weighted = dealWeightedValue(deal({ dealId: "d1", value: money("1000", "INR") }));

    // 1000.0000 INR at 30% is exactly 300.0000. The float version of this
    // multiplication returns 299.99999999999994 on some inputs; the `bigint`
    // version returns 3000000n or 300.0001n, never anything in between.
    expect(weighted.toDecimal()).toBe("300.0000");
    expect(weighted.currency).toBe("INR");
  });

  it("returns a zero amount for a zero probability rather than throwing", () => {
    const weighted = dealWeightedValue(deal({ dealId: "d1", value: money("1000", "INR"), probability: 0n }));

    expect(weighted.isZero()).toBe(true);
    expect(weighted.currency).toBe("INR");
  });

  it("refuses a probability above 100 percent", () => {
    expect(() => dealWeightedValue(deal({ dealId: "d1", value: money("1", "INR"), probability: 1_000_001n }))).toThrow(
      /probability/i,
    );
  });

  it("refuses a negative probability", () => {
    expect(() => dealWeightedValue(deal({ dealId: "d1", value: money("1", "INR"), probability: -1n }))).toThrow(
      /probability/i,
    );
  });

  it("refuses a blank deal id and a blank organisation id", () => {
    expect(() => dealWeightedValue(deal({ dealId: " ", value: money("1", "INR") }))).toThrow(/dealId/i);
    expect(() => dealWeightedValue(deal({ dealId: "d1", organizationId: "", value: money("1", "INR") }))).toThrow(
      /organizationId/i,
    );
  });

  it("rejects an unknown stage rather than defaulting its probability", () => {
    expect(() => dealWeightedValue(deal({ dealId: "d1", value: money("1", "INR"), stage: "won" as never }))).toThrow(
      /stage/i,
    );
  });

  it("uses the repository Money type: the result carries bigint minor units", () => {
    const weighted = dealWeightedValue(deal({ dealId: "d1", value: money("1", "INR") }));

    expect(typeof weighted.minor).toBe("bigint");
    expect(typeof weighted.currency).toBe("string");
    expect(MONEY_FACTOR).toBe(10_000n);
  });
});

describe("computeWeightedForecast", () => {
  it("returns zero for an empty pipeline, which is a real state and not an error", () => {
    const forecast = computeWeightedForecast([], money("0", "INR"));

    expect(forecast.currency).toBe("INR");
    expect(forecast.totalPipeline.isZero()).toBe(true);
    expect(forecast.weightedTotal.isZero()).toBe(true);
    expect(forecast.byStage).toEqual([]);
  });

  it("weights every deal by its probability and reports both figures", () => {
    const forecast = computeWeightedForecast(
      [
        deal({ dealId: "d1", value: money("1000", "INR"), probability: 1_000_000n }),
        deal({ dealId: "d2", value: money("2000", "INR"), probability: 500_000n }),
      ],
      money("0", "INR"),
    );

    expect(forecast.totalPipeline.toDecimal()).toBe("3000.0000");
    expect(forecast.weightedTotal.toDecimal()).toBe("2000.0000");
  });

  it("conserves the total exactly across the per-stage breakdown", () => {
    // The property that makes a forecast usable: the breakdown sums to the
    // headline, to the minor unit, with no rounding slack to explain. A report
    // whose parts do not add up is one nobody can act on.
    const forecast = computeWeightedForecast(
      [
        deal({ dealId: "d1", value: money("333.3333", "INR"), stage: "lead" }),
        deal({ dealId: "d2", value: money("777.7777", "INR"), stage: "negotiation" }),
        deal({ dealId: "d3", value: money("0.0001", "INR"), stage: "qualified" }),
      ],
      money("0", "INR"),
    );

    const summed = forecast.byStage.reduce((total, entry) => total.add(entry.weighted), money("0", "INR"));
    expect(summed.minor).toBe(forecast.weightedTotal.minor);
  });

  it("groups the breakdown by stage, in pipeline order", () => {
    const forecast = computeWeightedForecast(
      [
        deal({ dealId: "d1", value: money("1", "INR"), stage: "active", probability: 1_000_000n }),
        deal({ dealId: "d2", value: money("2", "INR"), stage: "lead", probability: 1_000_000n }),
        deal({ dealId: "d3", value: money("3", "INR"), stage: "active", probability: 1_000_000n }),
      ],
      money("0", "INR"),
    );

    expect(forecast.byStage.map((entry) => entry.stage)).toEqual(["lead", "active"]);
    expect(forecast.byStage.find((entry) => entry.stage === "active")?.dealCount).toBe(2);
    expect(forecast.byStage.find((entry) => entry.stage === "active")?.pipeline.toDecimal()).toBe("4.0000");
    expect(forecast.byStage.find((entry) => entry.stage === "active")?.weighted.toDecimal()).toBe("4.0000");
  });

  it("carries a lapsed deal in the breakdown at zero, because it is in the pipeline list", () => {
    // Lapsed deals are excluded from the weighted headline but not hidden: a
    // forecast that silently drops them cannot explain why last quarter's number
    // fell.
    const forecast = computeWeightedForecast(
      [deal({ dealId: "d1", value: money("1000", "INR"), stage: "lapsed", probability: 0n })],
      money("0", "INR"),
    );

    expect(forecast.byStage).toHaveLength(1);
    expect(forecast.byStage[0]?.weighted.isZero()).toBe(true);
    expect(forecast.weightedTotal.isZero()).toBe(true);
  });

  it("refuses a deal in another currency rather than guessing a rate", () => {
    // ADR-0003: currencies are never combined implicitly, and a forecast is the
    // most tempting place to be tempted — "roughly, they're all about the same".
    expect(() =>
      computeWeightedForecast(
        [deal({ dealId: "d1", value: money("100", "INR") }), deal({ dealId: "d2", value: money("100", "USD") })],
        money("0", "INR"),
      ),
    ).toThrow(/USD|currency/i);
  });

  it("refuses a currency argument that disagrees with the deals", () => {
    expect(() => computeWeightedForecast([deal({ dealId: "d1", value: money("100", "USD") })], money("0", "INR"))).toThrow(
      /currency/i,
    );
  });

  it("refuses two deals with the same id, so the breakdown cannot double-count one", () => {
    expect(() =>
      computeWeightedForecast(
        [deal({ dealId: "d1", value: money("100", "INR") }), deal({ dealId: "d1", value: money("100", "INR") })],
        money("0", "INR"),
      ),
    ).toThrow(/duplicate|d1/i);
  });

  it("refuses a blank partner id", () => {
    expect(() => computeWeightedForecast([deal({ dealId: "d1", partnerId: " ", value: money("1", "INR") })], money("0", "INR"))).toThrow(
      /partnerId/i,
    );
  });

  it("refuses a headline currency that is not a currency at all", () => {
    expect(() => computeWeightedForecast([], { currency: "", minor: 0n } as never)).toThrow(/currency/i);
  });

  it("refuses a deal whose value is negative, which would be a credit in a pipeline", () => {
    expect(() =>
      computeWeightedForecast([deal({ dealId: "d1", value: money("-100", "INR") })], money("0", "INR")),
    ).toThrow(/negative/i);
  });

  it("never invents money: the weighted total never exceeds the pipeline it came from", () => {
    const forecast = computeWeightedForecast(
      [
        deal({ dealId: "d1", value: money("123.4567", "INR"), probability: 999_900n }),
        deal({ dealId: "d2", value: money("0.0001", "INR"), probability: 1n }),
      ],
      money("0", "INR"),
    );

    expect(forecast.weightedTotal.minor).toBeLessThanOrEqual(forecast.totalPipeline.minor);
  });

  it("keeps the 4-decimal scale the rest of the system uses", () => {
    const forecast = computeWeightedForecast(
      [deal({ dealId: "d1", value: money("7", "INR"), probability: 500_000n })],
      money("0", "INR"),
    );

    expect(forecast.weightedTotal.toDecimal()).toBe("3.5000");
  });

  it("returns a frozen forecast", () => {
    const forecast = computeWeightedForecast([deal({ dealId: "d1", value: money("1", "INR") })], money("0", "INR"));

    expect(Object.isFrozen(forecast)).toBe(true);
    expect(Object.isFrozen(forecast.byStage)).toBe(true);
    expect(Object.isFrozen(forecast.byStage[0])).toBe(true);
  });

  it("reports zero drift when every deal divides exactly", () => {
    const forecast = computeWeightedForecast(
      [
        deal({ dealId: "d1", value: money("1000", "INR"), probability: 500_000n }),
        deal({ dealId: "d2", value: money("250", "INR"), probability: 1_000_000n }),
      ],
      money("0", "INR"),
    );

    expect(forecast.roundingDrift).toBe(0n);
  });
});

describe("reported rounding drift", () => {
  it("reports the drift when the weighted value does not divide exactly", () => {
    // ADR-0019 §6: truncation is always reported. A forecast that quietly moved
    // its own headline is one nobody can reproduce from the deals behind it.
    const forecast = computeWeightedForecast(
      [deal({ dealId: "d1", value: money("0.0001", "INR"), probability: 500_000n })],
      money("0", "INR"),
    );

    // 0.0001 INR at 50% is 0.00005 INR — exactly half a minor unit, rounding up.
    // Drift is reported in units of 1/1,000,000 of a minor unit, so one whole
    // minor unit reads as 1_000_000n and half of one as 500_000n.
    expect(forecast.weightedTotal.toDecimal()).toBe("0.0001");
    expect(forecast.roundingDrift).toBe(500_000n);
  });

  it("reports a downward drift as well, so the figure is not always positive", () => {
    // 0.0001 INR at 10% is 0.00001 INR, which rounds down to nothing.
    const forecast = computeWeightedForecast(
      [deal({ dealId: "d1", value: money("0.0001", "INR"), probability: 100_000n })],
      money("0", "INR"),
    );

    expect(forecast.weightedTotal.isZero()).toBe(true);
    expect(forecast.roundingDrift).toBe(-100_000n);
  });

  it("accumulates the drift across several deals rather than hiding it in the total", () => {
    const forecast = computeWeightedForecast(
      [
        deal({ dealId: "d1", value: money("0.0001", "INR"), probability: 500_000n }),
        deal({ dealId: "d2", value: money("0.0003", "INR"), probability: 500_000n }),
      ],
      money("0", "INR"),
    );

    // 0.00005 rounds up to 1 unit and 0.00015 rounds up to 2: a whole minor unit
    // of drift, half of it from each deal.
    expect(forecast.weightedTotal.toDecimal()).toBe("0.0003");
    expect(forecast.roundingDrift).toBe(1_000_000n);
  });
});

describe("weighted forecast under fuzz", () => {
  // Deterministic pseudo-randomness: the seed is a constant, so a failure here
  // reproduces exactly rather than "about one run in five hundred". This is the
  // same discipline `ledger/journal.fuzz.test.ts` uses.
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  it("conserves the total and never exceeds the pipeline across 300 randomised pipelines", () => {
    const next = lcg(20260630);

    for (let iteration = 0; iteration < 300; iteration += 1) {
      const count = 1 + Math.floor(next() * 5);
      const deals = Array.from({ length: count }, (_, index) =>
        deal({
          dealId: `d${String(index)}`,
          value: money(String(1 + Math.floor(next() * 1_000_000)), "INR"),
          probability: BigInt(Math.floor(next() * 1_000_001)),
        }),
      );

      const forecast = computeWeightedForecast(deals, money("0", "INR"));

      const summed = forecast.byStage.reduce((total, entry) => total.add(entry.weighted), money("0", "INR"));
      expect(summed.minor).toBe(forecast.weightedTotal.minor);
      expect(forecast.weightedTotal.minor).toBeLessThanOrEqual(forecast.totalPipeline.minor);
      expect(forecast.weightedTotal.minor).toBeGreaterThanOrEqual(0n);
      // The documented bound: half a minor unit per deal, reported in units of
      // 1/1,000,000 of a minor unit.
      const bound = BigInt(Math.ceil(deals.length / 2)) * 1_000_000n;
      expect(forecast.roundingDrift).toBeGreaterThanOrEqual(-bound);
      expect(forecast.roundingDrift).toBeLessThanOrEqual(bound);
    }
  });

  it("lands within one minor unit per deal of the exact rational value", () => {
    // The rounding contract: never more than the largest-remainder bound, and
    // never a systematic bias in one direction across many pipelines.
    const next = lcg(770077);

    let upward = 0;
    let downward = 0;

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const dealUnderTest = deal({
        dealId: "d0",
        value: money(String(1 + Math.floor(next() * 1_000_000)), "INR"),
        probability: BigInt(Math.floor(next() * 1_000_001)),
      });
      const forecast = computeWeightedForecast([dealUnderTest], money("0", "INR"));
      const exactNumerator = dealUnderTest.value.minor * dealUnderTest.probability;
      const exactFloor = exactNumerator / 1_000_000n;
      const actual = forecast.weightedTotal.minor;

      expect(actual).toBeGreaterThanOrEqual(exactFloor);
      expect(actual).toBeLessThanOrEqual(exactFloor + 1n);
      if (actual > exactFloor) upward += 1;
      if (actual < exactFloor) downward += 1;
    }

    // With one deal per pipeline the rounded figure is either the floor or the
    // next unit up, and never below: rounding half up never truncates downward.
    expect(downward).toBe(0);
    expect(upward).toBeGreaterThan(0);
  });
});