import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  HOST_TOOL_INSTRUCTIONS,
  promptFor,
  selectedTools,
  type ChatRequest,
  type ChatRunner,
  type ChatTurn
} from "./protocol.js";
import {
  executableFingerprint,
  ownedChild,
  readOwnedImage,
  type ImageCapabilities,
  type ImageRunner
} from "./images.js";
import {
  decodeImageDataUrl,
  imageInputs,
  type InputCapabilities
} from "./inputs.js";

const exec = promisify(execFile);
const DEFAULT_GROK_TURN_TIMEOUT_MS = 300_000;
const MAX_GROK_PROMPT_JSON_BYTES = 192 * 1024;
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

export function grokToolCatalogFromInitialize(init: unknown) {
  const payload = record(init);
  const meta = record(payload._meta);
  const capabilities = record(payload.agentCapabilities);
  const catalogs = [
    payload.toolCatalog,
    payload.availableTools,
    meta.toolCatalog,
    meta.availableTools,
    capabilities.toolCatalog,
    capabilities.availableTools
  ];
  for (const catalog of catalogs) {
    if (!Array.isArray(catalog)) continue;
    return catalog.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      const tool = record(entry);
      const name = tool.name ?? tool.toolName ?? tool.id;
      return typeof name === "string" && name ? [name] : [];
    });
  }
  return null;
}

const GROK_GENERATION_ASPECT_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "3:2", "2:3"
] as const;
const GROK_EDIT_ASPECT_RATIOS = [
  "auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3",
  "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20"
] as const;

export function grokAspectRatioForSize(size: string) {
  if (size === "auto") return size;
  const [width, height] = size.split("x").map(Number);
  if (!width || !height) throw Object.assign(new Error("size must be auto or WIDTHxHEIGHT."), { status: 400 });
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  const ratio = `${width / divisor}:${height / divisor}`;
  if (!GROK_GENERATION_ASPECT_RATIOS.includes(ratio as typeof GROK_GENERATION_ASPECT_RATIOS[number])) {
    throw Object.assign(
      new Error(`Grok supports these aspect ratios: ${GROK_GENERATION_ASPECT_RATIOS.join(", ")}.`),
      { status: 400 }
    );
  }
  return ratio;
}

export function imageCapabilitiesFromGrokCatalog(
  catalog: string[] | null,
  fingerprint: ImageCapabilities["fingerprint"],
  error?: string
): ImageCapabilities {
  const capability = (name: "image_gen" | "image_edit") => ({
    status: catalog === null
      ? "unknown" as const
      : catalog.includes(name)
        ? "supported" as const
        : "unsupported" as const,
    probe: "acp:initialize tool catalog",
    evidence: error ?? (catalog === null
      ? "ACP initialize returned no built-in tool catalog"
      : `${name}${catalog.includes(name) ? "" : " not"} advertised`),
    supported_openai_params: ["n", "response_format"],
    parameter_constraints: {
      n: { enum: [1] },
      response_format: { enum: ["b64_json"] }
    },
    provider_capabilities: {
      runtime: "grok ACP",
      tool: name,
      parameters: name === "image_gen"
        ? { aspect_ratio: { enum: GROK_GENERATION_ASPECT_RATIOS, default: "auto" } }
        : {
            aspect_ratio: {
              enum: GROK_EDIT_ASPECT_RATIOS,
              default: "auto",
              ignored_for_single_image: true
            }
          }
    }
  });
  const generation = capability("image_gen");
  return {
    generation: {
      ...generation,
      supported_openai_params: [...generation.supported_openai_params, "size"],
      parameter_constraints: {
        ...generation.parameter_constraints,
        size: {
          maps_to: "aspect_ratio",
          exact_pixels: false,
          supported_aspect_ratios: GROK_GENERATION_ASPECT_RATIOS
        }
      }
    },
    edit: capability("image_edit"),
    responsesImageGeneration: {
      ...generation,
      supported_openai_params: ["size"],
      parameter_constraints: {
        size: {
          maps_to: "aspect_ratio",
          exact_pixels: false,
          supported_aspect_ratios: GROK_GENERATION_ASPECT_RATIOS
        }
      }
    },
    fingerprint
  };
}

