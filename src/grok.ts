import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
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
const DEFAULT_GROK_TURN_TIMEOUT_MS = 300_000;
const HOST_SERVER = "openai";
const HOST_PREFIX = `${HOST_SERVER}__`;

type RpcMessage = {
  jsonrpc?: string;
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
  return process.env.AGENT_BRIDGE_GROK_COMMAND ?? "grok";
}

function grokTurnTimeoutMs(
  value = process.env.AGENT_BRIDGE_GROK_TIMEOUT_MS
) {
  if (value === undefined) return DEFAULT_GROK_TURN_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new Error("AGENT_BRIDGE_GROK_TIMEOUT_MS must be a positive integer");
  }
  return timeout;
}

function grokHomePath() {
  return process.env.GROK_HOME ?? join(homedir(), ".grok");
}

function grokEnvironment(home: string) {
  const env: Record<string, string> = {
    HOME: home,
    GROK_HOME: grokHomePath(),
    GROK_DISABLE_AUTOUPDATER: "1"
  };
  for (const key of [
    "PATH",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USER",
    "LANG",
    "LC_ALL",
    "XAI_API_KEY"
  ]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

export function parseGrokModels(stdout: string) {
  const models: Array<{
    id: string;
    name: string;
    reasoningEfforts: readonly string[];
  }> = [];
  let inList = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (/available models/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const id = line.match(/^\s*[*+-]\s+(\S+)/)?.[1];
    if (id && !models.some((model) => model.id === id)) {
      models.push({ id, name: id, reasoningEfforts: [] });
    }
  }
  return models;
}

export function modelsFromGrokInitialize(init: unknown) {
  const available = record(record(record(init)._meta).modelState).availableModels;
  if (!Array.isArray(available)) return [];
  return available.flatMap((item) => {
    const model = record(item);
    const id = String(model.modelId ?? "");
    if (!id) return [];
    const info = record(model._meta);
    const listed = Array.isArray(info.reasoningEfforts) ? info.reasoningEfforts : [];
    const reasoningEfforts =
      info.supportsReasoningEffort === false
        ? []
        : listed
            .map((entry) => String(record(entry).value ?? record(entry).id))
            .filter(Boolean);
    const advertised = String(info.reasoningEffort ?? "");
    return [{
      id,
      name: typeof model.name === "string" ? model.name : id,
      reasoningEfforts,
      ...(advertised && reasoningEfforts.includes(advertised)
        ? { defaultReasoningEffort: advertised }
        : {})
    }];
  });
}

async function discoverGrokModelsViaAcp() {
  const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-grok-models-"));
  const child = spawn(
    command(),
    ["--no-auto-update", "agent", "--no-leader", "stdio"],
    { cwd, env: grokEnvironment(cwd), stdio: ["pipe", "pipe", "pipe"] }
  );
  const client = rpc(child, () => {});
  try {
    const init = await Promise.race([
      client.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "agent-bridge", version: "0.1.8" },
        clientCapabilities: {}
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Grok initialize timed out")), 15_000);
        timer.unref();
      })
    ]);
    const models = modelsFromGrokInitialize(init);
    return models.length ? models : null;
  } finally {
    client.close();
    if (!child.killed) child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }, 1_000).unref();
    void rm(cwd, { recursive: true, force: true });
  }
}

export async function detectGrok() {
  try {
    const [{ stdout: version }, models] = await Promise.all([
      exec(command(), ["--version"], { timeout: 5_000 }),
      discoverGrokModelsViaAcp().catch(() => null)
    ]);
    const catalog =
      models ??
      parseGrokModels(
        (await exec(command(), ["models"], { timeout: 15_000, maxBuffer: 1024 * 1024 }))
          .stdout
      );
    return {
      id: "grok" as const,
      name: "Grok Build",
      available: catalog.length > 0,
      version: version.trim(),
      error: catalog.length ? null : "Grok returned no models.",
      models: catalog
    };
  } catch (error) {
    return {
      id: "grok" as const,
      name: "Grok Build",
      available: false,
      version: null,
      error: error instanceof Error ? error.message : "Grok unavailable.",
      models: []
    };
  }
}

