/**
 * Analytics: what may be computed, and what must be reported absent.
 *
 * These tests exist to pin down one property above all others — **a figure this
 * package produces can be re-derived from the inputs it hands back**. Every test
 * that asserts a value also asserts the numerator and denominator behind it,
 * because a test that checks only the rendered number would pass just as well
 * against the fabricated `matches * 0.7`.
 *
 * The tests that matter most are the negative ones. `winRate` returning something
 * for a window of three draws is the exact failure ADR-0019 documents, and it is
 * the failure a value-only assertion cannot see.
 */

import { describe, expect, it } from "vitest";

import type { AvailableMetric, Metric, UnavailableMetric } from "./metric.js";

/**
 * Narrow a metric to its available branch, failing loudly otherwise.
 *
 * `expect(metric.status).toBe("available")` does NOT narrow the type -
 * `expect` is a function, so TypeScript cannot follow the assertion into the
 * next statement. Without this helper the tests cannot read `numerator`,
 * `denominator` or `value` at all without a cast at every one of 33 sites, and
 * a cast is exactly the thing that would let a test silently start reading
 * fields off the UNAVAILABLE branch - the branch that exists so no caller can
 * read a number where there is none.
 *
 * Throwing rather than returning `undefined` keeps a failure legible: the
 * assertion that follows names the metric and the actual status.
 */
function requireAvailable(metric: Metric): AvailableMetric {
  if (metric.status !== "available") {
    throw new Error(`expected an available metric, got "${metric.status}"`);
  }
  return metric;
}

/**
 * The mirror of {@link requireAvailable}: narrow to the absent branch.
 *
 * `reason` and `explanation` exist ONLY here. That is the point of the type — a
 * caller cannot read "why is this absent" off a figure that is present, and
 * cannot read a figure off a metric that is not there. Both helpers throw rather
 * than cast, so a test cannot quietly cross the branch it is asserting about.
 */
function requireUnavailable(metric: Metric): UnavailableMetric {
  if (metric.status !== "unavailable") {
    throw new Error(`expected an unavailable metric, got "${metric.status}"`);
  }
  return metric;
}

import {
  RATIO_SCALE,
  UNAVAILABLE_REASONS,
  available,
  count,
  headshotRate,
  impactRating,
  indexReport,
  isUnavailableReason,
  kdRatio,
  mapWinRate,
  matchesWon,
  metricValue,
  ratioOr,
  squadVersusPlayerLines,
  teamRanking,
  totalSurvivalSeconds,
  unavailableMetric,
  winRate,
} from "./index.js";
import { assertClosedWindow, assertEventDate, eventWindow, isInWindow, utcDayBucket } from "./window.js";

/** Whole ISO instants with explicit offsets only — see `window.ts`. */
const MARCH_FIRST = "2026-03-01T00:00:00Z";
const APRIL_FIRST = "2026-04-01T00:00:00Z";

