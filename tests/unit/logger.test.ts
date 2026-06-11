import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { log, createLogger, type LogLevel } from "../../core/logger";

/**
 * Capture lines written to process.stderr during the callback.
 */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // @ts-ignore — patching for test capture
  process.stderr.write = (chunk: string | Uint8Array) => {
    const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    lines.push(...str.split("\n").filter(Boolean));
    return true;
  };
  try {
    fn();
  } finally {
    // @ts-ignore
    process.stderr.write = original;
  }
  return lines;
}

describe("log()", () => {
  const origLogLevel = process.env.LOG_LEVEL;
  const origAgentId = process.env.AGENT_ID;
  const origTraceId = process.env.OTEL_TRACE_ID;

  beforeEach(() => {
    // Force emit in test env by setting LOG_LEVEL=debug
    process.env.LOG_LEVEL = "debug";
    process.env.AGENT_ID = "test-agent-42";
    delete process.env.OTEL_TRACE_ID;
  });

  afterEach(() => {
    if (origLogLevel !== undefined) process.env.LOG_LEVEL = origLogLevel;
    else delete process.env.LOG_LEVEL;
    if (origAgentId !== undefined) process.env.AGENT_ID = origAgentId;
    else delete process.env.AGENT_ID;
    if (origTraceId !== undefined) process.env.OTEL_TRACE_ID = origTraceId;
    else delete process.env.OTEL_TRACE_ID;
  });

  it("writes valid JSON to stderr", () => {
    const lines = captureStderr(() => {
      log("info", "test.event");
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.level).toBe("info");
    expect(record.event).toBe("test.event");
    expect(record.agent_id).toBe("test-agent-42");
    expect(typeof record.ts).toBe("string");
    // ts should be a valid ISO date
    expect(() => new Date(record.ts)).not.toThrow();
  });

  it("includes data fields at top level", () => {
    const lines = captureStderr(() => {
      log("warn", "test.data", { foo: "bar", count: 3 });
    });
    const record = JSON.parse(lines[0]);
    expect(record.foo).toBe("bar");
    expect(record.count).toBe(3);
  });

  it("includes optional message field when provided", () => {
    const lines = captureStderr(() => {
      log("error", "test.msg", undefined, "something went wrong");
    });
    const record = JSON.parse(lines[0]);
    expect(record.message).toBe("something went wrong");
  });

  it("omits message field when not provided", () => {
    const lines = captureStderr(() => {
      log("info", "test.nomsg");
    });
    const record = JSON.parse(lines[0]);
    expect("message" in record).toBe(false);
  });

  it("includes trace_id when OTEL_TRACE_ID is set", () => {
    process.env.OTEL_TRACE_ID = "abc123";
    const lines = captureStderr(() => {
      log("info", "test.trace");
    });
    const record = JSON.parse(lines[0]);
    expect(record.trace_id).toBe("abc123");
  });

  it("omits trace_id when OTEL_TRACE_ID is not set", () => {
    const lines = captureStderr(() => {
      log("info", "test.notrace");
    });
    const record = JSON.parse(lines[0]);
    expect("trace_id" in record).toBe(false);
  });

  it("unknown data fields pass through without modification", () => {
    const lines = captureStderr(() => {
      log("debug", "test.passthrough", {
        gen_ai_system: "anthropic",
        custom_nested: { a: 1 },
        arr: [1, 2, 3],
      });
    });
    const record = JSON.parse(lines[0]);
    expect(record.gen_ai_system).toBe("anthropic");
    expect(record.custom_nested).toEqual({ a: 1 });
    expect(record.arr).toEqual([1, 2, 3]);
  });
});

describe("createLogger()", () => {
  const origLogLevel = process.env.LOG_LEVEL;
  const origAgentId = process.env.AGENT_ID;

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    process.env.AGENT_ID = "test-agent-99";
  });

  afterEach(() => {
    if (origLogLevel !== undefined) process.env.LOG_LEVEL = origLogLevel;
    else delete process.env.LOG_LEVEL;
    if (origAgentId !== undefined) process.env.AGENT_ID = origAgentId;
    else delete process.env.AGENT_ID;
  });

  it("namespaces events with component prefix", () => {
    const logger = createLogger("router");
    const lines = captureStderr(() => {
      logger.info("start", { req_id: "r1" });
    });
    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("router.start");
  });

  it("exposes info/warn/error/debug methods", () => {
    const logger = createLogger("fanout");
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    for (const level of levels) {
      const lines = captureStderr(() => {
        logger[level]("check");
      });
      const record = JSON.parse(lines[0]);
      expect(record.level).toBe(level);
      expect(record.event).toBe("fanout.check");
    }
  });
});

describe("test environment suppression", () => {
  const origLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (origLogLevel !== undefined) process.env.LOG_LEVEL = origLogLevel;
    else delete process.env.LOG_LEVEL;
  });

  it("suppresses output when NODE_ENV=test and LOG_LEVEL is not debug", () => {
    delete process.env.LOG_LEVEL;
    // VITEST=1 is already set when tests run, so this tests the suppression path
    const lines = captureStderr(() => {
      log("info", "should.be.suppressed");
      log("warn", "warn.suppressed");
      log("debug", "debug.suppressed");
    });
    expect(lines).toHaveLength(0);
  });

  it("emits output when LOG_LEVEL=debug even in test env", () => {
    process.env.LOG_LEVEL = "debug";
    const lines = captureStderr(() => {
      log("info", "visible.in.debug");
    });
    expect(lines).toHaveLength(1);
  });

  it("emits error level even without LOG_LEVEL override in test env", () => {
    delete process.env.LOG_LEVEL;
    const lines = captureStderr(() => {
      log("error", "error.always.visible");
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.level).toBe("error");
  });
});
