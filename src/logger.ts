import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogRecord {
  timestamp: string; // ISO 8601 string
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface LoggerOptions {
  level?: LogLevel;
  logFile?: string;
  format?: "pretty" | "json";
  useColor?: boolean;
  onLog?: (record: LogRecord) => void;
}

export interface ScopedLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface BridgeLogger {
  readonly level: LogLevel;
  readonly options: Readonly<LoggerOptions>;
  debug(scope: string, message: string, meta?: Record<string, unknown>): void;
  info(scope: string, message: string, meta?: Record<string, unknown>): void;
  warn(scope: string, message: string, meta?: Record<string, unknown>): void;
  error(scope: string, message: string, meta?: Record<string, unknown>): void;
  child(scope: string): ScopedLogger;
  close(): Promise<void>;
}

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

function visibleWidth(str: string): number {
  return stripAnsi(str).length;
}

function padEndVisible(str: string, targetWidth: number): string {
  const vLen = visibleWidth(str);
  if (vLen >= targetWidth) return str;
  return str + " ".repeat(targetWidth - vLen);
}

export function createLogger(options: LoggerOptions = {}): BridgeLogger {
  const envLevel = process.env.AGENT_BRIDGE_LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  const level: LogLevel =
    options.level ??
    (envLevel && envLevel in LEVEL_SEVERITY ? envLevel : "info");

  const logFilePath = options.logFile ?? process.env.AGENT_BRIDGE_LOG_FILE;
  const envFormat = process.env.AGENT_BRIDGE_LOG_FORMAT?.toLowerCase();
  const format: "pretty" | "json" =
    options.format ??
    (envFormat === "json" ? "json" : "pretty");

  const useColor =
    options.useColor ??
    (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

  const c = {
    bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
    green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
    red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
    yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
    cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
    magenta: (s: string) => (useColor ? `\x1b[35m${s}\x1b[0m` : s),
    dim: (s: string) => (useColor ? `\x1b[90m${s}\x1b[0m` : s)
  };

  let fileStream: WriteStream | undefined;
  if (logFilePath) {
    try {
      mkdirSync(dirname(logFilePath), { recursive: true });
      fileStream = createWriteStream(logFilePath, { flags: "a", encoding: "utf8" });
      fileStream.on("error", (err) => {
        process.stderr.write(`[agent-bridge logger file error] ${err.message}\n`);
      });
    } catch (err) {
      process.stderr.write(
        `[agent-bridge logger] Failed to open log file ${logFilePath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }

  const formatPretty = (record: LogRecord): string => {
    const timeStr = new Date(record.timestamp).toLocaleTimeString();

    if (record.scope === "http" && record.meta) {
      const status = Number(record.meta.status ?? 200);
      const statusColor =
        status < 300 ? c.green : status < 400 ? c.cyan : status < 500 ? c.yellow : c.red;
      const statusStr = statusColor(String(status));
      const methodStr = c.bold(padEndVisible(String(record.meta.method ?? "GET"), 4));
      const pathStr = padEndVisible(String(record.meta.path ?? "/"), 23);
      const adapterStr = record.meta.adapter ? c.cyan(`[${record.meta.adapter}]`) : "";
      const modelStr = record.meta.model ? c.bold(String(record.meta.model)) : "";
      const streamStr = record.meta.stream ? c.dim("(stream)") : "";
      const durationStr = record.meta.durationMs != null ? c.dim(`${record.meta.durationMs}ms`) : "";
      const errorStr = record.meta.error ? c.red(`(${record.meta.error})`) : "";
      const details = [adapterStr, modelStr, streamStr, errorStr].filter(Boolean).join(" ");
      return `${c.dim(timeStr)}  ${methodStr} ${pathStr} ${statusStr}  ${details}  ${durationStr}`;
    }

    let badge = c.dim("INFO ");
    if (record.level === "debug") badge = c.magenta("DEBUG");
    else if (record.level === "warn") badge = c.yellow("WARN ");
    else if (record.level === "error") badge = c.red("ERROR");

    const scopeStr = c.cyan(`[${record.scope}]`);
    let out = `${c.dim(timeStr)}  ${badge} ${scopeStr} ${record.message}`;
    if (record.meta && Object.keys(record.meta).length > 0) {
      out += ` ${c.dim(JSON.stringify(record.meta))}`;
    }
    return out;
  };

  const dispatch = (
    lvl: "debug" | "info" | "warn" | "error",
    scope: string,
    message: string,
    meta?: Record<string, unknown>
  ) => {
    if (LEVEL_SEVERITY[lvl] < LEVEL_SEVERITY[level]) return;

    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level: lvl,
      scope,
      message,
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {})
    };

    // 1. External callback (for host app embedding, e.g. custom logger / Winston)
    if (options.onLog) {
      try {
        options.onLog(record);
      } catch {}
    }

    // 2. File output (standard JSON Lines for ingestion or forensic analysis)
    if (fileStream && fileStream.writable) {
      try {
        fileStream.write(JSON.stringify(record) + "\n");
      } catch {}
    }

    // 3. Console output
    if (level !== "silent") {
      if (format === "json") {
        const stream = lvl === "error" ? process.stderr : process.stdout;
        stream.write(JSON.stringify(record) + "\n");
      } else {
        const formatted = formatPretty(record);
        if (lvl === "error") {
          console.error(formatted);
        } else {
          console.log(formatted);
        }
      }
    }
  };

  return {
    get level() {
      return level;
    },
    get options() {
      return options;
    },
    debug: (scope, message, meta) => dispatch("debug", scope, message, meta),
    info: (scope, message, meta) => dispatch("info", scope, message, meta),
    warn: (scope, message, meta) => dispatch("warn", scope, message, meta),
    error: (scope, message, meta) => dispatch("error", scope, message, meta),
    child(scope: string): ScopedLogger {
      return {
        debug: (message, meta) => dispatch("debug", scope, message, meta),
        info: (message, meta) => dispatch("info", scope, message, meta),
        warn: (message, meta) => dispatch("warn", scope, message, meta),
        error: (message, meta) => dispatch("error", scope, message, meta)
      };
    },
    async close() {
      if (fileStream) {
        await new Promise<void>((resolve) => {
          fileStream!.end(() => resolve());
        });
        fileStream = undefined;
      }
    }
  };
}
