/**
 * Invoices: the total is **derived from the lines**, always.
 *
 * ## Why the total cannot be supplied
 *
 * An invoice is the document an organisation sends a partner and a partner sends
 * to a bank. If its total is a field somebody filled in, then it is a field
 * somebody can fill in wrong, and the two artefacts disagree: the document reads
 * one figure and the arithmetic says another. There is no moment at which the two
 * are compared, which is exactly the defect `../obligations` exists to prevent in
 * the same repository.
 *
 * So {@link CreateInvoiceInput} has **no total field**, {@link createInvoice}
 * computes one, and — the part that matters — {@link createInvoice} *refuses* an
 * input that carries one. Not corrects it, not reconciles it, not ignores it: a
 * caller who supplies a total is told so, because silently reconciling would
 * leave them believing they asserted something they did not. The invoice they
 * hold and the invoice they sent would be different documents, and the only
 * evidence would be a silently reconciled number.
 *
 * A supplied total is refused *even when it happens to agree*. Accepting it
 * "because it is right" would teach callers that the field works, and the next
 * version of that caller would rely on it.
 *
 * {@link assertInvoiceTotalAgrees} is the independent re-check: it recomputes
 * from a line set supplied at comparison time and compares, exactly as
 * `ledger/journal.ts` does in `assertTotalsAgreeWithLines`.
 *
 * ## Mixed currency: refused, not converted
 *
 * ADR-0003 forbids *implicit* currency mixing, and `ledger/journal.ts` draws the
 * line at exactly that word. A journal carries two sides that must balance, so a
 * conversion between currencies is a **real movement** — value leaves one and
 * arrives in the other — and the ledger can require it to resolve exactly, to
 * state its rate, and to leave the invoice balanced.
 *
 * An invoice has no second side. There is nothing for a conversion to balance, so
 * a conversion on an invoice would be a movement that never happened: an invented
 * leg on a legal document addressed to one payer in one currency. A mixed-currency
 * invoice is therefore **an error**, and the fix is to convert deliberately
 * upstream — which is where a stated rate and a settlement date belong, and which
 * the design spec already puts out of scope (§11, "currency conversion
 * execution").
 *
 * ## Rounding: there isn't any
 *
 * A line is `unitPrice × quantity`, and both are exact: minor units are
 * integers and quantity is a validated integer. So no line rounds and no invoice
 * rounds. The only rounding in this repository is the largest-remainder
 * allocation in `money/allocate.ts`, which exists for the case where an amount
 * genuinely must be split. An invoice is not that case, and a rounding rule here
 * would be a rounding rule nobody could reconstruct from the lines.
 *
 * Pure: no database, no network, no clock. Every instant is supplied.
 */

import type { Money } from "../money/index.js";
import { zero } from "../money/index.js";

/** One chargeable line. */
export interface InvoiceLine {
  readonly lineId: string;
  readonly description: string;
  /**
   * How many units. A validated non-negative integer: fractional quantities
   * would need a rounding rule for `amount = unitPrice × quantity`, and an
   * invoice whose lines need a rounding rule is an invoice nobody can add up.
   */
  readonly quantity: number;
  readonly unitPrice: Money;
}

/**
 * The amount a single line is worth.
 *
 * Exact. Minor units are integers and quantity is an integer, so there is no
 * rounding here to explain — and no float to reach for, which is the point:
 * `2500.0000 × 3` as a `number` can return `7499.999999999999`, and a billing
 * figure off by a millionth of a rupee is one nobody can reconcile against a bank
 * statement.
 */
export function lineAmount(line: InvoiceLine): Money {
  assertQuantity(line.quantity, line.lineId);

  return line.unitPrice.multiply(BigInt(line.quantity));
}

/**
 * The total an invoice is worth: the sum of its lines.
 *
 * Refuses an empty line set and a line set spanning two currencies; see the module
 * note for why a mixed-currency invoice is an error rather than a conversion.
 *
 * Note what this does **not** do: it does not accept a stated total to check
 * against. {@link assertInvoiceTotalAgrees} does that, separately, so that "the
 * total of these lines" and "does this invoice still match its lines" stay two
 * questions rather than one function with an optional argument that quietly does
 * neither when it is absent.
 */
