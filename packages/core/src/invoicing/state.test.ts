import { describe, expect, it } from "vitest";

import type { InvoiceState } from "./state.js";
import {
  IRREVERSIBLE_INVOICE_TRANSITIONS,
  INVOICE_STATES,
  INVOICE_TRANSITIONS,
  assertCanTransition,
  canTransition,
  isIrreversibleTransition,
  isTerminalState,
  isVoid,
  nextStates,
  transitionInvoice,
} from "./state.js";

describe("the invoice state table", () => {
  it("names every state exactly once", () => {
    expect(Object.keys(INVOICE_TRANSITIONS).sort()).toEqual([...INVOICE_STATES].sort());
  });

  it("only ever points at states that exist", () => {
    for (const targets of Object.values(INVOICE_TRANSITIONS)) {
      for (const target of targets) {
        expect(INVOICE_STATES).toContain(target);
      }
    }
  });

  it("never lists a state as transitioning to itself", () => {
    for (const [from, targets] of Object.entries(INVOICE_TRANSITIONS)) {
      expect(targets).not.toContain(from as InvoiceState);
    }
  });

  it("declares the five states the lifecycle is made of", () => {
    expect(INVOICE_STATES).toEqual(["draft", "issued", "paid", "overdue", "void"]);
  });
});

describe("canTransition across the full matrix", () => {
  const pairs = INVOICE_STATES.flatMap((from) => INVOICE_STATES.map((to) => ({ from, to })));

  it("covers every ordered pair of states", () => {
    expect(pairs).toHaveLength(INVOICE_STATES.length * INVOICE_STATES.length);
  });

  it.each(pairs)("$from -> $to is $expected", ({ from, to }) => {
    expect(canTransition(from, to)).toBe(INVOICE_TRANSITIONS[from].includes(to));
  });

  it("refuses every transition out of a terminal state", () => {
    for (const state of INVOICE_STATES.filter(isTerminalState)) {
      for (const target of INVOICE_STATES) {
        expect(canTransition(state, target)).toBe(false);
      }
    }
  });

  it("rejects an unknown state rather than defaulting it to allowed", () => {
    expect(() => canTransition("disputed" as InvoiceState, "draft")).toThrow(/unknown/i);
    expect(() => canTransition("draft", "disputed" as InvoiceState)).toThrow(/unknown/i);
  });
});

describe("the invoice lifecycle", () => {
  it("will not let a draft be marked paid, or issued without leaving draft", () => {
    // `draft -> paid` would be an invoice nobody was ever sent.
    expect(canTransition("draft", "paid")).toBe(false);
    expect(canTransition("draft", "overdue")).toBe(false);
  });

  it("will not let a paid invoice be un-paid", () => {
    expect(canTransition("paid", "issued")).toBe(false);
    expect(canTransition("paid", "overdue")).toBe(false);
  });

  it("will not let a paid invoice be voided", () => {
    // The decision this module makes, and the reason for it: `paid` is terminal.
    // Voiding a paid invoice would assert that the money was never owed, while
    // the payment it names is still in the ledger. The correction path is a
    // credit note — a *new* document — which this package does not model,
    // deliberately, rather than a void that erases the fact that money moved.
    expect(canTransition("paid", "void")).toBe(false);
    expect(isTerminalState("paid")).toBe(true);
  });

  it("lets an overdue invoice still be paid, because late payment is payment", () => {
    // The overdue state records that the due date passed unpaid. Refusing
    // `overdue -> paid` would mean a late payer is recorded as still owing
    // money that has in fact arrived.
    expect(canTransition("overdue", "paid")).toBe(true);
    expect(canTransition("issued", "overdue")).toBe(true);
  });

  it("cannot un-overdue an invoice: the fact that a due date passed is not undone by paying", () => {
    // There is no `overdue -> issued`. The record of lateness is not the same
    // fact as the record of issuance, and paying does not make the invoice have
    // been issued on time.
    expect(canTransition("overdue", "issued")).toBe(false);
  });

  it("lets a draft or an issued or overdue invoice be voided", () => {
    expect(canTransition("draft", "void")).toBe(true);
    expect(canTransition("issued", "void")).toBe(true);
    expect(canTransition("overdue", "void")).toBe(true);
  });

  it("recognises void as the state that means 'this was never owed'", () => {
    expect(isVoid("void")).toBe(true);
    expect(isVoid("paid")).toBe(false);
    expect(isVoid("draft")).toBe(false);
  });
});