type RunOptions = NonNullable<Parameters<ChatRunner>[1]>;

function rpc(child: ChildProcessWithoutNullStreams, onMessage: (message: RpcMessage) => void) {
  let nextId = 1;
  const pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line) as RpcMessage;
      if (message.method) {
        onMessage(message);
        return;
      }
      if (message.id == null) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error.message ?? "Grok request failed"));
      } else request.resolve(message.result);
    } catch {
      // Grok may print non-protocol startup output.
    }
  });
  return {
    request(method: string, params: unknown) {
      const id = nextId++;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
      );
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    notify(method: string, params?: unknown) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`
      );
    },
    respond(id: number | string, result: unknown) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    },
    close(error = new Error("Grok agent closed")) {
      lines.close();
      pending.forEach(({ reject }) => reject(error));
      pending.clear();
    }
  };
}

function hostToolCall(update: Record<string, unknown>, allowed?: ReadonlySet<string>) {
  const raw = record(update.rawInput);
  const qualified = String(raw.tool_name ?? update.title ?? "");
  const name = qualified.startsWith(HOST_PREFIX)
    ? qualified.slice(HOST_PREFIX.length)
    : qualified;
  if (!qualified.startsWith(HOST_PREFIX) && !allowed?.has(name)) return;
  const args = raw.tool_input ?? raw.arguments ?? {};
  return {
    id: String(update.toolCallId ?? crypto.randomUUID()),
    name,
    arguments: record(args)
  };
}

type ToolMessage = Extract<ChatRequest["messages"][number], { role: "tool" }>;

function toolText(message: ToolMessage) {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text).join("");
}

async function startHostTools(tools: ChatRequest["tools"]) {
  if (!tools.length) return;
  const pending: Array<{
    id: number | string | undefined;
    response: import("node:http").ServerResponse;
  }> = [];
  const results: string[] = [];
  // ponytail: Grok emits and dispatches parallel MCP calls in order; key by call signature if it stops doing so.
  const respond = () => {
    if (!pending.length || !results.length) return;
    const { id, response } = pending.shift()!;
    const content = results.shift()!;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: content }] }
    }));
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      let payload: RpcMessage = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as RpcMessage;
      } catch {
        payload = {};
      }
      if (payload.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: HOST_SERVER, version: "0.0.0" }
          }
        }));
        return;
      }
      if (payload.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      if (payload.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            tools: tools.map(({ function: tool }) => ({
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: tool.parameters ?? { type: "object", properties: {} }
            }))
          }
        }));
        return;
      }
      if (payload.method === "tools/call") {
        pending.push({ id: payload.id, response });
        respond();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -32601, message: `Unknown ${payload.method}` }
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Grok host-tool server failed to bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    resume(content: string) {
      results.push(content);
      respond();
    },
    close() {
      pending.forEach(({ response }) => response.destroy());
      pending.length = 0;
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

const pendingCalls = new Map<string, GrokSession>();
const sessions = new Set<GrokSession>();

class GrokSession {
  private readonly client: ReturnType<typeof rpc>;
  private sessionId?: string;
  private content = "";
  private stderr = "";
  private hostTools?: Awaited<ReturnType<typeof startHostTools>>;
  private waiter?: {
    options: RunOptions;
    resolve: (turn: ChatTurn) => void;
    reject: (error: Error) => void;
    abort: () => void;
  };
  private timeout?: NodeJS.Timeout;
  private cleanup?: Promise<void>;
  private resolved = false;
  private hostToolNames = new Set<string>();
  private pendingToolCalls: ChatTurn["toolCalls"] = [];
  private seenToolCalls = new Set<string>();

  private constructor(
    private readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams
  ) {
    this.client = rpc(child, (message) => this.onMessage(message));
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    child.on("error", (error) => {
      void this.close(error);
    });
    child.on("close", (code) => {
      void this.close(
        new Error(`Grok exited ${code ?? "without a code"}: ${this.stderr.slice(-1000)}`)
      );
    });
  }

  static async create(input: ChatRequest) {
    const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-grok-"));
    const args = ["--no-auto-update", "agent", "--no-leader"];
    if (input.model) args.push("--model", input.model);
    if (input.reasoning_effort) args.push("--reasoning-effort", input.reasoning_effort);
    args.push("stdio");
    const child = spawn(command(), args, {
      cwd,
      env: grokEnvironment(cwd),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const session = new GrokSession(cwd, child);
    sessions.add(session);
    try {
      await session.initialize(input);
      return session;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Grok initialization failed");
      await session.close(failure);
      throw failure;
    }
  }

  private async initialize(input: ChatRequest) {
    const tools = selectedTools(input);
    this.hostToolNames = new Set(tools.map(({ function: tool }) => tool.name));
    this.hostTools = await startHostTools(tools);
    const init = record(await this.client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "agent-bridge", title: "Agent Bridge", version: "0.1.8" },
      clientCapabilities: {}
    }));
    const methods = new Set(
      (Array.isArray(init.authMethods) ? init.authMethods : [])
        .map((method) => String(record(method).id))
        .filter(Boolean)
    );
    const methodId =
      process.env.XAI_API_KEY && methods.has("xai.api_key")
        ? "xai.api_key"
        : methods.has("cached_token")
          ? "cached_token"
          : null;
    if (!methodId) {
      throw new Error("Run `grok login` first, or set XAI_API_KEY.");
    }
    await this.client.request("authenticate", {
      methodId,
      _meta: { headless: true }
    });
    const started = record(await this.client.request("session/new", {
      cwd: this.cwd,
      mcpServers: this.hostTools
        ? [{
            type: "http",
            name: HOST_SERVER,
            url: this.hostTools.url,
            headers: []
          }]
        : [],
      _meta: {
        yoloMode: false,
        systemPromptOverride:
          "Produce exactly one assistant turn. Call host functions through the function interface when appropriate; never print a function call as text. Do not inspect files, run commands, browse, or use built-in tools."
      }
    }));
    if (typeof started.sessionId !== "string") {
      throw new Error("Grok returned no session id");
    }
    this.sessionId = started.sessionId;
  }

  async prompt(input: ChatRequest, options: RunOptions) {
    const result = this.wait(options);
    try {
      const prompt = this.client.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: promptFor(input.messages, input.tool_choice) }]
      });
      void prompt.then((value) => {
        if (this.resolved) return;
        const stop = String(record(value).stopReason ?? record(value).stop_reason ?? "end_turn");
        if (stop === "cancelled" || stop === "canceled") return;
        if (!this.content) {
          void this.close(new Error("Grok bridge returned no assistant turn"));
          return;
        }
        this.resolve({
          content: this.content,
          toolCalls: [],
          finishReason: "stop"
        });
      }).catch((error) => {
        if (!this.resolved) {
          void this.close(error instanceof Error ? error : new Error("Grok turn failed"));
        }
      });
    } catch (error) {
      void this.close(error instanceof Error ? error : new Error("Grok turn failed"));
    }
    return result;
  }

  resume(message: ToolMessage, options: RunOptions) {
    const index = this.pendingToolCalls.findIndex((call) => call.id === message.tool_call_id);
    if (index < 0) {
      return Promise.reject(new Error("Grok tool call is no longer pending"));
    }
    this.pendingToolCalls.splice(index, 1);
    pendingCalls.delete(message.tool_call_id);
    const result = this.wait(options);
    try {
      this.hostTools?.resume(toolText(message));
    } catch (error) {
      void this.close(error instanceof Error ? error : new Error("Grok tool result failed"));
    }
    const next = this.pendingToolCalls[0];
    if (next) this.resolveToolCall(next);
    return result;
  }

  private wait(options: RunOptions) {
    if (this.cleanup) return Promise.reject(new Error("Grok session is closed"));
    if (this.waiter) return Promise.reject(new Error("Grok session is already running"));
    this.content = "";
    this.resolved = false;
    const result = new Promise<ChatTurn>((resolve, reject) => {
      const abort = () => {
        void this.close(new Error("Grok bridge aborted"));
      };
      this.waiter = { options, resolve, reject, abort };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
    this.armTimeout();
    return result;
  }

  private onMessage(message: RpcMessage) {
    if (message.method === "session/request_permission" && message.id != null) {
      const options = Array.isArray(message.params?.options) ? message.params.options : [];
      const hostTool = hostToolCall(record(message.params?.toolCall), this.hostToolNames);
      const optionId = options
        .map((value) => record(value))
        .find((option) => String(option.kind ?? option.optionId).includes(
          hostTool ? "allow_once" : "reject"
        ))
        ?.optionId;
      this.client.respond(message.id, {
        outcome: { outcome: "selected", optionId: optionId ?? (hostTool ? "allow-once" : "reject-once") }
      });
      return;
    }
    if (message.method !== "session/update") return;
    const update = record(record(message.params).update);
    const kind = String(update.sessionUpdate ?? "");
    if (kind === "agent_message_chunk" && typeof record(update.content).text === "string") {
      const text = String(record(update.content).text);
      this.content += text;
      this.waiter?.options.onDelta?.({ content: text });
      return;
    }
    if (kind === "agent_thought_chunk" && typeof record(update.content).text === "string") {
      const text = String(record(update.content).text);
      if (text) this.waiter?.options.onDelta?.({ reasoning_content: text });
      return;
    }
    if (kind !== "tool_call") return;
    const call = hostToolCall(update, this.hostToolNames);
    if (!call) return;
    if (this.seenToolCalls.has(call.id)) return;
    this.seenToolCalls.add(call.id);
    this.pendingToolCalls.push(call);
    pendingCalls.set(call.id, this);
    if (this.waiter) this.resolveToolCall(call);
  }

  private resolveToolCall(call: ChatTurn["toolCalls"][number]) {
    this.resolved = true;
    this.emitCall(call);
    this.takeWaiter()?.resolve({
      content: this.content || null,
      toolCalls: [call],
      finishReason: "tool_calls"
    });
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

  private resolve(turn: ChatTurn) {
    const waiter = this.takeWaiter();
    this.resolved = true;
    waiter?.resolve(turn);
    void this.close();
  }

  private takeWaiter() {
    const waiter = this.waiter;
    this.waiter = undefined;
    this.clearTimeout();
    if (waiter) waiter.options.signal?.removeEventListener("abort", waiter.abort);
    return waiter;
  }

  private armTimeout() {
    this.clearTimeout();
    const timeoutMs = grokTurnTimeoutMs();
    this.timeout = setTimeout(() => {
      void this.close(new Error(`Grok turn timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    this.timeout.unref();
  }

  private clearTimeout() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
  }

  close(error = new Error("Grok session closed")) {
    if (this.cleanup) return this.cleanup;
    this.clearTimeout();
    const waiter = this.takeWaiter();
    if (!this.resolved) waiter?.reject(error);
    this.pendingToolCalls.forEach((call) => pendingCalls.delete(call.id));
    this.pendingToolCalls = [];
    sessions.delete(this);
    this.client.close(error);
    if (!this.child.killed) this.child.kill("SIGTERM");
    this.cleanup = Promise.all([
      this.hostTools?.close(),
      rm(this.cwd, { recursive: true, force: true })
    ]).then(() => undefined);
    return this.cleanup;
  }
}

export async function closeGrokSessions() {
  await Promise.all([...sessions].map((session) => session.close()));
}

export const runGrok: ChatRunner = async (input, options = {}) => {
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index];
    if (message?.role !== "tool") continue;
    const pending = pendingCalls.get(message.tool_call_id);
    if (!pending) continue;
    if (selectedTools(input).length) return pending.resume(message, options);
    await pending.close();
    break;
  }
  const session = await GrokSession.create(input);
  return session.prompt(input, options);
};
