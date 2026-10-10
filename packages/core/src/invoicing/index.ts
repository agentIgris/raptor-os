/**
 * Invoicing: totals derived from lines, and a lifecycle with no way back.
 *
 * Three decisions, and each one closes a hole.
 *
 * 1. **The total is derived, never supplied.** `CreateInvoiceInput` has no total
 *    field, and `createInvoice` *refuses* an input that carries one — not
 *    corrects it, not reconciles it, not ignores it. A supplied total that was
 *    silently reconciled would leave the caller believing they asserted something
 *    they did not, and the invoice they hold and the invoice they sent would be
 *    two documents with one name. A supplied total is refused even when it
 *    happens to agree, because accepting it teaches callers the field works.
 *    `assertInvoiceTotalAgrees` is the independent re-check.
 * 2. **A mixed-currency invoice is an error, not a conversion.** ADR-0003 forbids
 *    *implicit* currency mixing, and `ledger/journal.ts` draws the line there: a
 *    journal converts because it has two sides that must balance, and the
 *    conversion is a real movement between them. An invoice has no second side.
 *    A conversion on an invoice would be a movement that never happened — an
 *    invented leg on a legal document addressed to one payer in one currency.
 * 3. **`paid` is terminal.** Voiding a paid invoice would assert that the money
 *    was never owed while a payment naming it sits in the ledger. The correction
 *    path is a credit note, which this package deliberately does not model; the
 *    absence is honest, and inventing a rule would not be.
 *
 * No persistence — `packages/db` owns the tables. No network, and no clock.
 */

export { assertInvoiceTotalAgrees, computeInvoiceTotal, createInvoice, lineAmount } from "./invoice.js";
export type { CreateInvoiceInput, Invoice, InvoiceLine } from "./invoice.js";

export {
  INVOICE_STATES,
  INVOICE_TRANSITIONS,
  IRREVERSIBLE_INVOICE_TRANSITIONS,
  assertCanTransition,
  canTransition,
  isIrreversibleTransition,
  isTerminalState,
  isVoid,
  nextStates,
  transitionInvoice,
} from "./state.js";
export type { InvoiceState, InvoiceTransition, TransitionInvoiceInput } from "./state.js";