export function computeInvoiceTotal(lines: readonly InvoiceLine[]): Money {
  // `assertUsableLines` returns the shared currency precisely so this needs no
  // second lookup and no guard that could never fire.
  return lines.reduce<Money>((total, line) => total.add(lineAmount(line)), zero(assertUsableLines(lines)));
}

/** An invoice, with its total already derived. */
export interface Invoice {
  readonly invoiceId: string;
  readonly organizationId: string;
  readonly partnerId: string;
  readonly issuedAt: Date;
  readonly dueAt: Date;
  readonly lines: readonly InvoiceLine[];
  /**
   * `computeInvoiceTotal(lines)`. Present because every reader needs it and
   * recomputing it on each page is wasteful — but it is *derived*, and
   * {@link assertInvoiceTotalAgrees} is how a reader proves it still is.
   */
  readonly total: Money;
}

/**
 * The input to {@link createInvoice}.
 *
 * There is deliberately no `total`, `amount`, `subtotal`, `grandTotal` or
 * `statedTotal`. That absence is the guarantee; see the module note.
 */
export interface CreateInvoiceInput {
  readonly invoiceId: string;
  readonly organizationId: string;
  readonly partnerId: string;
  readonly issuedAt: Date;
  readonly dueAt: Date;
  readonly lines: readonly InvoiceLine[];
}

/**
 * Field names a caller might reach for when trying to state a total.
 *
 * Checked explicitly rather than relying on the TypeScript type, because the
 * caller that gets this wrong is a JSON request body, and a request body is not
 * type-checked. Listing the names is also documentation: it says what the module
 * will notice.
 */
const TOTAL_LIKE_FIELDS = ["total", "amount", "subtotal", "grandTotal", "statedTotal", "totalMinor", "net"] as const;

/**
 * Validate, total and deep-freeze an invoice.
 *
 * Refuses a blank identity, an invalid or non-advancing date window, an invoice
 * with no lines, and any attempt to supply a total.
 */
export function createInvoice(input: CreateInvoiceInput): Invoice {
  rejectSuppliedTotal(input);

  if (input.invoiceId.trim() === "") {
    throw new Error("An invoice must carry a non-empty invoiceId");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(
      `Invoice ${input.invoiceId} has a blank organizationId; tenancy scopes every read of this data (ADR-0011)`,
    );
  }
  if (input.partnerId.trim() === "") {
    throw new Error(`Invoice ${input.invoiceId} names no partnerId; an invoice to nobody is not owed by anybody`);
  }
  if (input.issuedAt === null || input.issuedAt === undefined || Number.isNaN(input.issuedAt.getTime())) {
    throw new Error(`Invoice ${input.invoiceId} has no usable issuedAt`);
  }
  if (input.dueAt === null || input.dueAt === undefined || Number.isNaN(input.dueAt.getTime())) {
    throw new Error(`Invoice ${input.invoiceId} has no usable dueAt`);
  }
  if (input.dueAt.getTime() <= input.issuedAt.getTime()) {
    throw new Error(
      `Invoice ${input.invoiceId} has dueAt ${input.dueAt.toISOString()}, at or before its issuedAt ${input.issuedAt.toISOString()}: a payment window that does not open is not a payment window`,
    );
  }

  const lines = input.lines.map((line) =>
    Object.freeze({
      lineId: line.lineId,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    }),
  );

  // Validates every line and computes the total. Called here rather than inlined
  // so that the frozen invoice's total is produced by the same function any other
  // caller uses, and the two cannot disagree about what a valid line is.
  const total = computeInvoiceTotal(lines);

  return Object.freeze({
    invoiceId: input.invoiceId,
    organizationId: input.organizationId,
    partnerId: input.partnerId,
    issuedAt: input.issuedAt,
    dueAt: input.dueAt,
    lines: Object.freeze(lines),
    total,
  });
}

/**
 * Refuse an input that carries a total, whatever it is called.
 *
 * Checked against the raw object rather than the declared type, because the
 * caller that makes this mistake is a request handler passing a parsed JSON body
 * and TypeScript never saw it.
 */
