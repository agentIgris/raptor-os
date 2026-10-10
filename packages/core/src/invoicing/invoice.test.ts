import { describe, expect, it } from "vitest";

import { money } from "../money/index.js";
import { computeInvoiceTotal, createInvoice, assertInvoiceTotalAgrees, lineAmount } from "./invoice.js";
import type { CreateInvoiceInput, InvoiceLine } from "./invoice.js";

/** A sponsorship invoice: a retainer plus two passes bought at a unit price. */
const LINES: readonly InvoiceLine[] = Object.freeze([
  Object.freeze({
    lineId: "line_1",
    description: "Season retainer",
    quantity: 1,
    unitPrice: money("500000", "INR"),
  }),
  Object.freeze({
    lineId: "line_2",
    description: "Grand final arena pass",
    quantity: 3,
    unitPrice: money("2500", "INR"),
  }),
]);

const BASE: CreateInvoiceInput = Object.freeze({
  invoiceId: "inv_1",
  organizationId: "org_1",
  partnerId: "partner_1",
  issuedAt: new Date("2026-05-01T00:00:00.000Z"),
  dueAt: new Date("2026-05-31T00:00:00.000Z"),
  lines: LINES,
});

describe("lineAmount", () => {
  it("is unitPrice multiplied by quantity, in exact minor units", () => {
    expect(lineAmount(LINES[1]!).toDecimal()).toBe("7500.0000");
  });

  it("is exact: 2500.0000 by 3 is 7500.0000, not 7499.999999999999", () => {
    // The float version of this multiply returns 7499.999999999999 on some
    // inputs. A billing figure off by a millionth of a rupee is a figure nobody
    // can reconcile against a bank statement.
    expect(lineAmount(LINES[1]!).minor).toBe(75_000_000n);
  });

  it("returns the unit price unchanged for a quantity of one", () => {
    expect(lineAmount(LINES[0]!).equals(money("500000", "INR"))).toBe(true);
  });

  it("is zero for a zero quantity, which is a line that should not have been raised", () => {
    expect(lineAmount({ ...LINES[0]!, quantity: 0 }).isZero()).toBe(true);
  });
});

describe("computeInvoiceTotal", () => {
  it("sums the lines", () => {
    expect(computeInvoiceTotal(LINES).toDecimal()).toBe("507500.0000");
  });

  it("returns the currency of the lines it summed", () => {
    expect(computeInvoiceTotal(LINES).currency).toBe("INR");
  });

  it("refuses an invoice with no lines, rather than totalling it to zero", () => {
    // A zero-total invoice is a real thing and it is never this: it is a line
    // that failed to load. Refusing means the caller finds out now.
    expect(() => computeInvoiceTotal([])).toThrow(/line/i);
  });

  it("refuses a mixed-currency invoice outright", () => {
    // ADR-0003 forbids *implicit* currency mixing, and `ledger/journal.ts` draws
    // the line at the word implicit: a conversion there states from, to and a
    // rate, because a journal has two sides that must balance and the conversion
    // is a real movement between them. An invoice has no second side. There is
    // nothing for a conversion to balance, so a conversion on an invoice would be
    // a movement that never happened.
    expect(() =>
      computeInvoiceTotal([LINES[0]!, { ...LINES[1]!, unitPrice: money("30", "USD") }]),
    ).toThrow(/USD|mixed|currency/i);
  });

  it("refuses a negative quantity, which would be a credit disguised as a charge", () => {
    expect(() => computeInvoiceTotal([{ ...LINES[0]!, quantity: -1 }])).toThrow(/quantity/i);
  });

  it("refuses a fractional quantity, because a third of a pass is not a pass", () => {
    expect(() => computeInvoiceTotal([{ ...LINES[0]!, quantity: 1.5 }])).toThrow(/quantity|integer/i);
  });

  it("refuses a line with no description, which nobody could identify on the statement", () => {
    expect(() => computeInvoiceTotal([{ ...LINES[0]!, description: "  " }])).toThrow(/description/i);
  });

  it("refuses a blank line id", () => {
    expect(() => computeInvoiceTotal([{ ...LINES[0]!, lineId: "" }])).toThrow(/lineId/i);
  });

  it("refuses two lines with the same id", () => {
    expect(() => computeInvoiceTotal([LINES[0]!, LINES[0]!])).toThrow(/duplicate|line_1/i);
  });
});