async function discoverGrokModelsViaAcp() {
  const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-grok-models-"));
  const isolatedGrokHome = join(cwd, ".grok");
  await mkdir(isolatedGrokHome);
  const child = spawn(
    command(),
    ["--no-auto-update", "agent", "--no-leader", "stdio"],
    {
      cwd,
      env: { ...grokEnvironment(cwd), GROK_HOME: isolatedGrokHome },
      stdio: ["pipe", "pipe", "pipe"]
    }
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
    return {
      models: modelsFromGrokInitialize(init),
      toolCatalog: grokToolCatalogFromInitialize(init),
      promptCapabilities: record(record(record(init).agentCapabilities).promptCapabilities)
    };
  } finally {
    client.close();
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    if (!child.killed) child.kill("SIGTERM");
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
      })
    ]);
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await rm(cwd, { recursive: true, force: true });
  }
}

export function inputCapabilitiesFromGrokProbe(
  promptCapabilities: Record<string, unknown> | null,
  promptJsonAdvertised: boolean | null,
  error?: string
): InputCapabilities {
  const raw = {
    runtime: "Grok Build",
    acp_prompt_capabilities: promptCapabilities ?? {},
    prompt_json: promptJsonAdvertised
  };
  const imageSupported =
    promptJsonAdvertised === true && promptCapabilities?.image === true;
  const imageUnknown = promptJsonAdvertised === true && !imageSupported;
  return {
    image: {
      status: imageSupported
        ? "supported"
        : imageUnknown
          ? "unknown"
        : promptJsonAdvertised === false
          ? "unsupported"
          : "unknown",
      probe: "ACP initialize + CLI --help",
      evidence: error ?? (imageSupported
        ? "ACP image and --prompt-json are advertised"
        : imageUnknown
          ? "--prompt-json is advertised but ACP image=false; awaiting a live bridge smoke"
          : "No structured image input lane advertised"),
      supported_openai_content_parts: imageSupported || imageUnknown
        ? ["image_url", "input_image"]
        : [],
      parameter_constraints: imageSupported || imageUnknown
        ? {
            source: { enum: ["data"] },
            media_type: { enum: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
            detail: { enum: ["auto"] },
            selected_tools: { max_items: 0 },
            prompt_json_max_bytes: MAX_GROK_PROMPT_JSON_BYTES
          }
        : {},
      provider_capabilities: raw
    },
    audio: {
      status: promptCapabilities?.audio === false ? "unsupported" : "unknown",
      probe: "ACP initialize",
      evidence: `audio=${String(promptCapabilities?.audio)}`,
      supported_openai_content_parts: [],
      parameter_constraints: {},
      provider_capabilities: raw
    },
    pdf: {
      status: promptCapabilities?.embeddedContext === true ? "unknown" : "unsupported",
      probe: "ACP initialize",
      evidence: promptCapabilities?.embeddedContext === true
        ? "embeddedContext is advertised, but PDF input has not passed a live bridge smoke test"
        : "embeddedContext is not advertised",
      supported_openai_content_parts: [],
      parameter_constraints: {},
      provider_capabilities: raw
    }
  };
}

export async function detectGrok() {
  const cmd = command();
  try {
    let acpError: string | undefined;
    const [{ stdout: version }, acp, help] = await Promise.all([
      exec(cmd, ["--version"], { timeout: 5_000 }),
      discoverGrokModelsViaAcp().catch(() => null),
      exec(cmd, ["--help"], { timeout: 5_000 }).then(({ stdout }) => stdout).catch(() => "")
    ]);
    if (!acp) acpError = "Grok ACP initialize failed";
    const catalog =
      (acp?.models.length ? acp.models : null) ??
      parseGrokModels(
        (await exec(cmd, ["models"], { timeout: 15_000, maxBuffer: 1024 * 1024 }))
          .stdout
      );
    const fingerprint = await executableFingerprint(cmd, version.trim());
    return {
      id: "grok" as const,
      name: "Grok Build",
      available: catalog.length > 0,
      version: version.trim(),
      error: catalog.length ? null : "Grok returned no models.",
      models: catalog,
      inputs: inputCapabilitiesFromGrokProbe(
        acp?.promptCapabilities ?? null,
        help ? /--prompt-json\b/.test(help) : null,
        acpError
      ),
      images: imageCapabilitiesFromGrokCatalog(
        acp?.toolCatalog ?? null,
        fingerprint,
        acpError
      )
    };
  } catch (error) {
    const fingerprint = await executableFingerprint(cmd, null);
    return {
      id: "grok" as const,
      name: "Grok Build",
      available: false,
      version: null,
      error: error instanceof Error ? error.message : "Grok unavailable.",
      models: [],
      inputs: inputCapabilitiesFromGrokProbe(null, null, "Grok CLI unavailable"),
      images: imageCapabilitiesFromGrokCatalog(
        null,
        fingerprint,
        "Grok CLI unavailable"
      )
    };
  }
}

type RunOptions = NonNullable<Parameters<ChatRunner>[1]>;

function rpc(child: ChildProcessWithoutNullStreams, onMessage: (message: RpcMessage) => void) {
  let nextId = 1;
  let closedError: Error | undefined;
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
      if (closedError) return Promise.reject(closedError);
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
      closedError ??= error;
      const failure = closedError;
      lines.close();
      pending.forEach(({ reject }) => reject(failure));
      pending.clear();
    }
  };
}

