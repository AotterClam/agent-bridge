import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
const REASONING = new Set(["low", "medium", "high", "xhigh", "max"]);
const DEFAULT_CODEX_TURN_TIMEOUT_MS = 300_000;

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function command() {
  return resolveCommand(process.env.AGENT_BRIDGE_CODEX_COMMAND ?? "codex");
}

function resolveCommand(cmd: string): string {
  if (process.env.AGENT_BRIDGE_CODEX_COMMAND) return process.env.AGENT_BRIDGE_CODEX_COMMAND;
  const home = homedir();
  const candidates = [
    join(home, ".local/bin", cmd),
    join(home, ".cargo/bin", cmd),
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

export function codexTurnTimeoutMs(
  value = process.env.AGENT_BRIDGE_CODEX_TIMEOUT_MS
) {
  if (value === undefined) return DEFAULT_CODEX_TURN_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("AGENT_BRIDGE_CODEX_TIMEOUT_MS must be a positive integer");
  }
  return timeout;
}

export function completedCodexTurn(
  content: string,
  toolCalls: ChatTurn["toolCalls"],
  usage?: ChatTurn["usage"],
  tools: ChatRequest["tools"] = []
): ChatTurn {
  const recovered = !toolCalls.length
    ? recoverTextToolCall(content, tools)
    : undefined;
  const calls = recovered ? [recovered] : toolCalls;
  if (!content && !calls.length) {
    throw new Error("Codex bridge returned no assistant turn");
  }
  return {
    content: recovered ? null : content || null,
    toolCalls: calls,
    finishReason: calls.length ? "tool_calls" : "stop",
    usage
  };
}

export function recoverTextToolCall(
  content: string,
  tools: ChatRequest["tools"]
): ChatTurn["toolCalls"][number] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content.trim());
  } catch {
    return;
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
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  return {
    id: `exec-${crypto.randomUUID()}`,
    name: String(call.name),
    arguments: args as Record<string, unknown>
  };
}

export function codexEnvironment(home: string) {
  const env: Record<string, string> = {
    HOME: home,
    CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), ".codex")
  };
  for (const key of ["PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "USER", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function rpc(child: ChildProcessWithoutNullStreams, onMessage: (message: RpcMessage) => void) {
  let nextId = 1;
  const pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as RpcMessage;
      if (message.id != null && !message.method) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message ?? "Codex request failed"));
        else request.resolve(message.result);
      } else {
        onMessage(message);
      }
    } catch {
      // Codex may print non-protocol startup output.
    }
  });
  return {
    request(method: string, params: unknown) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    notify(method: string, params?: unknown) {
      child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
    },
    close(error = new Error("Codex app-server closed")) {
      lines.close();
      pending.forEach(({ reject }) => reject(error));
      pending.clear();
    }
  };
}

function tokenUsage(params: Record<string, unknown>) {
  const last = record(record(params.tokenUsage).last);
  if (typeof last.totalTokens !== "number") return;
  return {
    promptTokens: Number(last.inputTokens ?? 0),
    completionTokens: Number(last.outputTokens ?? 0),
    totalTokens: last.totalTokens,
    reasoningTokens: Number(last.reasoningOutputTokens ?? 0)
  };
}

export async function detectCodex() {
  const cmd = command();
  let version: string | null = null;
  try {
    const { stdout } = await exec(cmd, ["--version"], { timeout: 5_000 });
    version = stdout.trim();
  } catch (error) {
    return {
      id: "codex" as const,
      name: "Codex",
      available: false,
      version: null,
      error: error instanceof Error ? error.message : "Codex CLI not found.",
      models: []
    };
  }

  try {
    const { stdout } = await exec(cmd, ["debug", "models", "--bundled"], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024
    }).catch(async () => {
      return exec(cmd, ["models"], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    });
    const payload = JSON.parse(stdout) as { models?: Array<Record<string, unknown>> };
    const models = (payload.models ?? [])
      .filter((model) => model.visibility === "list" || !model.visibility)
      .sort((a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999))
      .flatMap((model) => {
        if (typeof model.slug !== "string") return [];
        const efforts = Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels
              .map((value) => String(record(value).effort ?? value))
              .filter((value) => REASONING.has(value))
          : [];
        const defaultEffort = String(model.default_reasoning_level ?? "");
        return [{
          id: model.slug,
          name: typeof model.display_name === "string" ? model.display_name : model.slug,
          reasoningEfforts: efforts,
          ...(REASONING.has(defaultEffort) ? { defaultReasoningEffort: defaultEffort } : {})
        }];
      });
    return {
      id: "codex" as const,
      name: "Codex",
      available: models.length > 0,
      version,
      error: models.length ? null : "Codex returned no models.",
      models
    };
  } catch (error) {
    return {
      id: "codex" as const,
      name: "Codex",
      available: false,
      version,
      error: error instanceof Error ? error.message : "Codex unavailable.",
      models: []
    };
  }
}

