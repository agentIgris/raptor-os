import { AsyncLocalStorage } from "node:async_hooks";

export interface CorrelationContext {
  /** Ties every log line, event, notification and audit record to one request. */
  readonly correlationId: string;
  readonly orgId?: string;
  readonly personId?: string;
  readonly sessionId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Run `fn` with a correlation context that is automatically attached to every log
 * record produced while it executes, and to every async operation it starts.
 *
 * Backed by AsyncLocalStorage, so concurrent requests never observe each other's
 * context — verified by test.
 */
export function withCorrelationContext<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The correlation context for the current async execution, if any. */
export function currentCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

/** Just the id, which is what most call sites need. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}