describe("a metric carries its own derivation", () => {
  it("states the numerator and denominator alongside the value", () => {
    const metric = available("kd_ratio", 125n, 187n);

    expect(metric.status).toBe("available");
    expect(requireAvailable(metric).numerator).toBe(125n);
    expect(requireAvailable(metric).denominator).toBe(187n);
    // Reproducible by hand from what the metric hands back, which is ADR-0019
    // rule 2: every computed value is reproducible from stored raw inputs. The
    // tolerance is exactly one unit in the last reported place — the value is
    // ROUNDED to four decimals, so demanding exact equality with the true ratio
    // would be demanding a number the metric does not claim to hold.
    const exact = Number(metric.numerator) / Number(metric.denominator);
    expect(Math.abs(Number(metric.value) - exact)).toBeLessThanOrEqual(10 ** -RATIO_SCALE / 2);
  });

  it("always renders RATIO_SCALE decimals, so two reports of the same figure look the same", () => {
    expect(available("m", 1n, 2n).value).toBe("0.5000");
    expect(available("m", 1n, 3n).value).toBe("0.3333");
    expect(available("m", 2n, 3n).value).toBe("0.6667");
    expect(available("m", 1n, 10000n).value).toBe("0.0001");
  });

  it("rounds half UP, so the same figure never differs between two machines", () => {
    // A rounding mode that depended on the platform would make a leaderboard
    // reorder itself between CI and a reviewer's laptop, and nobody would be able
    // to say why. 0.49995 must round to 0.5000 and 0.49994 must round to 0.4999.
    expect(available("m", 1n, 2n).value).toBe("0.5000");
    expect(available("m", 49995n, 100000n).value).toBe("0.5000");
    expect(available("m", 49994n, 100000n).value).toBe("0.4999");
    // And a third must round DOWN, not up: an earlier draft compared the doubled
    // remainder against 1 rather than against the denominator, which rounded
    // every non-exact figure up and reported 1/3 as 0.3334.
    expect(available("m", 1n, 3n).value).toBe("0.3333");
  });

  it("counts in integers and never touches a float", () => {
    const metric = count("matches_won", 4n);
    expect(requireAvailable(metric).value).toBe("4");
    expect(requireAvailable(metric).numerator).toBe(4n);
  });

  it("refuses a negative count rather than rendering a confident negative percentage", () => {
    expect(() => available("kd_ratio", -1n, 10n)).toThrow(/negative count is not a measurement/i);
    expect(() => count("matches_won", -1n)).toThrow(/negative count is not a measurement/i);
  });

  it("refuses a zero denominator at construction, so `undefined` cannot be spelled as 0", () => {
    // `available("m", 1n, 0n)` producing "0.0000" is the fabrication in miniature:
    // a real number standing in for the absence of one.
    expect(() => available("m", 1n, 0n)).toThrow(/must be unavailable, not/i);
  });

  it("refuses a blank key, because a figure nobody can name cannot be checked", () => {
    expect(() => available("  ", 1n, 2n)).toThrow(/must carry a key/i);
    expect(() => unavailableMetric("", "zero_denominator", "because")).toThrow(/must carry a key/i);
  });
});

describe("an absent metric says why, in a closed vocabulary", () => {
  it("rejects a reason outside the closed set, because an unrecognised reason is an invented one", () => {
    expect(() =>
      unavailableMetric("m", "because_i_said_so" as never, "an explanation"),
    ).toThrow(/unknown reason/i);
  });

  it("rejects an absence with no explanation", () => {
    expect(() => unavailableMetric("m", "zero_denominator", "   ")).toThrow(/carries no explanation/i);
  });

  it("accepts every declared reason", () => {
    for (const reason of UNAVAILABLE_REASONS) {
      expect(isUnavailableReason(reason)).toBe(true);
      expect(unavailableMetric("m", reason, "an explanation").status).toBe("unavailable");
    }
  });

  it("has NO value on the absent branch, so a caller cannot read a number off it", () => {
    // `metric.status === "available"` narrows; anything else has no `value` at
    // all. That is the type-level half of "never fabricate": there is no `null`
    // to render, no `?? 0`, and no fallback that silently produces a figure.
    const absent = teamRanking({ wins: 0n, losses: 0n, draws: 0n });
    expect(absent.status).toBe("unavailable");
    expect(metricValue(absent)).toBeUndefined();
    expect("value" in absent).toBe(false);
  });
});

