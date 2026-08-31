import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
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
  ownedChild,
  executableFingerprint,
  MAX_EDIT_IMAGES,
  MAX_IMAGE_BODY,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_URL_CHARS,
  readOwnedImage,
  validateImageBase64,
  type ImageCapabilities,
  type ImageRunner
} from "./images.js";
import {
  audioInputs,
  imageInputs,
  MAX_INPUT_BYTES,
  type InputCapabilities
} from "./inputs.js";

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

/**
 * codex app-server's dynamicTools inputSchema parser (Rust/serde) does not accept the
 * JSON Schema "tuple" form of `items` — an array of one schema per position, as zod's
 * `z.tuple([...])` produces. Sent verbatim, thread/start rejects the whole request with
 * `dynamic tool input schema is not supported for <tool>: invalid type: map, expected a
 * string` (root-caused against a live app-server by bisecting the schema; not a guess).
 * No other adapter needs this: Claude's path (claude-bridge.mjs `toolShape`) converts
 * the same JSON Schema through zod's `fromJSONSchema`, which has explicit draft-7 tuple
 * support, before handing tools to claude-agent-sdk's in-process MCP server; and the
 * OpenAI-compatible /chat/completions and /responses surfaces never validate `parameters`
 * beyond "is it an object" (see protocol.ts's chatRequestSchema). So this rewrite is
 * scoped to the Codex wire format only, not the shared ChatRequest tool schema.
 *
 * Recursively walk the schema and rewrite a tuple-form `items` into a single schema
 * (multiple distinct item schemas collapse into `anyOf`) plus `minItems`/`maxItems` to
 * pin the array length. This is semantically close for the common case — a fixed-length
 * tuple of same-typed elements — trading positional type-checking for a length check
 * plus a per-element type check. Same fix already shipped and field-verified against a
 * live codex app-server in loomlore's own Codex runtime (`toCodexCompatibleSchema`)
 * before landing here.
 */
export function toCodexCompatibleSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toCodexCompatibleSchema);
  if (!schema || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "items") continue; // handled below: may be a tuple (array) or a single schema.
    out[key] = toCodexCompatibleSchema(value);
  }
  const items = obj.items;
  if (Array.isArray(items)) {
    const converted = items.map(toCodexCompatibleSchema);
    out.items = converted.length === 1 ? converted[0] : { anyOf: converted };
    if (out.minItems === undefined) out.minItems = items.length;
    if (out.maxItems === undefined) out.maxItems = items.length;
  } else if (items !== undefined) {
    out.items = toCodexCompatibleSchema(items);
  }
  return out;
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
  let closedError: Error | undefined;
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
      if (closedError) return Promise.reject(closedError);
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
      closedError ??= error;
      const failure = closedError;
      lines.close();
      pending.forEach(({ reject }) => reject(failure));
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

export function imageCapabilitiesFromCodexProbe(
  imageGeneration: unknown,
  fingerprint: ImageCapabilities["fingerprint"],
  error?: string
): ImageCapabilities {
  const status =
    imageGeneration === true
      ? "supported"
      : imageGeneration === false
        ? "unsupported"
        : "unknown";
  const capability = {
    status,
    probe: "app-server:modelProvider/capabilities/read",
    evidence: error ?? `imageGeneration=${String(imageGeneration)}`,
    supported_openai_params: ["n", "response_format"],
    parameter_constraints: {
      n: { enum: [1] },
      response_format: { enum: ["b64_json"] }
    },
    provider_capabilities: {
      runtime: "codex app-server",
      self_report: { imageGeneration },
      imagegen_tool: {
        controllable_parameters: [
          "prompt",
          "referenced_image_paths",
          "num_last_images_to_include"
        ],
        backend_defaults: { size: "auto" }
      }
    }
  } as const;
  return {
    generation: { ...capability },
    edit: {
      ...capability,
      parameter_constraints: {
        ...capability.parameter_constraints,
        images: {
          min_items: 1,
          max_items: MAX_EDIT_IMAGES,
          schema_max_items: MAX_EDIT_IMAGES,
          max_items_source: "openai_schema",
          runtime_max_items: null,
          max_image_bytes: MAX_IMAGE_BYTES,
          max_total_request_bytes: MAX_IMAGE_BODY,
          multipart_fields: ["image", "image[]"],
          json_refs: {
            file_id: true,
            image_url: {
              schemes: ["data"],
              max_chars: MAX_IMAGE_URL_CHARS
            }
          }
        }
      }
    },
    responsesImageGeneration: {
      ...capability,
      supported_openai_params: [],
      parameter_constraints: {}
    },
    fingerprint
  };
}

