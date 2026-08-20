import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  promptFor,
  selectedTools,
  type ChatRequest,
  type ChatRunner,
  type ChatTurn
} from "./protocol.js";

const exec = promisify(execFile);
const DEFAULT_ANTIGRAVITY_TURN_TIMEOUT_MS = 300_000;

function command() {
  return resolveCommand(process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND ?? "agy");
}

function resolveCommand(cmd: string): string {
  if (process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND) return process.env.AGENT_BRIDGE_ANTIGRAVITY_COMMAND;
  const home = homedir();
  const candidates = [
    join(home, ".local/bin", cmd),
    join(home, ".gemini/antigravity/bin", cmd),
    join("/opt/homebrew/bin", cmd),
    join("/usr/local/bin", cmd)
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return cmd;
}

export function antigravityTurnTimeoutMs(
  value = process.env.AGENT_BRIDGE_ANTIGRAVITY_TIMEOUT_MS
) {
  if (value === undefined) return DEFAULT_ANTIGRAVITY_TURN_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error(
      "AGENT_BRIDGE_ANTIGRAVITY_TIMEOUT_MS must be a positive integer"
    );
  }
  return timeout;
}

export function antigravityEnvironment(isolatedHome: string) {
  const env: Record<string, string> = {
    HOME: isolatedHome,
    TMPDIR: isolatedHome
  };
  for (const key of [
    "PATH",
    "SHELL",
    "USER",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS"
  ]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

export async function prepareIsolatedAntigravityHome(isolatedDir: string): Promise<string> {
  const fakeHome = join(isolatedDir, "home");
  const fakeGemini = join(fakeHome, ".gemini");
  const fakeCli = join(fakeGemini, "antigravity-cli");
  await mkdir(fakeCli, { recursive: true });

  const realHome = homedir();

  // 1. Provision minimum top-level auth credentials (never copy entire directory or user allow rules)
  for (const f of ["oauth_creds.json", "google_accounts.json", "jetski-standalone-oauth-token", "state.json"]) {
    const p = join(realHome, ".gemini", f);
    if (existsSync(p)) {
      try {
        await symlink(p, join(fakeGemini, f));
      } catch {}
    }
  }

  // 2. Provision minimum CLI auth credentials and runtime binaries
  for (const f of ["antigravity-oauth-token", "jetski_state.pbtxt", "installation_id", "bin", "builtin"]) {
    const p = join(realHome, ".gemini", "antigravity-cli", f);
    if (existsSync(p)) {
      try {
        await symlink(p, join(fakeCli, f));
      } catch {}
    }
  }

  // 3. Write isolated settings with explicit deny rules for built-in tools and empty MCP
  const isolatedSettings = JSON.stringify({
    permissions: {
      auto_approve: false,
      denied_tools: ["*"],
      allow_rules: []
    },
    tools: {
      enabled: false
    },
    mcp: {
      servers: {}
    }
  }, null, 2);

  await writeFile(join(fakeGemini, "settings.json"), isolatedSettings);
  await writeFile(join(fakeCli, "settings.json"), isolatedSettings);

  return fakeHome;
}

const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type AntigravityModelSpec = {
  id: string;
  name: string;
  rawName: string;
  reasoningEfforts: readonly string[];
  defaultReasoningEffort?: string;
  effortSlugs: Record<string, string>;
  defaultCliSlug: string;
};

const STATIC_MODELS: readonly AntigravityModelSpec[] = [
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    rawName: "Gemini 3.7 Flash",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
    effortSlugs: {
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high"
    },
    defaultCliSlug: "gemini-3.7-flash-high"
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    rawName: "Gemini 3.6 Flash",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
    effortSlugs: {
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high"
    },
    defaultCliSlug: "gemini-3.6-flash-high"
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    rawName: "Gemini 3.5 Flash",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
    effortSlugs: {
      low: "gemini-3.5-flash-low",
      medium: "gemini-3.5-flash-medium",
      high: "gemini-3.5-flash-high"
    },
    defaultCliSlug: "gemini-3.5-flash-high"
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    rawName: "Gemini 3.1 Pro",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
    effortSlugs: {
      low: "gemini-3.1-pro-low",
      high: "gemini-3.1-pro-high"
    },
    defaultCliSlug: "gemini-3.1-pro-high"
  },
  {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    rawName: "Claude Sonnet 4.6",
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    effortSlugs: {
      high: "claude-sonnet-4-6"
    },
    defaultCliSlug: "claude-sonnet-4-6"
  },
  {
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    rawName: "Claude Opus 4.6",
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
    effortSlugs: {
      high: "claude-opus-4-6-thinking"
    },
    defaultCliSlug: "claude-opus-4-6-thinking"
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    rawName: "GPT-OSS 120B",
    reasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
    effortSlugs: {
      medium: "gpt-oss-120b-medium"
    },
    defaultCliSlug: "gpt-oss-120b-medium"
  }
];

let discoveredCatalog: AntigravityModelSpec[] = [...STATIC_MODELS];

export function getDiscoveredCatalog(): AntigravityModelSpec[] {
  return discoveredCatalog;
}

export function setDiscoveredCatalog(catalog: AntigravityModelSpec[]) {
  discoveredCatalog = catalog;
}

export function parseAgyModels(output: string): AntigravityModelSpec[] {
  const modelsMap = new Map<string, {
    rawBaseName: string;
    efforts: Set<string>;
    effortSlugs: Record<string, string>;
    cliSlugs: string[];
  }>();

  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (
      !trimmed ||
      trimmed.toLowerCase().startsWith("fetching") ||
      trimmed.toLowerCase().startsWith("available models")
    ) {
      continue;
    }

    const parts = trimmed.split(/\t+/);
    const cliSlug = parts.length > 1 ? parts[0]!.trim() : "";
    const text = (parts.length > 1 ? parts[1]! : parts[0]!).trim();

    const match = text.match(/^([A-Za-z0-9\s.-]+?)(?:\s*\((Low|Medium|High|Thinking)\))?$/i);
    if (!match) continue;

    const baseName = match[1]!.trim();
    const effortTag = match[2]?.toLowerCase();
    if (!baseName) continue;

    let entry = modelsMap.get(baseName);
    if (!entry) {
      entry = {
        rawBaseName: baseName,
        efforts: new Set(),
        effortSlugs: {},
        cliSlugs: []
      };
      modelsMap.set(baseName, entry);
    }
    if (cliSlug) {
      entry.cliSlugs.push(cliSlug);
    }
    const eff = effortTag === "thinking" ? "high" : effortTag;
    if (eff && REASONING_LEVELS.includes(eff as any)) {
      entry.efforts.add(eff);
      if (cliSlug) {
        entry.effortSlugs[eff] = cliSlug;
      }
    } else if (cliSlug) {
      entry.effortSlugs["default"] = cliSlug;
    }
  }

  if (modelsMap.size === 0) return [];

  return Array.from(modelsMap.entries()).map(([baseName, { rawBaseName, efforts, effortSlugs, cliSlugs }]) => {
    const slug = baseName
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, "-")
      .replace(/^-|-$/g, "");
    const reasoningEfforts = Array.from(efforts).sort(
      (a, b) => REASONING_LEVELS.indexOf(a as any) - REASONING_LEVELS.indexOf(b as any)
    );
    const defaultReasoningEffort = reasoningEfforts.includes("high")
      ? "high"
      : reasoningEfforts[0];
    const defaultCliSlug =
      (defaultReasoningEffort ? effortSlugs[defaultReasoningEffort] : undefined) ??
      effortSlugs["high"] ??
      cliSlugs[0] ??
      slug;

    return {
      id: slug,
      name: baseName,
      rawName: rawBaseName,
      reasoningEfforts,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      effortSlugs,
      defaultCliSlug
    };
  });
}