describe("win rate", () => {
  it("is wins over DECIDED matches — a draw is not a loss", () => {
    // 2 wins and 2 losses with 6 draws: 50%. Counting the draws would give
    // 2/10 = 20%, which reports a team that drew most of its matches as a
    // bottom-of-table one.
    const metric = winRate({ wins: 2n, losses: 2n, draws: 6n });
    expect(metric.status).toBe("available");
    expect(requireAvailable(metric).numerator).toBe(2n);
    expect(requireAvailable(metric).denominator).toBe(4n);
    expect(requireAvailable(metric).value).toBe("0.5000");
  });

  it("is ABSENT when nothing was decided — never zero", () => {
    // Three draws is a real result and a genuinely undefined rate. "0.0000" here
    // is a claim about failure that the data does not support, and it is the
    // shape of the fabrication ADR-0019 documents.
    const metric = winRate({ wins: 0n, losses: 0n, draws: 3n });
    expect(metric.status).toBe("unavailable");
    expect(requireUnavailable(metric).reason).toBe("no_decided_events");
    expect(metricValue(metric)).toBeUndefined();
  });

  it("is ABSENT for an empty window, and says so differently from an all-draws window", () => {
    const empty = winRate({ wins: 0n, losses: 0n, draws: 0n });
    expect(empty.status).toBe("unavailable");
    expect(requireUnavailable(empty).reason).toBe("no_decided_events");
    expect(requireUnavailable(empty).explanation).toMatch(/No match in this window/i);
  });

  it("refuses to be built by multiplying the match count by a constant", () => {
    // The legacy formula, asserted as NOT what this function does, with numbers
    // chosen so the two disagree visibly: 10 matches, 3 won, 7 lost.
    // totalMatches * 0.7 = 7.0000. The real rate is 0.3000.
    const metric = winRate({ wins: 3n, losses: 7n, draws: 0n });
    expect(metric.status).toBe("available");
    expect(requireAvailable(metric).value).toBe("0.3000");
    expect(metricValue(metric)).not.toBe("7.0000");
  });
});

describe("map win rate", () => {
  it("is maps won over maps won plus maps lost", () => {
    const metric = mapWinRate(5n, 3n);
    expect(requireAvailable(metric).numerator).toBe(5n);
    expect(requireAvailable(metric).denominator).toBe(8n);
    expect(requireAvailable(metric).value).toBe("0.6250");
  });

  it("is ABSENT, not zero, when no map was played", () => {
    const metric = mapWinRate(0n, 0n);
    expect(metric.status).toBe("unavailable");
    expect(requireUnavailable(metric).reason).toBe("no_decided_events");
  });
});

describe("K/D ratio", () => {
  it("is kills over deaths when deaths were recorded", () => {
    const metric = kdRatio(125n, 100n);
    expect(requireAvailable(metric).numerator).toBe(125n);
    expect(requireAvailable(metric).denominator).toBe(100n);
    expect(requireAvailable(metric).value).toBe("1.2500");
  });

  it("is ABSENT with `zero_denominator` when nobody died — not infinite, not zero", () => {
    // ADR-0019: the legacy system tracked no deaths at all, so a stored 0 and a
    // stored "unrecorded" are indistinguishable. This schema tracks them (0007),
    // so a genuine zero is a real answer and an UNDEFINED ratio is a different one.
    const metric = kdRatio(30n, 0n);
    expect(metric.status).toBe("unavailable");
    expect(requireUnavailable(metric).reason).toBe("zero_denominator");
    expect(requireUnavailable(metric).explanation).toMatch(/not reported as zero and not reported as infinite/i);
  });
});

describe("headshot rate", () => {
  it("reports hits per hundred ATTEMPTS, from the raw pair", () => {
    const metric = headshotRate(25n, 100n);
    expect(metric.status).toBe("available");
    // The numerator is scaled by 100 so the value reads as a percentage while
    // staying exactly numerator/denominator at four decimals.
    expect(requireAvailable(metric).numerator).toBe(2500n);
    expect(requireAvailable(metric).denominator).toBe(100n);
    expect(requireAvailable(metric).value).toBe("25.0000");
  });

  it("is ABSENT when no attempt was recorded", () => {
    const metric = headshotRate(0n, 0n);
    expect(metric.status).toBe("unavailable");
    expect(requireUnavailable(metric).reason).toBe("no_decided_events");
    expect(requireUnavailable(metric).explanation).toMatch(/different claim from nobody having tried/i);
  });

  it("refuses more hits than attempts, which describes a match that cannot have happened", () => {
    expect(() => headshotRate(11n, 10n)).toThrow(/cannot have happened/i);
  });
});