type RunOptions = NonNullable<Parameters<ChatRunner>[1]>;

const pendingCalls = new Map<string, CodexSession>();
const sessions = new Set<CodexSession>();

function pendingResult(input: ChatRequest) {
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index];
    if (message?.role !== "tool") continue;
    const session = pendingCalls.get(message.tool_call_id);
    if (session) return session;
  }
}

class CodexSession {
  private readonly client: ReturnType<typeof rpc>;
  private threadId?: string;
  private content = "";
  private stderr = "";
  private usage?: ChatTurn["usage"];
  private pending?: { callId: string };
  private waiter?: {
    input: ChatRequest;
    options: RunOptions;
    resolve: (turn: ChatTurn) => void;
    reject: (error: Error) => void;
    abort: () => void;
  };
  private timeout?: NodeJS.Timeout;
  private cleanup?: Promise<void>;

  private constructor(
    private readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams
  ) {
    this.client = rpc(child, (message) => this.onMessage(message));
    child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    child.on("error", (error) => { void this.close(error); });
    child.on("close", (code) => {
      void this.close(
        new Error(`Codex exited ${code ?? "without a code"}: ${this.stderr.slice(-1000)}`)
      );
    });
  }

  static async create(input: ChatRequest) {
    const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-codex-"));
    const child = spawn(
      command(),
      [
        "--disable", "shell_tool",
        "--disable", "unified_exec",
        "--disable", "apps",
        "--disable", "browser_use",
        "--disable", "computer_use",
        "--disable", "image_generation",
        "--disable", "multi_agent",
        "app-server",
        "--stdio"
      ],
      { cwd, env: codexEnvironment(cwd), stdio: ["pipe", "pipe", "pipe"] }
    );
    const session = new CodexSession(cwd, child);
    sessions.add(session);
    try {
      await session.initialize(input);
      return session;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Codex initialization failed");
      await session.close(failure);
      throw failure;
    }
  }

