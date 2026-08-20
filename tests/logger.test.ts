import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLogger,
  createAgentBridge,
  startAgentBridge,
  type LogRecord
} from "../src/index.js";

describe("unified bridge logger", () => {
  test("filters logs based on log level", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      level: "warn",
      useColor: false,
      onLog: (rec) => records.push(rec)
    });

    logger.debug("test", "this is debug");
    logger.info("test", "this is info");
    logger.warn("test", "this is warn");
    logger.error("test", "this is error");

    expect(records).toHaveLength(2);
    expect(records[0]?.level).toBe("warn");
    expect(records[1]?.level).toBe("error");
  });

  test("supports scoped child loggers", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      level: "debug",
      useColor: false,
      onLog: (rec) => records.push(rec)
    });

    const child = logger.child("adapter.antigravity");
    child.debug("starting process", { pid: 1234 });

    expect(records).toHaveLength(1);
    expect(records[0]?.scope).toBe("adapter.antigravity");
    expect(records[0]?.message).toBe("starting process");
    expect(records[0]?.meta?.pid).toBe(1234);
  });

  test("writes structured JSON Lines to log file and flushes on close", async () => {
    const testLogFile = join(tmpdir(), `agent-bridge-test-${Date.now()}.log`);

    try {
      const logger = createLogger({
        level: "info",
        logFile: testLogFile,
        useColor: false
      });

      logger.info("system", "bridge started", { port: 3457 });
      logger.info("http", "GET /health 200", { method: "GET", path: "/health", status: 200, durationMs: 1 });

      await logger.close();

      expect(existsSync(testLogFile)).toBe(true);
      const content = readFileSync(testLogFile, "utf8").trim();
      const lines = content.split("\n").map((l) => JSON.parse(l));

      expect(lines).toHaveLength(2);
      expect(lines[0].scope).toBe("system");
      expect(lines[0].message).toBe("bridge started");
      expect(lines[0].meta.port).toBe(3457);
      expect(lines[1].scope).toBe("http");
      expect(lines[1].meta.status).toBe(200);
    } finally {
      if (existsSync(testLogFile)) {
        rmSync(testLogFile, { force: true });
      }
    }
  });

  test("embed mode logs HTTP requests through unified logger", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      level: "info",
      useColor: false,
      onLog: (rec) => records.push(rec)
    });

    const bridge = await startAgentBridge({
      controlToken: "test-control",
      preloadModels: false,
      logger
    });

    try {
      const res = await fetch(`${bridge.baseUrl}/health`);
      expect(res.status).toBe(200);

      // Allow event loop to process finish event
      await new Promise((r) => setTimeout(r, 50));

      const httpLogs = records.filter((r) => r.scope === "http");
      expect(httpLogs.length).toBeGreaterThanOrEqual(1);
      expect(httpLogs[0]?.meta?.path).toBe("/health");
      expect(httpLogs[0]?.meta?.status).toBe(200);
    } finally {
      await bridge.close();
    }
  });
});