describe("a match is a match, not a player-row", () => {
  it("counts DISTINCT MATCH ids, so a four-player squad win is one win", () => {
    // The legacy defect verbatim: one team win by four players reported as four
    // wins, because `/api/public/stats/route.ts:26-28` counted player-rows.
    const oneSquadWin = new Set(["match-1"]);
    expect(requireAvailable(matchesWon(oneSquadWin)).value).toBe("1");
  });

  it("publishes BOTH counts, so a reader can see which one they were shown", () => {
    const winningMatchIds = new Set(["match-1", "match-2"]);
    const winningLineIds = new Set([
      "match-1/player-1", "match-1/player-2", "match-1/player-3", "match-1/player-4",
      "match-2/player-1", "match-2/player-2", "match-2/player-3", "match-2/player-4",
    ]);

    const { matches, playerLines } = squadVersusPlayerLines(winningMatchIds, winningLineIds);
    expect(requireAvailable(matches).value).toBe("2");
    expect(requireAvailable(playerLines).value).toBe("8");
    // The gap is the whole point: a report showing only 8 would look like four
    // times the success of one showing 2.
    expect(requireAvailable(playerLines).numerator / requireAvailable(matches).numerator).toBe(4n);
  });
});

describe("team ranking is absent, and says why", () => {
  it("returns NO RULE RECOVERED rather than any number at all", () => {
    // ADR-0019: `Math.ceil(totalMatches / 5)`. There is no honest version of that
    // to recover, and no other one in the source, so the deliverable here is the
    // refusal — made specific enough that a product owner reading it knows which
    // idea is being declined.
    const metric = teamRanking({ wins: 40n, losses: 10n, draws: 5n });
    expect(metric.status).toBe("unavailable");
    expect(requireUnavailable(metric).reason).toBe("no_rule_recovered");
    expect(metricValue(metric)).toBeUndefined();
  });

  it("does not compute the legacy formula even when the inputs would make it look good", () => {
    // 55 matches: `Math.ceil(55 / 5)` = 11, which is a flattering-looking rank.
    const metric = teamRanking({ wins: 55n, losses: 0n, draws: 0n });
    expect(metricValue(metric)).toBeUndefined();
    expect(requireUnavailable(metric).explanation).toMatch(/Math\.ceil\(totalMatches \/ 5\)/);
  });

  it("returns ABSENT for an empty record too, so an absent input cannot produce a rank", () => {
    expect(teamRanking({ wins: 0n, losses: 0n, draws: 0n }).status).toBe("unavailable");
  });
});

describe("metrics whose inputs do not exist", () => {
  it("reports impact rating as `input_not_tracked`, with a key to ask for", () => {
    // ADR-0019 searched exhaustively: no ADR, no ACS, no impact rating, no
    // headshot formula. Reporting the ABSENCE with a key means the gap is a fact
    // a dashboard can display, rather than a blank space nobody notices.
    const metric = impactRating();
    expect(metric.status).toBe("unavailable");
    expect(requireUnavailable(metric).reason).toBe("input_not_tracked");
    expect(metric.key).toBe("impact_rating");
  });

  it("reports survival time as a raw SUM carrying its unit, never a unitless average", () => {
    // `survival_time` was minutes on one legacy surface and seconds on another
    // (ADR-0019, unresolvable item 3), which is why 0007 renamed the column
    // `survival_time_seconds`. A mean would divide by a "match count" whose
    // meaning is exactly what was in doubt.
    const metric = totalSurvivalSeconds(7200n);
    expect(requireAvailable(metric).value).toBe("7200");
    expect(metric.key).toBe("total_survival_seconds");
    expect(metricValue(metric)).not.toContain(".");
  });

  it("refuses a negative duration", () => {
    expect(() => totalSurvivalSeconds(-1n)).toThrow(/cannot be negative/i);
  });
});