  private async initialize(input: ChatRequest) {
    await this.client.request("initialize", {
      clientInfo: { name: "agent-bridge", title: "Agent Bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.client.notify("initialized");
    const started = record(await this.client.request("thread/start", {
      model: input.model,
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      dynamicTools: selectedTools(input).map(({ function: tool }) => ({
        type: "function",
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.parameters ?? { type: "object", properties: {} }
      })),
      baseInstructions:
        "Produce exactly one assistant turn. The dynamic host functions supplied with this thread ARE enabled and are your only way to act on the user's environment: call them through the function interface whenever they fit the request, and never print a function call as text. Built-in tools are disabled, so do not inspect files, run commands, or browse yourself — but that restriction does not apply to the host functions."
    }));
    const threadId = record(started.thread).id;
    if (typeof threadId !== "string") throw new Error("Codex returned no thread id");
    this.threadId = threadId;
  }

  async start(input: ChatRequest, options: RunOptions) {
    const result = this.wait(input, options);
    try {
      await this.client.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: promptFor(input.messages, input.tool_choice), text_elements: [] }],
        ...(input.reasoning_effort ? { effort: input.reasoning_effort } : {}),
        summary: "concise"
      });
    } catch (error) {
      void this.close(error instanceof Error ? error : new Error("Codex turn failed"));
    }
    return result;
  }

  private wait(input: ChatRequest, options: RunOptions) {
    if (this.cleanup) return Promise.reject(new Error("Codex session is closed"));
    if (this.waiter) return Promise.reject(new Error("Codex session is already running"));
    this.clearTimeout();
    this.content = "";
    const result = new Promise<ChatTurn>((resolve, reject) => {
      const abort = () => { void this.close(new Error("Codex bridge aborted")); };
      this.waiter = { input, options, resolve, reject, abort };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
    if (!this.cleanup) this.armTimeout("Codex turn");
    return result;
  }

  private onMessage(message: RpcMessage) {
    const params = message.params ?? {};
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      this.content += params.delta;
    } else if (
      (message.method === "item/reasoning/summaryTextDelta" ||
        message.method === "item/reasoning/textDelta") &&
      typeof params.delta === "string"
    ) {
      this.waiter?.options.onDelta?.({ reasoning_content: params.delta });
    } else if (message.method === "thread/tokenUsage/updated") {
      this.usage = tokenUsage(params) ?? this.usage;
    } else if (message.method === "item/tool/call") {
      if (this.pending) {
        void this.close(new Error("Codex emitted overlapping tool calls"));
        return;
      }
      const call = {
        id: String(params.callId ?? crypto.randomUUID()),
        name: String(params.tool ?? ""),
        arguments: record(params.arguments)
      };
      this.pending = { callId: call.id };
      pendingCalls.set(call.id, this);
      if (this.content) this.waiter?.options.onDelta?.({ content: this.content });
      this.emitCall(call);
      this.resolve({
        content: this.content || null,
        toolCalls: [call],
        finishReason: "tool_calls",
        usage: this.usage
      });
      // ponytail: one in-flight dynamic call per Codex turn; batch only if a model emits parallel calls.
      this.armTimeout("Codex tool result");
    } else if (message.method === "turn/completed") {
      const turn = record(params.turn);
      if (turn.status !== "completed") {
        void this.close(new Error(String(record(turn.error).message ?? "Codex turn failed")));
        return;
      }
      try {
        const completed = completedCodexTurn(
          this.content,
          [],
          this.usage,
          this.waiter ? selectedTools(this.waiter.input) : []
        );
        if (completed.toolCalls.length) {
          this.emitCall(completed.toolCalls[0]!);
        } else if (completed.content) {
          this.waiter?.options.onDelta?.({ content: completed.content });
        }
        this.resolve(completed);
        void this.close();
      } catch (error) {
        void this.close(error instanceof Error ? error : new Error("Codex turn failed"));
      }
    } else if (message.method?.includes("requestApproval")) {
      void this.close(new Error(`Codex built-in operation refused: ${message.method}`));
    }
  }

  private resolve(turn: ChatTurn) {
    const waiter = this.takeWaiter();
    waiter?.resolve(turn);
  }

  private emitCall(call: ChatTurn["toolCalls"][number]) {
    this.waiter?.options.onDelta?.({
      tool_calls: [{
        index: 0,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }]
    });
  }

  private takeWaiter() {
    const waiter = this.waiter;
    this.waiter = undefined;
    this.clearTimeout();
    if (waiter) waiter.options.signal?.removeEventListener("abort", waiter.abort);
    return waiter;
  }

  private armTimeout(label: string) {
    this.clearTimeout();
    const timeoutMs = codexTurnTimeoutMs();
    this.timeout = setTimeout(
      () => { void this.close(new Error(`${label} timed out after ${timeoutMs} ms.`)); },
      timeoutMs
    );
    this.timeout.unref();
  }

  private clearTimeout() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
  }

  close(error = new Error("Codex session closed")) {
    if (this.cleanup) return this.cleanup;
    this.clearTimeout();
    const waiter = this.takeWaiter();
    waiter?.reject(error);
    if (this.pending) pendingCalls.delete(this.pending.callId);
    this.pending = undefined;
    sessions.delete(this);
    this.client.close(error);
    if (!this.child.killed) this.child.kill("SIGTERM");
    this.cleanup = rm(this.cwd, { recursive: true, force: true });
    return this.cleanup;
  }
}

export async function closeCodexSessions() {
  await Promise.all([...sessions].map((session) => session.close()));
}

export const runCodex: ChatRunner = async (input, options = {}) => {
  const pending = pendingResult(input);
  if (pending) await pending.close();
  const session = await CodexSession.create(input);
  return session.start(input, options);
};