function normalizeSlug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function resolveAgyModel(
  requestedModel: string,
  requestedEffort?: string,
  catalog: readonly AntigravityModelSpec[] = discoveredCatalog.length > 0 ? discoveredCatalog : STATIC_MODELS
): string {
  const norm = requestedModel.toLowerCase().trim();
  const normSlug = normalizeSlug(requestedModel);

  // 1. Direct match with a known CLI slug across catalog (e.g. "gemini-3.7-flash-high" or "claude-opus-4-6-thinking")
  for (const m of catalog) {
    if (Object.values(m.effortSlugs).includes(requestedModel) || m.defaultCliSlug === requestedModel) {
      return requestedModel;
    }
  }

  // 2. Try matching in catalog by id / name / slug
  const spec = catalog.find(
    (m) =>
      m.id === norm ||
      m.name.toLowerCase() === norm ||
      normalizeSlug(m.id) === normSlug ||
      normalizeSlug(m.name) === normSlug ||
      normalizeSlug(m.rawName) === normSlug
  );

  if (spec) {
    const effort = requestedEffort?.toLowerCase() ?? spec.defaultReasoningEffort;
    if (effort && spec.effortSlugs[effort]) {
      return spec.effortSlugs[effort]!;
    }
    if (spec.defaultCliSlug) {
      return spec.defaultCliSlug;
    }
    const effortLabel =
      effort === "high"
        ? (spec.rawName.toLowerCase().includes("claude") ? "Thinking" : "High")
        : effort === "medium"
          ? "Medium"
          : effort === "low"
            ? "Low"
            : undefined;

    return effortLabel ? `${spec.rawName} (${effortLabel})` : spec.rawName;
  }

  // Fallback: If user specified effort, format as Model (Effort)
  if (requestedEffort) {
    const capitalized =
      requestedEffort.charAt(0).toUpperCase() + requestedEffort.slice(1).toLowerCase();
    return `${requestedModel} (${capitalized})`;
  }

  return requestedModel;
}

