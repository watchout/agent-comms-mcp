/**
 * Structured JSON logger for agent-comms-mcp.
 *
 * Writes newline-delimited JSON records to stderr.
 * Compatible with OTel GenAI semantic conventions field naming.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  agent_id: string;
  trace_id?: string;
  message?: string;
  [key: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "1";
}

function effectiveMinLevel(): LogLevel {
  const override = (process.env.LOG_LEVEL ?? "").toLowerCase() as LogLevel;
  if (override in LEVEL_RANK) return override;
  if (isTestEnv()) return "error"; // suppress debug/info/warn in tests unless overridden
  return "info";
}

function shouldEmit(level: LogLevel): boolean {
  const minLevel = effectiveMinLevel();
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel];
}

/**
 * Core log function.
 *
 * @param level   - Severity level
 * @param event   - Machine-readable event name (e.g. "route.message.start")
 * @param data    - Additional structured fields (spread into the log record)
 * @param message - Human-readable message (optional)
 */
export function log(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>,
  message?: string,
): void {
  if (!shouldEmit(level)) return;

  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    event,
    agent_id: process.env.AGENT_ID ?? "unknown",
    ...data,
  };

  if (message !== undefined) {
    record.message = message;
  }

  const traceId = process.env.OTEL_TRACE_ID;
  if (traceId) {
    record.trace_id = traceId;
  }

  process.stderr.write(JSON.stringify(record) + "\n");
}

export interface Logger {
  debug(event: string, data?: Record<string, unknown>, message?: string): void;
  info(event: string, data?: Record<string, unknown>, message?: string): void;
  warn(event: string, data?: Record<string, unknown>, message?: string): void;
  error(event: string, data?: Record<string, unknown>, message?: string): void;
}

/**
 * Create a component-scoped logger.
 * Events are automatically namespaced: "<component>.<event>".
 */
export function createLogger(component: string): Logger {
  const ns = (event: string) => `${component}.${event}`;
  return {
    debug: (event, data?, message?) => log("debug", ns(event), data, message),
    info: (event, data?, message?) => log("info", ns(event), data, message),
    warn: (event, data?, message?) => log("warn", ns(event), data, message),
    error: (event, data?, message?) => log("error", ns(event), data, message),
  };
}
