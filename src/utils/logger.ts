import type { Config } from "../config.js";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type Level = keyof typeof LEVELS;

/**
 * Structured stderr logger. stdout is reserved for the MCP stdio framing, so
 * nothing may ever be written there.
 *
 * Values are redacted defensively: even though this server holds no
 * credentials, a future authenticated client must not be able to log one by
 * accident, so any field whose key looks secret is replaced before serialising.
 */
const SECRET_KEY = /(token|secret|password|cookie|authorization|api[-_]?key|bearer)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  error(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(config: Pick<Config, "logLevel">): Logger {
  const threshold = LEVELS[config.logLevel];

  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] > threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };

  return {
    error: (m, f) => emit("error", m, f),
    warn: (m, f) => emit("warn", m, f),
    info: (m, f) => emit("info", m, f),
    debug: (m, f) => emit("debug", m, f),
  };
}