export function hostToolCall(update: Record<string, unknown>, allowed?: ReadonlySet<string>) {
  // Grok tags every tool event with x.ai/tool metadata, and only its
  // use_tool wrapper dispatches MCP (host) calls. Name matching alone is
  // unsafe: hosts legitimately register tools named like Grok built-ins
  // (read_file), and treating a built-in run as a host call desyncs both
  // sides — Grok reads its empty sandbox while the host executes a call
  // Grok never routed to it.
  const kind = record(record(update._meta)["x.ai/tool"]).kind;
  if (kind && kind !== "use_tool") return;
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
        debugLog?.("mcp tools/list served", {
          tools: tools.map(({ function: tool }) => tool.name)
        });
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
        debugLog?.("mcp tools/call", payload.params ?? {});
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

const debugLog = process.env.AGENT_BRIDGE_GROK_DEBUG
  ? (label: string, value: unknown) =>
      console.info(`[grok-debug] ${label} ${JSON.stringify(value)}`)
  : undefined;

const pendingCalls = new Map<string, GrokSession>();
const sessions = new Set<GrokSession>();
const visionControllers = new Set<AbortController>();

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
    // Built-in read tools must stay on: Grok externalizes long prompts to a
    // file the model reads back with read_file/grep (--disallowed-tools does
    // not remove them anyway — verified 2026-08-25). hostToolCall's use_tool
    // gate is what keeps built-in runs from leaking out as host calls.
    const args = [
      "--no-auto-update",
      "--disable-web-search",
      "agent",
      "--no-leader"
    ];
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
        systemPromptOverride: HOST_TOOL_INSTRUCTIONS
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
      debugLog?.("request_permission", message.params);
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
    if (kind !== "tool_call") {
      if (kind !== "tool_call_update" && debugLog) debugLog("update", update);
      return;
    }
    const call = hostToolCall(update, this.hostToolNames);
    if (!call) {
      debugLog?.("ignored tool_call", update);
      return;
    }
    debugLog?.("host tool_call", update);
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
  visionControllers.forEach((controller) => controller.abort());
  await Promise.all([
    ...[...sessions].map((session) => session.close()),
    ...[...grokImageSessions].map((close) => close())
  ]);
}