describe("windows are on the event date", () => {
  it("files an event by its own instant, and only its own instant", () => {
    const window = eventWindow(MARCH_FIRST, APRIL_FIRST);

    // The ADR-0019 rule 5 case: a match that HAPPENED last month and was CREATED
    // today. The window has no parameter for the creation instant, so the row
    // cannot be filed under the wrong period by construction.
    const backfilled = { eventAt: "2026-03-15T18:00:00Z", source: "match.scheduled_at" } as const;
    expect(isInWindow(backfilled, window)).toBe(true);
  });

  it("is HALF-OPEN, so an event at midnight belongs to exactly one day", () => {
    const mayFourth = eventWindow("2026-05-04T00:00:00Z", "2026-05-05T00:00:00Z");
    const mayFifth = eventWindow("2026-05-05T00:00:00Z", "2026-05-06T00:00:00Z");
    const midnight = { eventAt: "2026-05-05T00:00:00Z", source: "match.scheduled_at" } as const;

    expect(isInWindow(midnight, mayFourth)).toBe(false);
    expect(isInWindow(midnight, mayFifth)).toBe(true);
  });

  it("compares INSTANTS, not strings — two spellings of one moment land on the same side", () => {
    // 2026-05-04T02:00:00+02:00 IS 2026-05-04T00:00:00Z — exactly the window's
    // first instant, so it belongs inside. Compared as strings, "…T02:00:00+02:00"
    // sorts AFTER "…T00:00:00Z" and would be excluded: the hour field is read as a
    // wall clock in two different zones and the comparison silently answers a
    // question nobody asked.
    const window = eventWindow("2026-05-04T00:00:00Z", "2026-05-05T00:00:00Z");
    const sameInstantOtherOffset = { eventAt: "2026-05-04T02:00:00+02:00", source: "match.scheduled_at" } as const;

    expect(Date.parse(sameInstantOtherOffset.eventAt)).toBe(Date.parse(window.from));
    // The wrong answer, shown so the assertion below is not vacuous.
    expect(sameInstantOtherOffset.eventAt > window.from).toBe(true);
    expect(isInWindow(sameInstantOtherOffset, window)).toBe(true);
  });

  it("buckets by UTC day, and says so", () => {
    expect(utcDayBucket({ eventAt: "2026-05-04T23:30:00Z", source: "match.scheduled_at" })).toBe("2026-05-04");
  });

  it("refuses a bare date, which means a different day in every reader's timezone", () => {
    expect(() => assertEventDate("2026-05-04", "A match date")).toThrow(/explicit UTC offset/i);
    expect(() => assertEventDate("2026-05-04T18:00:00", "A match time")).toThrow(/explicit UTC offset/i);
  });

  it("refuses an open-ended window rather than defaulting it", () => {
    expect(() => assertClosedWindow({ to: APRIL_FIRST })).toThrow(/the start is missing/i);
    expect(() => assertClosedWindow({ from: MARCH_FIRST })).toThrow(/the end is missing/i);
    expect(() => assertClosedWindow({})).toThrow(/needs both a start and an end/i);
  });

  it("refuses a window that ends before it starts, instead of reporting nothing", () => {
    // An empty result and an impossible window are different answers, and "no
    // data" is the wrong report for a caller who passed April before March.
    expect(() => eventWindow(APRIL_FIRST, MARCH_FIRST)).toThrow(/ends before it starts/i);
    expect(() => eventWindow(MARCH_FIRST, MARCH_FIRST)).toThrow(/empty by construction/i);
  });
});

describe("a report indexes by key", () => {
  it("refuses two metrics under one name, because one name must answer to one figure", () => {
    const report = {
      window: { from: MARCH_FIRST, to: APRIL_FIRST },
      metrics: [winRate({ wins: 1n, losses: 1n, draws: 0n }), teamRanking({ wins: 1n, losses: 1n, draws: 0n })],
    };
    const index = indexReport(report);
    expect(index.get("win_rate")?.status).toBe("available");
    expect(index.get("team_ranking")?.status).toBe("unavailable");

    expect(() =>
      indexReport({
        window: report.window,
        metrics: [winRate({ wins: 1n, losses: 1n, draws: 0n }), winRate({ wins: 2n, losses: 1n, draws: 0n })],
      }),
    ).toThrow(/two metrics named win_rate/i);
  });
});

describe("ratioOr is the only path to a ratio", () => {
  it("produces an ABSENCE with the given reason rather than a zero", () => {
    const metric = ratioOr("kd_ratio", 10n, 0n, "no deaths recorded", "zero_denominator");
    expect(metric.status).toBe("unavailable");
    expect(requireUnavailable(metric).reason).toBe("zero_denominator");
  });

  it("produces an AVAILABLE metric when the denominator is real", () => {
    const metric = ratioOr("kd_ratio", 10n, 4n, "irrelevant when a denominator exists");
    expect(metric.status).toBe("available");
    expect(requireAvailable(metric).value).toBe("2.5000");
  });
});