describe("irreversibility", () => {
  it("derives the irreversible set from the table and it matches the pinned list", () => {
    // Pinned explicitly so a change to the table cannot quietly widen what can
    // never be undone. Voiding a paid invoice is the edit this list is here to
    // prevent.
    expect([...IRREVERSIBLE_INVOICE_TRANSITIONS].sort()).toEqual(
      [
        "draft->issued",
        "draft->void",
        "issued->overdue",
        "issued->paid",
        "issued->void",
        "overdue->paid",
        "overdue->void",
      ].sort(),
    );
  });

  it("marks issuing as irreversible: an issued invoice stays issued", () => {
    expect(isIrreversibleTransition("draft", "issued")).toBe(true);
    expect(canTransition("issued", "draft")).toBe(false);
  });

  it("marks going overdue as irreversible", () => {
    // There is no way back from `overdue` to `issued`, and paying does not
    // un-overdue it. That is the point of recording lateness at all.
    expect(isIrreversibleTransition("issued", "overdue")).toBe(true);
    expect(canTransition("overdue", "issued")).toBe(false);
  });

  it("marks every move into void as irreversible, and void as terminal", () => {
    for (const from of ["draft", "issued", "overdue"] as const) {
      expect(isIrreversibleTransition(from, "void")).toBe(true);
    }
    expect(nextStates("void")).toEqual([]);
  });

  it("never marks a terminal state as a transition at all", () => {
    for (const from of INVOICE_STATES.filter(isTerminalState)) {
      for (const to of INVOICE_STATES) {
        expect(isIrreversibleTransition(from, to)).toBe(false);
      }
    }
  });

  it("returns false for an edge the table does not declare", () => {
    expect(isIrreversibleTransition("draft", "paid")).toBe(false);
  });
});

describe("nextStates", () => {
  it("returns the declared successors of a state", () => {
    expect(nextStates("issued")).toEqual(["paid", "overdue", "void"]);
  });

  it("returns a frozen list", () => {
    expect(Object.isFrozen(nextStates("issued"))).toBe(true);
  });

  it("rejects an unknown state", () => {
    expect(() => nextStates("disputed" as InvoiceState)).toThrow(/unknown/i);
  });
});

describe("assertCanTransition", () => {
  it("passes for a declared transition", () => {
    expect(() => assertCanTransition("draft", "issued")).not.toThrow();
  });

  it("names the permitted moves when it refuses one", () => {
    expect(() => assertCanTransition("paid", "void")).toThrow(/paid.*void|void.*paid/s);
  });

  it("says a terminal state has no permitted moves, rather than printing an empty list", () => {
    expect(() => assertCanTransition("void", "issued")).toThrow(/none.*terminal/i);
    expect(() => assertCanTransition("paid", "issued")).toThrow(/none.*terminal/i);
  });
});

describe("transitionInvoice", () => {
  const AT = new Date("2026-05-01T00:00:00.000Z");

  it("returns a frozen record of the move", () => {
    const record = transitionInvoice({
      invoiceId: "inv_1",
      from: "draft",
      to: "issued",
      at: AT,
      actorId: "person_finance",
      reason: "sent to partner",
    });

    expect(record).toEqual({
      invoiceId: "inv_1",
      from: "draft",
      to: "issued",
      at: AT,
      actorId: "person_finance",
      reason: "sent to partner",
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("refuses to record a move the table forbids", () => {
    expect(() =>
      transitionInvoice({ invoiceId: "inv_1", from: "paid", to: "void", at: AT, actorId: "person_finance", reason: "oops" }),
    ).toThrow(/paid.*void|void.*paid/s);
  });

  it("refuses to record a move out of a terminal state", () => {
    expect(() =>
      transitionInvoice({ invoiceId: "inv_1", from: "void", to: "issued", at: AT, actorId: "person_finance" }),
    ).toThrow();
  });

  it("requires an actor and a valid instant", () => {
    expect(() =>
      transitionInvoice({ invoiceId: "inv_1", from: "draft", to: "issued", at: AT, actorId: " " }),
    ).toThrow(/actor/i);
    expect(() =>
      transitionInvoice({ invoiceId: "inv_1", from: "draft", to: "issued", at: new Date("never"), actorId: "person_finance" }),
    ).toThrow(/at/i);
  });

  it("refuses to record a move naming no invoice", () => {
    expect(() =>
      transitionInvoice({ invoiceId: " ", from: "draft", to: "issued", at: AT, actorId: "person_finance" }),
    ).toThrow(/invoiceId/i);
  });

  it("requires a reason when voiding, which is the one a partner disputes", () => {
    expect(() =>
      transitionInvoice({ invoiceId: "inv_1", from: "issued", to: "void", at: AT, actorId: "person_finance" }),
    ).toThrow(/reason/i);
  });

  it("treats a whitespace-only reason as no reason at all", () => {
    expect(() =>
      transitionInvoice({
        invoiceId: "inv_1",
        from: "issued",
        to: "void",
        at: AT,
        actorId: "person_finance",
        reason: "   ",
      }),
    ).toThrow(/reason/i);
    expect(() =>
      transitionInvoice({
        invoiceId: "inv_1",
        from: "issued",
        to: "overdue",
        at: AT,
        actorId: "person_finance",
        reason: " ",
      }),
    ).toThrow(/reason/i);
  });

  it("requires a reason when going overdue, because 'we did not pay' is not a finding", () => {
    expect(() =>
      transitionInvoice({ invoiceId: "inv_1", from: "issued", to: "overdue", at: AT, actorId: "person_finance" }),
    ).toThrow(/reason/i);
  });

  it("allows an omitted reason on marking an invoice paid", () => {
    // Payment is evidenced by the payment record, not by a sentence here, so a
    // required reason would be a field nobody fills in.
    expect(() =>
      transitionInvoice({ invoiceId: "inv_1", from: "issued", to: "paid", at: AT, actorId: "person_finance" }),
    ).not.toThrow();
  });
});