export const runGrok: ChatRunner = async (input, options = {}) => {
  if (imageInputs(input).length) return runGrokVision(input, options);
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

async function prepareIsolatedGrokHome(cwd: string) {
  const isolated = join(cwd, ".grok");
  await mkdir(isolated);
  for (const name of ["auth.json", "agent_id"]) {
    const source = join(grokHomePath(), name);
    if (existsSync(source)) await symlink(source, join(isolated, name));
  }
  return isolated;
}

async function runGrokVision(
  input: ChatRequest,
  options: RunOptions
): Promise<ChatTurn> {
  if (selectedTools(input).length) {
    throw Object.assign(
      new Error("Grok image input cannot be combined with selected tools."),
      { status: 400 }
    );
  }
  const blocks: Array<Record<string, unknown>> = [
    { type: "text", text: promptFor(input.messages, input.tool_choice) }
  ];
  for (const image of imageInputs(input)) {
    if (!image.url.startsWith("data:")) {
      throw Object.assign(
        new Error("Grok image input currently requires a base64 data URL."),
        { status: 400 }
      );
    }
    const decoded = decodeImageDataUrl(image.url);
    blocks.push({
      type: "image",
      data: decoded.bytes.toString("base64"),
      mimeType: decoded.mediaType
    });
  }
  const promptJson = JSON.stringify(blocks);
  if (Buffer.byteLength(promptJson) > MAX_GROK_PROMPT_JSON_BYTES) {
    throw Object.assign(
      new Error(`Grok --prompt-json input exceeds ${MAX_GROK_PROMPT_JSON_BYTES} bytes.`),
      { status: 413 }
    );
  }

  const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-grok-vision-"));
  const controller = new AbortController();
  const abort = () => controller.abort();
  visionControllers.add(controller);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const home = await prepareIsolatedGrokHome(cwd);
    const args = [
      "--no-auto-update",
      "--prompt-json", promptJson,
      "--output-format", "json",
      "--disable-web-search",
      "--no-subagents",
      "--tools", ""
    ];
    if (input.model) args.push("--model", input.model);
    if (input.reasoning_effort) args.push("--reasoning-effort", input.reasoning_effort);
    const { stdout } = await exec(command(), args, {
      cwd,
      env: { ...grokEnvironment(cwd), GROK_HOME: home },
      timeout: grokTurnTimeoutMs(),
      maxBuffer: 4 * 1024 * 1024,
      signal: controller.signal
    });
    const payload = record(JSON.parse(stdout));
    const content = typeof payload.text === "string" ? payload.text : "";
    if (!content) throw new Error("Grok prompt-json returned no text.");
    const thought = typeof payload.thought === "string" ? payload.thought : "";
    if (thought) options.onDelta?.({ reasoning_content: thought });
    options.onDelta?.({ content });
    const usage = record(payload.usage);
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      usage: {
        promptTokens: Number(usage.input_tokens ?? 0),
        completionTokens: Number(usage.output_tokens ?? 0),
        totalTokens: Number(usage.total_tokens ?? 0),
        reasoningTokens: Number(usage.reasoning_tokens ?? 0)
      }
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    visionControllers.delete(controller);
    await rm(cwd, { recursive: true, force: true });
  }
}

const grokImageSessions = new Set<() => Promise<void>>();

function grokToolName(value: unknown) {
  const tool = record(value);
  const meta = record(record(tool._meta)["x.ai/tool"]);
  return String(meta.name ?? tool.toolName ?? tool.title ?? "");
}

