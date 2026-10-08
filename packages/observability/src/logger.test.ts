import { describe, expect, it } from "vitest";

import { consoleSink, createLogger, type LogRecord, type Logger, type LogSink } from "./logger.js";
import { withCorrelationContext, currentCorrelationId, type CorrelationContext } from "./context.js";

function capture(): { sink: LogSink; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, sink: (record) => { records.push(record); } };
}

describe("logger", () => {
  it("emits a structured record with level, message and timestamp", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "info" });

    log.info("something happened");

    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("info");
    expect(records[0]!.message).toBe("something happened");
    expect(typeof records[0]!.timestamp).toBe("string");
  });

  it("drops records below the configured level", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "warn" });

    log.debug("noise");
    log.info("noise");
    log.warn("kept");
    log.error("kept");

    expect(records.map((r) => r.message)).toEqual(["kept", "kept"]);
  });

  it("attaches structured context to every record", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "info" });

    log.info("event", { orgId: "org-1", userId: "user-9", durationMs: 12 });

    expect(records[0]!.context).toMatchObject({ orgId: "org-1", userId: "user-9", durationMs: 12 });
  });

  it("merges base context into every record", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "info", base: { service: "web" } });

    log.info("a");
    log.info("b", { extra: 1 });

    expect(records[0]!.context).toMatchObject({ service: "web" });
    expect(records[1]!.context).toMatchObject({ service: "web", extra: 1 });
  });

  it("captures an Error thrown by a caller, including its stack", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "error" });

    log.error("failed", { error: new Error("boom") });

    // Serialised to a plain object deliberately: Error.message and Error.stack are
    // non-enumerable, so a raw Error would serialise to `{}` through a JSON sink.
    const { error } = records[0]!.context as { error: Record<string, unknown> };
    expect(error["name"]).toBe("Error");
    expect(error["message"]).toBe("boom");
    expect(typeof error["stack"]).toBe("string");
  });

  it("survives JSON serialisation of every record", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "info" });

    log.info("serialisable", { error: new Error("boom"), big: 10n });

    expect(() => JSON.stringify(records[0])).not.toThrow();
    expect(JSON.parse(JSON.stringify(records[0]!)).context.big).toBe("10");
  });

  it("redacts values whose key looks like a secret", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "info" });

    log.info("auth", {
      password: "hunter2",
      apiKey: "sk-live-123",
      authorization: "Bearer abc",
      safeField: "visible",
    });

    const context = records[0]!.context as Record<string, unknown>;
    expect(context["password"]).toBe("[redacted]");
    expect(context["apiKey"]).toBe("[redacted]");
    expect(context["authorization"]).toBe("[redacted]");
    expect(context["safeField"]).toBe("visible");
  });

  it("redacts secret-shaped values nested inside objects", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "info" });

    log.info("nested", { user: { token: "abc123", name: "ok" } });

    const context = records[0]!.context as { user: Record<string, unknown> };
    expect(context.user["token"]).toBe("[redacted]");
    expect(context.user["name"]).toBe("ok");
  });

  it("redacts secret-shaped values inside arrays", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "info" });

    log.info("list", { items: [{ secret: "x" }, { ok: "y" }] });

    const context = records[0]!.context as { items: Record<string, unknown>[] };
    expect(context.items[0]!["secret"]).toBe("[redacted]");
    expect(context.items[1]!["ok"]).toBe("y");
  });

  it("does not recurse forever on circular context", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "info" });

    const circular: Record<string, unknown> = { name: "loop" };
    circular["self"] = circular;

    expect(() => log.info("circular", { circular })).not.toThrow();
    expect(records).toHaveLength(1);
  });

  it("attaches the ambient correlation id to every record", () => {
    const { sink, records } = capture();
    const log = createLogger({ sink, level: "info" });
    const ctx: CorrelationContext = { correlationId: "corr-123", orgId: "org-7" };

    withCorrelationContext(ctx, () => log.info("inside"));

    expect(records[0]!.context).toMatchObject({ correlationId: "corr-123", orgId: "org-7" });
  });

  it("derives a child logger that adds context without mutating the parent", () => {
    const { sink, records } = capture();
    const parent = createLogger({ sink, level: "info", base: { service: "web" } });
    const child: Logger = parent.child({ requestId: "req-1" });

    child.info("child");
    parent.info("parent");

    expect(records[0]!.context).toMatchObject({ service: "web", requestId: "req-1" });
    expect(records[1]!.context).toMatchObject({ service: "web" });
    expect(records[1]!.context).not.toHaveProperty("requestId");
  });

  it("survives a sink that throws, because a logging failure must not break the app", () => {
    const log = createLogger({
      level: "info",
      sink: () => {
        throw new Error("sink is down");
      },
    });

    expect(() => log.info("still fine")).not.toThrow();
  });
});

describe("consoleSink", () => {
  it("writes errors to stderr and everything else to stdout", () => {
    const out: string[] = [];
    const err: string[] = [];
    const originalOut = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;

    try {
      consoleSink({ level: "info", message: "fine", timestamp: "t" });
      consoleSink({ level: "error", message: "bad", timestamp: "t" });
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('"message":"fine"');
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('"message":"bad"');
  });
});

describe("correlation context", () => {
  it("has no ambient id outside a scope", () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it("exposes the ambient id inside a scope", () => {
    withCorrelationContext({ correlationId: "abc" }, () => {
      expect(currentCorrelationId()).toBe("abc");
    });
  });

  it("restores the previous scope afterwards", () => {
    withCorrelationContext({ correlationId: "outer" }, () => {
      withCorrelationContext({ correlationId: "inner" }, () => {
        expect(currentCorrelationId()).toBe("inner");
      });
      expect(currentCorrelationId()).toBe("outer");
    });
  });

  it("isolates concurrent scopes from each other", async () => {
    const seen = await Promise.all([
      new Promise<string | undefined>((resolve) => {
        withCorrelationContext({ correlationId: "one" }, () => {
          setTimeout(() => resolve(currentCorrelationId()), 5);
        });
      }),
      new Promise<string | undefined>((resolve) => {
        withCorrelationContext({ correlationId: "two" }, () => {
          setTimeout(() => resolve(currentCorrelationId()), 5);
        });
      }),
    ]);

    expect(seen.sort()).toEqual(["one", "two"]);
  });

  it("clears the scope even when the body throws", () => {
    expect(() =>
      withCorrelationContext({ correlationId: "doomed" }, () => {
        throw new Error("body failed");
      }),
    ).toThrow(/body failed/);

    expect(currentCorrelationId()).toBeUndefined();
  });
});