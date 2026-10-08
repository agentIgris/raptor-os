/**
 * Structured logging.
 *
 * The legacy application set `compiler.removeConsole` for production, which stripped
 * every `console.*` call from the emitted JavaScript on both server and client. The
 * practical effect was that a shipped `ReferenceError`, nine endpoints broken by RLS
 * changes, and every failed sign-in left no trace. Diagnostics are only useful if they
 * survive to production, so logging is structured and **never stripped**.
 *
 * Three properties this logger guarantees:
 *  1. Every record carries the ambient correlation id, so a user report can be matched
 *     to server-side events.
 *  2. Secret-shaped values are redacted before they reach a sink.
 *  3. A failing sink can never break the caller.
 */

import { currentCorrelationContext } from "./context.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: string;
  readonly context?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  readonly sink: LogSink;
  readonly level?: LogLevel;
  readonly base?: Record<string, unknown>;
}

/** Context keys whose values must never be written to a log sink. */
const SECRET_KEY_PATTERN = /(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?id|password[-_]?hash)/i;

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

/** Write JSON to stdout/stderr. The default sink. */
export const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const base: Record<string, unknown> = options.base ?? {};

  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;

    try {
      const ambient = currentCorrelationContext();
      const merged = {
        ...base,
        ...(ambient
          ? {
              correlationId: ambient.correlationId,
              orgId: ambient.orgId,
              personId: ambient.personId,
            }
          : {}),
        ...(context ?? {}),
      };

      const safe = redact(merged);

      options.sink({ level, message, timestamp: new Date().toISOString(), context: safe as Record<string, unknown> });
    } catch {
      // A logging failure must never propagate into the request path.
    }
  };

  const logger: Logger = {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    child: (childContext) =>
      createLogger({ sink: options.sink, level: options.level, base: { ...base, ...childContext } }),
  };

  return logger;
}

/** The process-wide default logger. Replaced in tests. */
export const logger: Logger = createLogger({
  sink: consoleSink,
  level: (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info",
  base: { service: process.env["OTEL_SERVICE_NAME"] ?? "raptor-os" },
});

function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;

  if (depth >= MAX_DEPTH) return "[max depth]";

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1, seen);
  }
  return out;
}