export const runGrokImage: ImageRunner = async (input, options = {}) => {
  if (input.imagePath && input.size) {
    throw Object.assign(new Error("Grok ignores aspect_ratio for single-image edits."), {
      status: 400
    });
  }
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "agent-bridge-grok-image-"))
  );
  const sessionBucket = ownedChild(
    join(grokHomePath(), "sessions"),
    encodeURIComponent(cwd)
  );
  const expectedTool = input.imagePath ? "image_edit" : "image_gen";
  const args = [
    "--no-auto-update",
    "--disable-web-search",
    "agent",
    "--no-leader",
    ...(input.model ? ["--model", input.model] : []),
    "stdio"
  ];
  const child = spawn(
    command(),
    args,
    { cwd, env: grokEnvironment(cwd), stdio: ["pipe", "pipe", "pipe"] }
  );
  let stderr = "";
  let settled = false;
  let sessionId: string | undefined;
  let sessionDirectory: string | undefined;
  let imageCallId: string | undefined;
  let permissionGranted = false;
  let timeout: NodeJS.Timeout | undefined;
  let cleanup: Promise<void> | undefined;
  let terminalError: Error | undefined;
  const client = rpc(child, (message) => onMessage(message));
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  let resolveImage!: (result: { b64Json: string }) => void;
  let rejectImage!: (error: Error) => void;
  const result = new Promise<{ b64Json: string }>((resolve, reject) => {
    resolveImage = resolve;
    rejectImage = reject;
  });
  void result.catch(() => {});

  const close = (error = terminalError) => cleanup ??= (async () => {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    client.close(error);
    if (child.exitCode == null && child.signalCode == null) {
      let closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
      if (child.exitCode == null && child.signalCode == null) {
        closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
      }
    }
    await rm(cwd, { recursive: true, force: true });
    await rm(sessionBucket, { recursive: true, force: true });
  })();

  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    terminalError = error;
    rejectImage(error);
    void close(error).catch(() => {});
  };
  const abort = () => fail(new Error("Grok image generation aborted"));
  const timeoutMs = grokTurnTimeoutMs();
  timeout = setTimeout(
    () => fail(new Error(`Grok image generation timed out after ${timeoutMs} ms.`)),
    timeoutMs
  );
  timeout.unref();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  async function complete(path: string) {
    if (!sessionDirectory) {
      return fail(new Error("Grok returned an image before its session id"));
    }
    const root = ownedChild(sessionDirectory, "images");
    try {
      const b64Json = await readOwnedImage(path, root);
      if (settled) return;
      settled = true;
      resolveImage({ b64Json });
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Grok returned an invalid image"));
    }
  }

  function onMessage(message: RpcMessage) {
    if (message.method === "session/request_permission" && message.id != null) {
      const params = message.params ?? {};
      const toolCall = record(params.toolCall);
      const allowed =
        grokToolName(toolCall) === expectedTool && !permissionGranted;
      const choices = Array.isArray(params.options) ? params.options.map(record) : [];
      const option = choices.find((choice) =>
        String(choice.kind ?? choice.optionId).includes(allowed ? "allow_once" : "reject")
      );
      client.respond(message.id, {
        outcome: {
          outcome: "selected",
          optionId: option?.optionId ?? (allowed ? "allow-once" : "reject-once")
        }
      });
      if (allowed) permissionGranted = true;
      else fail(new Error(`Grok attempted unsupported or repeated tool "${grokToolName(toolCall)}"`));
      return;
    }
    if (message.method !== "session/update") return;
    const update = record(record(message.params).update);
    if (update.sessionUpdate === "tool_call") {
      if (grokToolName(update) !== expectedTool || imageCallId) {
        fail(new Error(`Grok attempted unsupported or repeated tool "${grokToolName(update)}"`));
        return;
      }
      imageCallId = String(update.toolCallId ?? "");
      return;
    }
    if (update.sessionUpdate !== "tool_call_update") return;
    if (!imageCallId || update.toolCallId !== imageCallId) return;
    const status = String(update.status).toLowerCase();
    if (["failed", "cancelled", "canceled"].includes(status)) {
      const output = record(update.rawOutput);
      fail(new Error(String(output.message ?? output.error ?? `Grok image tool ${status}`)));
      return;
    }
    if (status !== "completed") return;
    const output = record(update.rawOutput);
    if (typeof output.path !== "string") {
      fail(new Error("Grok image tool returned no output path"));
      return;
    }
    void complete(output.path);
  }

  grokImageSessions.add(close);
  child.on("error", fail);
  child.on("close", (code) => {
    if (!settled) fail(new Error(`Grok exited ${code ?? "without a code"}: ${stderr.slice(-1000)}`));
  });

  try {
    const init = record(await client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "agent-bridge", version: "0.1.12" },
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
    if (!methodId) throw new Error("Run `grok login` first, or set XAI_API_KEY.");
    await client.request("authenticate", { methodId, _meta: { headless: true } });
    const started = record(await client.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: {
        yoloMode: false,
        systemPromptOverride:
          `Call ${expectedTool} exactly once. Do not call any other tool and do not alter the user's prompt.`
      }
    }));
    if (typeof started.sessionId !== "string") throw new Error("Grok returned no session id");
    sessionId = started.sessionId;
    sessionDirectory = ownedChild(sessionBucket, sessionId);
    void client.request("session/prompt", {
      sessionId,
      prompt: [{
        type: "text",
        text: input.imagePath
          ? `Call image_edit with prompt ${JSON.stringify(input.prompt)} and image ${JSON.stringify(input.imagePath)}.`
          : `Call image_gen with prompt ${JSON.stringify(input.prompt)}${input.size
              ? ` and aspect_ratio ${JSON.stringify(grokAspectRatioForSize(input.size))}`
              : ""}.`
      }]
    }).catch((error) => fail(error instanceof Error ? error : new Error("Grok image generation failed")));
    return await result;
  } finally {
    try {
      await close();
    } finally {
      grokImageSessions.delete(close);
    }
  }
};
