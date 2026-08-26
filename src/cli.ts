#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import {
  capabilityToken,
  createAgentBridge,
  createLogger,
  listen,
  type AdapterCapability,
  type AdapterId,
  type LogLevel
} from "./index.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string; description: string };

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const c = {
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[90m${s}\x1b[0m` : s)
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

function showHelp() {
  console.log(`
${c.bold(pkg.name)} v${pkg.version}
${pkg.description}

${c.bold("Usage:")}
  npx @aotterclam/agent-bridge [options]
  bunx @aotterclam/agent-bridge [options]

${c.bold("Options:")}
  -p, --port <number>         Port to listen on (default: 3457 or AGENT_BRIDGE_PORT)
  -t, --token <string>        Control token for discovery (default: AGENT_BRIDGE_CONTROL_TOKEN or 'local-development-only')
  -l, --log-level <level>     Log verbosity: debug | info | warn | error | silent (default: info)
  -d, --debug                 Shortcut for --log-level debug
  -f, --log-file <path>       Append logs to specified file path
      --format <pretty|json>  Log formatting style (default: pretty)
  -q, --quiet                 Suppress banner and discovery logs (sets log-level to silent)
  -v, --version               Show version number
  -h, --help                  Show this help message

${c.bold("Environment Variables:")}
  AGENT_BRIDGE_PORT                   Default listener port (default: 3457)
  AGENT_BRIDGE_CONTROL_TOKEN          Default discovery token (default: local-development-only)
  AGENT_BRIDGE_LOG_LEVEL              Log verbosity level (default: info)
  AGENT_BRIDGE_LOG_FILE               Destination file path for logging
  AGENT_BRIDGE_LOG_FORMAT             Log output format: pretty | json
  AGENT_BRIDGE_ANTIGRAVITY_COMMAND    Path to Antigravity CLI executable (default: agy)
  AGENT_BRIDGE_CODEX_COMMAND          Path to Codex CLI executable (default: codex)
  AGENT_BRIDGE_GROK_COMMAND           Path to Grok CLI executable (default: grok)
  AGENT_BRIDGE_ANTIGRAVITY_TIMEOUT_MS Antigravity turn timeout in ms (default: 300000)
  AGENT_BRIDGE_CLAUDE_TIMEOUT_MS      Claude turn timeout in ms (default: 300000)
  AGENT_BRIDGE_CODEX_TIMEOUT_MS       Codex turn timeout in ms (default: 300000)
  AGENT_BRIDGE_GROK_TIMEOUT_MS        Grok turn timeout in ms (default: 300000)

${c.bold("Examples:")}
  npx @aotterclam/agent-bridge
  npx @aotterclam/agent-bridge --port 8080 --token secret-token
  npx @aotterclam/agent-bridge --debug --log-file ./agent-bridge.log
  npx @aotterclam/agent-bridge --format json
`);
}

function renderBanner(baseUrl: string, controlToken: string) {
  const tokenLine = `${c.bold("Control Token:")}  ${controlToken}`;
  const innerWidth = Math.max(59, visibleWidth(tokenLine));

  const lines = [
    c.bold(`Agent Bridge v${pkg.version}`),
    c.dim("Loopback OpenAI API for local coding agent runtimes"),
    "─".repeat(innerWidth),
    `${c.bold("API Base URL:")}   ${c.cyan(baseUrl + "/v1")}`,
    `${c.bold("Capabilities:")}   ${c.cyan(baseUrl + "/capabilities")}`,
    `${c.bold("Health check:")}   ${c.cyan(baseUrl + "/health")}`,
    tokenLine
  ];

  console.log(c.dim("┌" + "─".repeat(innerWidth + 2) + "┐"));
  for (const line of lines) {
    if (line.startsWith("─")) {
      console.log(c.dim("├" + "─".repeat(innerWidth + 2) + "┤"));
    } else {
      console.log(c.dim("│") + " " + padEndVisible(line, innerWidth) + " " + c.dim("│"));
    }
  }
  console.log(c.dim("└" + "─".repeat(innerWidth + 2) + "┘"));
}

function renderAdapterStatus(
  adapters: AdapterCapability[],
  baseUrl: string,
  controlToken: string
) {
  console.log(`\n${c.bold("Providers Status:")}`);
  for (const a of adapters) {
    const light = a.available ? c.green("● ONLINE ") : c.red("○ OFFLINE");
    const id = padEndVisible(c.cyan(a.id), 12);
    const name = padEndVisible(a.name, 16);
    const ver = padEndVisible(a.version ?? (a.available ? "installed" : "not found"), 26);
    const detail = a.available
      ? `(${a.models.length} model${a.models.length === 1 ? "" : "s"})`
      : c.dim(`(unavailable${a.error ? `: ${a.error}` : ""})`);
    console.log(`  ${light}  ${id} ${name} ${c.dim(ver)} ${detail}`);
  }

  const online = adapters.filter((a) => a.available);
  if (online.length > 0) {
    const w1 = 14;
    const w2 = 27;
    const w3 = 42;

    const topBorder = c.dim("┌" + "─".repeat(w1 + 2) + "┬" + "─".repeat(w2 + 2) + "┬" + "─".repeat(w3 + 2) + "┐");
    const headerDiv = c.dim("├" + "─".repeat(w1 + 2) + "┼" + "─".repeat(w2 + 2) + "┼" + "─".repeat(w3 + 2) + "┤");
    const rowDiv    = c.dim("├" + "─".repeat(w1 + 2) + "┼" + "─".repeat(w2 + 2) + "┼" + "─".repeat(w3 + 2) + "┤");
    const botBorder = c.dim("└" + "─".repeat(w1 + 2) + "┴" + "─".repeat(w2 + 2) + "┴" + "─".repeat(w3 + 2) + "┘");

    console.log(`\n${c.bold("Model & Parameter Catalog:")}`);
    console.log(topBorder);
    console.log(
      c.dim("│") +
      " " + padEndVisible(c.bold("Provider"), w1) + " " +
      c.dim("│") +
      " " + padEndVisible(c.bold("Model ID"), w2) + " " +
      c.dim("│") +
      " " + padEndVisible(c.bold("Reasoning Efforts"), w3) + " " +
      c.dim("│")
    );
    console.log(headerDiv);

    for (let i = 0; i < online.length; i++) {
      const a = online[i]!;
      for (let j = 0; j < a.models.length; j++) {
        const m = a.models[j]!;
        const col1 = j === 0 ? c.cyan(a.id) : "";
        const col2 = m.id;
        let efforts = m.reasoningEfforts
          .map((effort) =>
            effort === m.defaultReasoningEffort ? `${effort}*` : effort
          )
          .join(", ");
        if (efforts.length === 0) {
          efforts = c.dim("-");
        }

        console.log(
          c.dim("│") +
          " " + padEndVisible(col1, w1) + " " +
          c.dim("│") +
          " " + padEndVisible(col2, w2) + " " +
          c.dim("│") +
          " " + padEndVisible(efforts, w3) + " " +
          c.dim("│")
        );
      }
      if (i < online.length - 1) {
        console.log(rowDiv);
      }
    }
    console.log(botBorder);
    if (online.some((a) => a.models.some((m) => m.defaultReasoningEffort))) {
      console.log(c.dim("  * = default reasoning effort"));
    }

    // Quick cURL examples with real tokens
    console.log(`\n${c.bold("Ready-to-run cURL Examples:")}`);
    console.log(c.dim("# 1. Discover all adapters and capability tokens"));
    console.log(`curl -H "Authorization: Bearer ${controlToken}" ${baseUrl}/capabilities\n`);

    for (const a of online) {
      const token = capabilityToken(controlToken, a.id as AdapterId);
      const defaultModel = a.models[0]?.id ?? "default";
      console.log(c.dim(`# ${a.name} (${defaultModel})`));
      console.log(
        `curl ${baseUrl}/v1/chat/completions \\\n` +
        `  -H "Authorization: Bearer ${token}" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -d '{"model": "${defaultModel}", "messages": [{"role": "user", "content": "Hello!"}]}'\n`
      );
    }

    const first = online[0]!;
    const firstModel = first.models[0]?.id ?? "default";
    console.log(c.dim("# Every adapter also serves the stateless Responses API at /v1/responses:"));
    console.log(c.dim(`# same capability token, but the body takes "input" instead of "messages". E.g. ${first.name}:`));
    console.log(
      `curl ${baseUrl}/v1/responses \\\n` +
      `  -H "Authorization: Bearer ${capabilityToken(controlToken, first.id as AdapterId)}" \\\n` +
      `  -H "Content-Type: application/json" \\\n` +
      `  -d '{"model": "${firstModel}", "input": "Hello!"}'\n`
    );
  }

  console.log(`${c.green("✔")} Ready for OpenAI requests. Press ${c.bold("Ctrl+C")} to stop.\n`);
}