function rejectSuppliedTotal(input: CreateInvoiceInput): void {
  const raw = input as unknown as Record<string, unknown>;
  // The id is read defensively because it is being used to build an error
  // message about an input that has already been found malformed; stringifying an
  // unknown would print `[object Object]` into the one message somebody will read.
  const named = typeof raw["invoiceId"] === "string" ? raw["invoiceId"] : "(unnamed)";

  for (const field of TOTAL_LIKE_FIELDS) {
    if (raw[field] !== undefined) {
      throw new Error(
        `Invoice ${named} supplied a "${field}". An invoice's total is derived from its lines and cannot be stated: the figure you are asserting and the figure the arithmetic produces are two documents, and nothing in the system compares them. Remove the field and use computeInvoiceTotal(lines).`,
      );
    }
  }
}

/**
 * Recompute an invoice's total from a line set and confirm it still agrees.
 *
 * This is the re-check the ledger already performs in
 * `assertTotalsAgreeWithLines`, and for the same reason: a total that cannot be
 * re-derived is a number nobody can audit, and a row edited by a migration or a
 * console is only caught by something that recomputes rather than reads.
 *
 * Throws naming both figures.
 */
export function assertInvoiceTotalAgrees(invoice: Invoice, lines: readonly InvoiceLine[]): void {
  const recomputed = computeInvoiceTotal(lines);

  if (recomputed.currency !== invoice.total.currency || recomputed.minor !== invoice.total.minor) {
    throw new Error(
      `Invoice ${invoice.invoiceId} states a total of ${invoice.total.toString()} but the ${String(lines.length)} line(s) supplied add up to ${recomputed.toString()}. An invoice whose stated total disagrees with its lines is two documents wearing one name.`,
    );
  }
}

/**
 * Every line is usable, and the whole set shares one currency.
 *
 * Applied by {@link computeInvoiceTotal} rather than only by
 * {@link createInvoice}, because a total computed from a duplicate line id or an
 * unnamed charge is wrong in exactly the same way whether or not an invoice
 * object was ever built around it. Validating once, here, is what makes the two
 * functions agree by construction rather than by discipline.
 *
 * The mixed-currency refusal is this module's currency decision; see the note at
 * the top of this file for why it is a refusal and not a conversion.
 *
 * Returns the currency the lines share, so the caller can build a zero without a
 * second lookup and without a guard that could never fire.
 */
function assertUsableLines(lines: readonly InvoiceLine[]): string {
  if (lines.length === 0) {
    throw new Error(
      "Cannot total an invoice with no lines. A zero total here means a line failed to load, not that nothing is owed, and the two need different responses.",
    );
  }

  const seen = new Set<string>();
  // The first line's currency, fixed by the emptiness check above. `!` rather than
  // a redundant runtime guard, because a guard here could never fire and would be
  // a branch nobody ever tests — which is exactly the kind of decoration this
  // repository's coverage numbers are meant to make visible.
  const currency = lines[0]!.unitPrice.currency;

  for (const line of lines) {
    if (typeof line.lineId !== "string" || line.lineId.trim() === "") {
      throw new Error(`Invoice has a line with a blank lineId; a charge nobody can name cannot be queried by the payer`);
    }
    if (seen.has(line.lineId)) {
      throw new Error(
        `Invoice lists line ${line.lineId} twice. A repeated lineId makes the arithmetic ambiguous and gives a partner two figures for the same charge.`,
      );
    }
    seen.add(line.lineId);

    if (typeof line.description !== "string" || line.description.trim() === "") {
      throw new Error(
        `Invoice line ${line.lineId} has a blank description; a charge nobody can identify on a statement is a charge that gets queried`,
      );
    }
    assertQuantity(line.quantity, line.lineId);

    if (line.unitPrice.currency !== currency) {
      throw new Error(
        `Invoice line ${line.lineId} has currency ${line.unitPrice.currency} but another line has ${currency}. An invoice is a legal document addressed to one payer in one currency; a journal may convert because it has two sides that must balance, and an invoice has no second side for a conversion to balance against. Convert deliberately upstream, with a stated rate (ADR-0003).`,
      );
    }
  }

  return currency;
}

function assertQuantity(quantity: number, lineId: string): void {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error(
      `Invoice line ${lineId} has quantity ${String(quantity)}; expected a non-negative integer. A negative quantity is a credit pretending to be a charge, and a fractional one would need a rounding rule for unitPrice × quantity.`,
    );
  }
}