function queryAgy(args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = spawn(command(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cp.kill("SIGTERM");
      reject(new Error(`Antigravity query [${args.join(" ")}] timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    cp.stdout.on("data", (d) => { stdout += d.toString(); });
    cp.stderr.on("data", (d) => { stderr += d.toString(); });
    cp.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    cp.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Antigravity exited with code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

export async function detectAntigravity() {
  try {
    const [versionStdout, modelsStdout] = await Promise.all([
      queryAgy(["--version"], 5_000),
      queryAgy(["models"], 8_000).catch(() => "")
    ]);

    const version = versionStdout.trim().split("\n")[0] ?? "1.0.0";
    const models = parseAgyModels(modelsStdout);

    if (models.length === 0) {
      return {
        id: "antigravity" as const,
        name: "Antigravity",
        available: false,
        version,
        error: "No authorized models returned by Antigravity CLI",
        models: []
      };
    }

    discoveredCatalog = models;

    return {
      id: "antigravity" as const,
      name: "Antigravity",
      available: true,
      version,
      error: null,
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoningEfforts: m.reasoningEfforts,
        ...(m.defaultReasoningEffort
          ? { defaultReasoningEffort: m.defaultReasoningEffort }
          : {})
      }))
    };
  } catch (error) {
    return {
      id: "antigravity" as const,
      name: "Antigravity",
      available: false,
      version: null,
      error: error instanceof Error ? error.message : "Antigravity CLI unavailable.",
      models: []
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function recoverTextToolCall(
  content: string,
  tools: ChatRequest["tools"]
): ChatTurn["toolCalls"][number] | undefined {
  if (!tools.length) return;
  let text = content.trim();

  // Handle markdown ```json ... ``` blocks
  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlock) {
    text = jsonBlock[1]!.trim();
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Try to find raw JSON substring
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        value = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        return;
      }
    } else {
      return;
    }
  }

  const call = record(value);
  if (!tools.some(({ function: tool }) => tool.name === call.name)) return;
  let args = call.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    args = {};
  }
  return {
    id: `call-${crypto.randomUUID()}`,
    name: String(call.name),
    arguments: args as Record<string, unknown>
  };
}

export function completedAntigravityTurn(
  content: string,
  toolCalls: ChatTurn["toolCalls"],
  usage?: ChatTurn["usage"],
  tools: ChatRequest["tools"] = []
): ChatTurn {
  const recovered = !toolCalls.length ? recoverTextToolCall(content, tools) : undefined;
  const calls = recovered ? [recovered] : toolCalls;
  if (!content.trim() && !calls.length) {
    throw new Error("Antigravity bridge returned no assistant turn");
  }
  return {
    content: calls.length > 0 ? null : content,
    toolCalls: calls,
    finishReason: calls.length ? "tool_calls" : "stop",
    ...(usage ? { usage } : {})
  };
}

export function promptForAntigravity(input: ChatRequest) {
  const tools = selectedTools(input);
  const basePrompt = promptFor(input.messages, input.tool_choice);

  const sections = [
    "Produce exactly one assistant turn for this OpenAI chat transcript.",
    "IMPORTANT INSTRUCTION: You are acting strictly as an OpenAI LLM backend. Do NOT run commands, do NOT inspect files, do NOT browse, and do NOT use or call any built-in CLI tools or built-in functions."
  ];

  if (tools.length > 0) {
    sections.push(
      "The host application provides the following functions that you may call:",
      JSON.stringify(
        tools.map(({ function: tool }) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? { type: "object", properties: {} }
        })),
        null,
        2
      ),
      'If you decide to call a function, respond ONLY with a valid JSON object in the exact format:\n{"name": "<function_name>", "arguments": { ... }}\nDo NOT include markdown formatting, extra explanation, or commentary when calling a function.',
      "If you do not need to call a function, respond normally with your text answer."
    );
  } else {
    sections.push("Do not call any function. Reply with a regular text response.");
  }

  sections.push(basePrompt);
  return sections.join("\n\n");
}

export type ToolCall = ChatTurn["toolCalls"][number];
export type AntigravityUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
};

type RunOptions = NonNullable<Parameters<ChatRunner>[1]>;

const sessions = new Set<AntigravityAgentSession>();

export class AntigravityAgentSession {
  private child?: ChildProcessWithoutNullStreams;
  private cwd?: string;
  private timeout?: NodeJS.Timeout;
  private cleanup?: Promise<void>;
  private content = "";
  private usage: AntigravityUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };
  private stderr = "";

  static async create() {
    const session = new AntigravityAgentSession();
    sessions.add(session);
    return session;
  }

  private emitCall(
    call: ToolCall,
    options: RunOptions
  ) {
    options.onDelta?.({
      tool_calls: [
        {
          index: 0,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }
      ]
    });
  }

  async run(input: ChatRequest, options: RunOptions = {}): Promise<ChatTurn> {
    this.cwd = await mkdtemp(join(tmpdir(), "agent-bridge-antigravity-"));
    const fakeHome = await prepareIsolatedAntigravityHome(this.cwd);

    const tools = selectedTools(input);
    const catalog = discoveredCatalog.length > 0 ? discoveredCatalog : STATIC_MODELS;
    const resolvedModel = resolveAgyModel(input.model, input.reasoning_effort, catalog);

    const prompt = promptForAntigravity(input);

    const args = [
      "--sandbox",
      "--disable-slash-commands",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--model",
      resolvedModel
    ];

    const child = spawn(command(), args, {
      cwd: this.cwd,
      env: antigravityEnvironment(fakeHome),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    const timeoutMs = antigravityTurnTimeoutMs();
    
    let resolved = false;
    const fail = (err: Error) => {
        if (resolved) return;
        resolved = true;
        this.clearTimeout();
        reject(err);
        void this.close(err);
    };
    let resolve: (turn: ChatTurn) => void;
    let reject: (err: Error) => void;
    const promise = new Promise<ChatTurn>((res, rej) => { resolve = res; reject = rej; });

    this.timeout = setTimeout(() => {
      fail(new Error(`Antigravity turn timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    this.timeout.unref();

    const forwardAbort = () => {
      fail(new Error("Antigravity bridge aborted"));
    };
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });

    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });

    const lines = createInterface({ input: child.stdout });

    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (resolved) return;
      fail(
        new Error(
          `Antigravity closed without a successful completion (exit code: ${code ?? "null"}): ${this.stderr.slice(-1000)}`
        )
      );
    });

    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);

        // P1 Security: Reject any built-in tool execution step reported by AGY
        const step = record(event.step_update);
        if (step.tool_call || step.tool_name || step.tool || event.tool_call || event.tool_use || event.tool_calls) {
          fail(new Error("Built-in tool execution is disabled in agent bridge"));
          return;
        }

        if (event.event === "step_update") {
          if (typeof step.text_delta === "string" && step.text_delta) {
            this.content += step.text_delta;
            // Only stream content if tools are not present or if we haven't identified it as a tool call JSON yet
            if (!tools.length) {
              options.onDelta?.({ content: step.text_delta });
            }
          }
          if (step.usage) {
            const u = record(step.usage);
            this.usage = {
              promptTokens: Number(u.input_tokens ?? 0),
              completionTokens: Number(u.output_tokens ?? 0),
              totalTokens: Number(u.total_tokens ?? 0),
              reasoningTokens: Number(u.thinking_tokens ?? 0)
            };
          }
        } else if (event.event === "result") {
          const res = record(event.result);
          const status = String(res.status ?? "").toUpperCase();
          if (status !== "SUCCESS") {
            fail(new Error(String(res.error ?? `Antigravity completed with non-success status: ${res.status}`)));
            return;
          }
          if (typeof res.response === "string" && res.response && !this.content) {
            this.content = res.response;
          }
          if (res.usage) {
            const u = record(res.usage);
            this.usage = {
              promptTokens: Number(u.input_tokens ?? 0),
              completionTokens: Number(u.output_tokens ?? 0),
              totalTokens: Number(u.total_tokens ?? 0),
              reasoningTokens: Number(u.thinking_tokens ?? 0)
            };
          }
          const turn = completedAntigravityTurn(
            this.content || String(res.response ?? ""),
            [],
            this.usage,
            tools
          );
          // If tools were present but no tool call was made, stream the accumulated content
          if (tools.length && !turn.toolCalls.length && turn.content) {
            options.onDelta?.({ content: turn.content });
          }
          
          resolved = true;
          this.clearTimeout();
          options.signal?.removeEventListener("abort", forwardAbort);
          if (turn.toolCalls.length > 0) {
            this.emitCall(turn.toolCalls[0]!, options);
          }
          resolve(turn);
          void this.close();
        }
      } catch {
        // Ignore non-json startup logs
      }
    });

    return promise;
  }

  private clearTimeout() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
  }

  close(error = new Error("Antigravity session closed")) {
    if (this.cleanup) return this.cleanup;
    this.clearTimeout();
    sessions.delete(this);
    this.cleanup = (async () => {
      if (this.child && !this.child.killed) {
        this.child.kill("SIGTERM");
      }
      if (this.cwd) {
        try {
          await rm(this.cwd, { recursive: true, force: true });
        } catch {}
      }
    })();
    return this.cleanup;
  }
}

export async function closeAntigravitySessions() {
  await Promise.all([...sessions].map((s) => s.close()));
}

export const runAntigravity: ChatRunner = async (input, options = {}) => {
  const session = await AntigravityAgentSession.create();
  return session.run(input, options);
};