async function main() {
  let parsed: {
    values: {
      port?: string;
      token?: string;
      "log-level"?: string;
      debug?: boolean;
      "log-file"?: string;
      format?: string;
      quiet?: boolean;
      version?: boolean;
      help?: boolean;
    };
  };

  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        port: { type: "string", short: "p" },
        token: { type: "string", short: "t" },
        "log-level": { type: "string", short: "l" },
        debug: { type: "boolean", short: "d" },
        "log-file": { type: "string", short: "f" },
        format: { type: "string" },
        quiet: { type: "boolean", short: "q" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" }
      },
      allowPositionals: false
    }) as typeof parsed;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Run with --help to view available options.");
    process.exit(1);
  }

  const { values } = parsed;

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  if (values.version) {
    console.log(`${pkg.name} v${pkg.version}`);
    process.exit(0);
  }

  const port = values.port != null
    ? Number(values.port)
    : Number(process.env.AGENT_BRIDGE_PORT ?? 3457);

  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    console.error(`Error: Invalid port number "${values.port}". Must be 0-65535.`);
    process.exit(1);
  }

  const controlToken: string =
    values.token ??
    process.env.AGENT_BRIDGE_CONTROL_TOKEN ??
    "local-development-only";

  let logLevel: LogLevel = "info";
  if (values.quiet) {
    logLevel = "silent";
  } else if (values.debug) {
    logLevel = "debug";
  } else if (values["log-level"]) {
    const specified = values["log-level"].toLowerCase() as LogLevel;
    if (["debug", "info", "warn", "error", "silent"].includes(specified)) {
      logLevel = specified;
    } else {
      console.error(`Error: Invalid log level "${values["log-level"]}". Must be debug, info, warn, error, or silent.`);
      process.exit(1);
    }
  }

  const rawFormat = values.format ?? process.env.AGENT_BRIDGE_LOG_FORMAT ?? "pretty";
  const normalizedFormat = rawFormat.toLowerCase();
  if (normalizedFormat !== "pretty" && normalizedFormat !== "json") {
    console.error(`Error: Invalid format "${rawFormat}". Must be "pretty" or "json".`);
    process.exit(1);
  }
  const logFormat: "pretty" | "json" = normalizedFormat;

  const logger = createLogger({
    level: logLevel,
    logFile: values["log-file"],
    format: logFormat
  });

  const bridge = createAgentBridge({
    controlToken,
    preloadModels: true,
    logger
  });

  try {
    await listen(bridge, port);
  } catch (error) {
    console.error(`Failed to start agent bridge on port ${port}:`, error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const address = bridge.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  if (!values.quiet) {
    if (logFormat === "json") {
      logger.info("server", "Agent bridge server started", { port: actualPort, baseUrl });
      const adapters = await bridge.capabilities();
      logger.info("discovery", "Agent runtimes discovered", {
        adapters: adapters.map((a) => ({ id: a.id, name: a.name, available: a.available }))
      });
    } else {
      renderBanner(baseUrl, controlToken);

      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let frameIndex = 0;
      const isTTY = Boolean(process.stdout.isTTY);
      let timer: NodeJS.Timeout | undefined;

      if (isTTY) {
        process.stdout.write("\n");
        timer = setInterval(() => {
          const icon = c.cyan(frames[frameIndex++ % frames.length]!);
          process.stdout.write(`\r${icon} Discovering local coding agent runtimes...`);
        }, 80);
      } else {
        console.log("\n◐ Discovering local coding agent runtimes...");
      }

      const adapters = await bridge.capabilities();

      if (timer) clearInterval(timer);
      if (isTTY) process.stdout.write("\r" + " ".repeat(60) + "\r");

      renderAdapterStatus(adapters, baseUrl, controlToken);
    }
  }

  const shutdown = async () => {
    if (!values.quiet && logFormat !== "json") {
      console.log("\nShutting down Agent Bridge...");
    }
    await bridge.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main();