async function probeCodexImageCapabilities(
  fingerprint: ImageCapabilities["fingerprint"]
): Promise<ImageCapabilities> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-codex-capabilities-"));
  const isolatedCodexHome = join(cwd, ".codex");
  let child: ChildProcessWithoutNullStreams | undefined;
  let client: ReturnType<typeof rpc> | undefined;
  let stderr = "";
  const timeout = setTimeout(() => {
    client?.close(new Error("Codex image capability probe timed out"));
    child?.kill("SIGTERM");
  }, 10_000);
  timeout.unref();
  try {
    await mkdir(isolatedCodexHome);
    const configuredCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    await copyFile(
      join(configuredCodexHome, "config.toml"),
      join(isolatedCodexHome, "config.toml")
    ).catch((error) => {
      if (record(error).code !== "ENOENT") throw error;
    });
    child = spawn(
      command(),
      [
        "--disable", "shell_tool",
        "--disable", "unified_exec",
        "--disable", "apps",
        "--disable", "browser_use",
        "--disable", "computer_use",
        "--enable", "image_generation",
        "--disable", "multi_agent",
        "app-server",
        "--stdio"
      ],
      {
        cwd,
        env: { ...codexEnvironment(cwd), CODEX_HOME: isolatedCodexHome },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    client = rpc(child, () => {});
    child.once("error", (error) => client?.close(error));
    child.once("close", (code) => {
      client?.close(new Error(`Codex capability probe exited ${code}: ${stderr.slice(-1000)}`));
    });
    await client.request("initialize", {
      clientInfo: { name: "agent-bridge", title: "Agent Bridge", version: "0.1.12" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    client.notify("initialized");
    const result = record(
      await client.request("modelProvider/capabilities/read", {})
    );
    return imageCapabilitiesFromCodexProbe(result.imageGeneration, fingerprint);
  } catch (error) {
    return imageCapabilitiesFromCodexProbe(
      undefined,
      fingerprint,
      error instanceof Error ? error.message : "Codex capability probe failed"
    );
  } finally {
    clearTimeout(timeout);
    client?.close();
    if (child && !child.killed) child.kill("SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  }
}

export function inputCapabilitiesFromCodexSchema(
  userInputTypes: string[] | null,
  error?: string,
  imageDetails: string[] = ["auto", "low", "high"]
): InputCapabilities {
  const status = (supported: boolean) =>
    userInputTypes === null ? "unknown" as const : supported ? "supported" as const : "unsupported" as const;
  const capability = (
    kind: "image" | "audio" | "pdf",
    supportedTypes: string[],
    parts: string[],
    constraints: Record<string, unknown>
  ) => {
    const supported = supportedTypes.some((type) => userInputTypes?.includes(type));
    return {
      status: status(supported),
      probe: "app-server generated UserInput schema",
      evidence: error ?? `${kind}: ${supported ? "supported" : "not advertised"}`,
      supported_openai_content_parts: supported ? parts : [],
      parameter_constraints: supported ? constraints : {},
      provider_capabilities: {
        runtime: "codex app-server",
        user_input_types: userInputTypes ?? []
      }
    };
  };
  return {
    image: capability(
      "image",
      ["image"],
      ["image_url", "input_image"],
      {
        detail: { enum: imageDetails },
        source: { enum: ["http", "https", "data"] },
        max_decoded_bytes: MAX_INPUT_BYTES
      }
    ),
    audio: capability(
      "audio",
      ["audio"],
      ["input_audio"],
      { format: { enum: ["wav", "mp3"] }, max_decoded_bytes: MAX_INPUT_BYTES }
    ),
    pdf: capability("pdf", ["file", "localFile"], ["file", "input_file"], {})
  };
}

async function probeCodexInputCapabilities(): Promise<InputCapabilities> {
  const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-codex-inputs-"));
  try {
    await exec(
      command(),
      ["app-server", "generate-json-schema", "--experimental", "--out", cwd],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const schema = JSON.parse(await readFile(join(cwd, "ClientRequest.json"), "utf8"));
    const definitions = record(schema.definitions);
    const userInput = record(definitions.UserInput);
    const imageDetailEnum = record(definitions.ImageDetail).enum;
    const imageDetails = Array.isArray(imageDetailEnum)
      ? imageDetailEnum.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const variants = Array.isArray(userInput.oneOf) ? userInput.oneOf : [];
    const types = variants.flatMap((variant) => {
      const property = record(record(record(variant).properties).type);
      return Array.isArray(property.enum)
        ? property.enum.filter((value): value is string => typeof value === "string")
        : [];
    });
    return inputCapabilitiesFromCodexSchema(
      types,
      undefined,
      imageDetails.length ? imageDetails : undefined
    );
  } catch (error) {
    return inputCapabilitiesFromCodexSchema(
      null,
      error instanceof Error ? error.message : "Codex input capability probe failed"
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function detectCodex() {
  const cmd = command();
  let version: string | null = null;
  try {
    const { stdout } = await exec(cmd, ["--version"], { timeout: 5_000 });
    version = stdout.trim();
  } catch (error) {
    const fingerprint = await executableFingerprint(cmd, null);
    return {
      id: "codex" as const,
      name: "Codex",
      available: false,
      version: null,
      error: error instanceof Error ? error.message : "Codex CLI not found.",
      models: [],
      inputs: inputCapabilitiesFromCodexSchema(null, "Codex CLI unavailable"),
      images: imageCapabilitiesFromCodexProbe(
        undefined,
        fingerprint,
        "Codex CLI unavailable"
      )
    };
  }

  const fingerprint = await executableFingerprint(cmd, version);
  const images = probeCodexImageCapabilities(fingerprint);
  const inputs = probeCodexInputCapabilities();

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
      models,
      inputs: await inputs,
      images: await images
    };
  } catch (error) {
    return {
      id: "codex" as const,
      name: "Codex",
      available: false,
      version,
      error: error instanceof Error ? error.message : "Codex unavailable.",
      models: [],
      inputs: await inputs,
      images: await images
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
        inputSchema: toCodexCompatibleSchema(tool.parameters ?? { type: "object", properties: {} })
      })),
      baseInstructions: HOST_TOOL_INSTRUCTIONS
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
        input: [
          { type: "text", text: promptFor(input.messages, input.tool_choice), text_elements: [] },
          ...imageInputs(input).map((image) => ({
            type: "image",
            url: image.url,
            ...(image.detail ? { detail: image.detail } : {})
          })),
          ...audioInputs(input).map((audio) => ({
            type: "audio",
            url: `data:audio/${audio.format === "mp3" ? "mpeg" : "wav"};base64,${audio.data}`
          }))
        ],
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
  await Promise.all([
    ...[...sessions].map((session) => session.close()),
    ...[...imageSessions].map((close) => close())
  ]);
}

export const runCodex: ChatRunner = async (input, options = {}) => {
  const pending = pendingResult(input);
  if (pending) await pending.close();
  const session = await CodexSession.create(input);
  return session.start(input, options);
};

const imageSessions = new Set<() => Promise<void>>();

export const runCodexImage: ImageRunner = async (input, options = {}) => {
  if (input.size) {
    throw Object.assign(new Error("Codex app-server does not expose image size control."), {
      status: 400
    });
  }
  const cwd = await mkdtemp(join(tmpdir(), "agent-bridge-codex-image-"));
  const child = spawn(
    command(),
    [
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--disable", "apps",
      "--disable", "browser_use",
      "--disable", "computer_use",
      "--enable", "image_generation",
      "--disable", "multi_agent",
      "app-server",
      "--stdio"
    ],
    { cwd, env: codexEnvironment(cwd), stdio: ["pipe", "pipe", "pipe"] }
  );
  let stderr = "";
  let threadDirectory: string | undefined;
  let removeThreadDirectory = false;
  let verifiedSavedPath: string | undefined;
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let cleanup: Promise<void> | undefined;
  let terminalError: Error | undefined;
  const client = rpc(child, (message) => onMessage(message));
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  let resolveImage!: (result: { b64Json: string; revisedPrompt?: string }) => void;
  let rejectImage!: (error: Error) => void;
  const result = new Promise<{ b64Json: string; revisedPrompt?: string }>((resolve, reject) => {
    resolveImage = resolve;
    rejectImage = reject;
  });
  void result.catch(() => {});
  let image: Record<string, unknown> | undefined;

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
    if (removeThreadDirectory && verifiedSavedPath) {
      await rm(verifiedSavedPath, { force: true });
    }
    if (removeThreadDirectory && threadDirectory) {
      await rmdir(threadDirectory).catch((cause) => {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(record(cause).code))) {
          throw cause;
        }
      });
    }
  })();

  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    terminalError = error;
    rejectImage(error);
    void close(error).catch(() => {});
  };
  const abort = () => fail(new Error("Codex image generation aborted"));
  const timeoutMs = codexTurnTimeoutMs();
  timeout = setTimeout(
    () => fail(new Error(`Codex image generation timed out after ${timeoutMs} ms.`)),
    timeoutMs
  );
  timeout.unref();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  function onMessage(message: RpcMessage) {
    const params = message.params ?? {};
    if (message.method === "item/completed") {
      const item = record(params.item);
      if (item.type === "imageGeneration") {
        if (image) fail(new Error("Codex returned more than one image"));
        else image = item;
      }
      return;
    }
    if (message.method !== "turn/completed") return;
    const turn = record(params.turn);
    if (turn.status !== "completed") {
      fail(new Error(String(record(turn.error).message ?? "Codex image generation failed")));
      return;
    }
    if (!image || typeof image.result !== "string") {
      fail(new Error("Codex returned no image generation item"));
      return;
    }
    if (image.failure) {
      fail(new Error(`Codex image generation failed: ${JSON.stringify(image.failure)}`));
      return;
    }
    try {
      validateImageBase64(image.result);
      settled = true;
      resolveImage({
        b64Json: image.result,
        ...(typeof image.revisedPrompt === "string"
          ? { revisedPrompt: image.revisedPrompt }
          : {})
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Codex returned an invalid image"));
    }
  }

  imageSessions.add(close);
  child.on("error", fail);
  child.on("close", (code) => {
    if (!settled) fail(new Error(`Codex exited ${code ?? "without a code"}: ${stderr.slice(-1000)}`));
  });

  try {
    await client.request("initialize", {
      clientInfo: { name: "agent-bridge", title: "Agent Bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    client.notify("initialized");
    const started = record(await client.request("thread/start", {
      ...(input.model ? { model: input.model } : {}),
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions:
        "Call the built-in image generation tool exactly once, using the user's prompt verbatim. Do not call any other tool."
    }));
    const threadId = record(started.thread).id;
    if (typeof threadId !== "string") throw new Error("Codex returned no thread id");
    const generatedRoot = join(codexEnvironment(cwd).CODEX_HOME, "generated_images");
    threadDirectory = ownedChild(generatedRoot, threadId);
    removeThreadDirectory = !existsSync(threadDirectory);
    await client.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: input.imagePaths?.length
            ? `Edit the attached image using this prompt verbatim:\n${input.prompt}`
            : `Generate an image using this prompt verbatim:\n${input.prompt}`,
          text_elements: []
        },
        ...(input.imagePaths ?? []).map((path) => ({ type: "localImage", path }))
      ],
      summary: "concise"
    });
    const output = await result;
    if (typeof image?.savedPath === "string" && threadDirectory) {
      const saved = await readOwnedImage(image.savedPath, threadDirectory);
      if (removeThreadDirectory) verifiedSavedPath = image.savedPath;
      if (!Buffer.from(saved, "base64").equals(Buffer.from(output.b64Json, "base64"))) {
        throw new Error("Codex image result did not match its saved output");
      }
    }
    return output;
  } finally {
    try {
      await close();
    } finally {
      imageSessions.delete(close);
    }
  }
};