describe("createInvoice", () => {
  it("derives the total from the lines and stores it", () => {
    const invoice = createInvoice(BASE);

    expect(invoice.total.toDecimal()).toBe("507500.0000");
    expect(invoice.total.currency).toBe("INR");
    expect(invoice.lines).toHaveLength(2);
  });

  it("returns a deep-frozen invoice whose lines cannot be edited from outside", () => {
    const invoice = createInvoice(BASE);

    expect(Object.isFrozen(invoice)).toBe(true);
    expect(Object.isFrozen(invoice.lines)).toBe(true);
    expect(Object.isFrozen(invoice.lines[0])).toBe(true);
  });

  it("copies the caller's lines rather than aliasing them", () => {
    const lines = [...LINES];
    const invoice = createInvoice({ ...BASE, lines });

    lines.push(LINES[0]!);

    expect(invoice.lines).toHaveLength(2);
    expect(invoice.total.toDecimal()).toBe("507500.0000");
  });

  it("refuses an attempt to state a total that disagrees with the lines", () => {
    // This is the test the whole module is for. A supplied total is not corrected,
    // not reconciled and not ignored — it is refused. Silently reconciling would
    // mean the caller believes they asserted something they did not, and the
    // invoice they hold and the invoice they sent are different documents.
    expect(() =>
      createInvoice({ ...BASE, total: money("1", "INR") } as CreateInvoiceInput),
    ).toThrow(/total/i);
  });

  it("refuses a supplied total even when it happens to agree", () => {
    // Accepting it "because it is right" would teach callers that the field
    // works. The invariant is that the total is not a field a caller supplies at
    // all, and a lucky agreement is still a caller asserting a derived value.
    expect(() =>
      createInvoice({ ...BASE, total: money("507500", "INR") } as CreateInvoiceInput),
    ).toThrow(/total/i);
  });

  it("refuses a supplied total in a different currency", () => {
    expect(() =>
      createInvoice({ ...BASE, statedTotal: money("507500", "INR") } as unknown as CreateInvoiceInput),
    ).toThrow(/total/i);
  });

  it("has no property a caller could set a total on after construction", () => {
    // The structural half of the same guarantee: the object an invoice *is* has no
    // field that a caller can assign a total to. `total` exists and is correct,
    // but the invoice is frozen, so it cannot be re-pointed afterwards either.
    const invoice = createInvoice(BASE);

    expect(Object.keys(invoice).sort()).toEqual([
      "dueAt",
      "invoiceId",
      "issuedAt",
      "lines",
      "organizationId",
      "partnerId",
      "total",
    ]);
    expect(() => {
      (invoice as { total: unknown }).total = money("1", "INR");
    }).toThrow(TypeError);
    expect(invoice.total.toDecimal()).toBe("507500.0000");
  });

  it("refuses a blank invoice id, organisation id or partner id", () => {
    expect(() => createInvoice({ ...BASE, invoiceId: " " })).toThrow(/invoiceId/i);
    expect(() => createInvoice({ ...BASE, organizationId: "" })).toThrow(/organizationId/i);
    expect(() => createInvoice({ ...BASE, partnerId: "" })).toThrow(/partnerId/i);
  });

  it("refuses an invoice whose due date is not after its issue date", () => {
    expect(() => createInvoice({ ...BASE, dueAt: new Date("2026-04-01T00:00:00.000Z") })).toThrow(/dueAt/i);
    expect(() => createInvoice({ ...BASE, dueAt: BASE.issuedAt })).toThrow(/dueAt/i);
  });

  it("accepts a due date exactly one millisecond after the issue date", () => {
    expect(() =>
      createInvoice({ ...BASE, dueAt: new Date(BASE.issuedAt.getTime() + 1) }),
    ).not.toThrow();
  });

  it("refuses an invalid instant", () => {
    expect(() => createInvoice({ ...BASE, issuedAt: new Date("never") })).toThrow(/issuedAt/i);
    expect(() => createInvoice({ ...BASE, dueAt: new Date("never") })).toThrow(/dueAt/i);
  });

  it("refuses an invoice with no lines", () => {
    expect(() => createInvoice({ ...BASE, lines: [] })).toThrow(/line/i);
  });

  it("reports the derived total in the frozen invoice, not the one the caller held", () => {
    const invoice = createInvoice(BASE);
    const computed = computeInvoiceTotal(invoice.lines);

    expect(invoice.total.minor).toBe(computed.minor);
    expect(invoice.total.currency).toBe(computed.currency);
  });
});

describe("assertInvoiceTotalAgrees", () => {
  it("passes for an invoice whose total is what its lines imply", () => {
    expect(() => assertInvoiceTotalAgrees(createInvoice(BASE), LINES)).not.toThrow();
  });

  it("throws when the caller supplies different lines to the ones the invoice was built from", () => {
    // The independent re-check. A total derived once is only trustworthy if it can
    // be re-derived and compared; `ledger/journal.ts` does exactly this in
    // `assertTotalsAgreeWithLines`, and for the same reason.
    const invoice = createInvoice(BASE);

    expect(() =>
      assertInvoiceTotalAgrees(invoice, [LINES[0]!, { ...LINES[1]!, quantity: 4 }]),
    ).toThrow(/total|line/i);
  });

  it("names both figures when it throws", () => {
    const invoice = createInvoice(BASE);

    expect(() => assertInvoiceTotalAgrees(invoice, [LINES[0]!])).toThrow(/507500\.0000|50000\.0000/);
  });

  it("refuses to compare against a line set with no lines", () => {
    expect(() => assertInvoiceTotalAgrees(createInvoice(BASE), [])).toThrow(/line/i);
  });
});