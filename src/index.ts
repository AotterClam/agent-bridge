import { createHmac, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import {
  createClaudeRunner,
  discoverClaudeModels
} from "./claude-bridge.mjs";
import {
  closeCodexSessions,
  detectCodex,
  runCodex,
  runCodexImage
} from "./codex.js";
import {
  closeGrokSessions,
  detectGrok,
  runGrok,
  runGrokImage
} from "./grok.js";
import {
  closeAntigravitySessions,
  detectAntigravity,
  runAntigravity
} from "./antigravity.js";
import {
  chatRequestSchema,
  respond,
  type ChatDelta,
  type ChatRunner,
  type ChatTurn
} from "./protocol.js";
import {
  respondResponses,
  responsesRequestSchema,
  toChatRequest
} from "./responses.js";
import {
  type ImageCapabilities,
  type ImageCapabilityStatus,
  imageResponse,
  parseEditRequest,
  parseGenerationRequest
} from "./images.js";
import {
  audioInputs,
  decodeAudioInput,
  decodeImageDataUrl,
  fileInputs,
  imageInputs,
  MAX_INPUT_BYTES,
  pdfSource,
  validateRemoteUrl,
  type InputCapabilities
} from "./inputs.js";
import {
  createFileStore,
  fileStorageCapability,
  materializeChatFileIds,
  materializeResponseFileIds
} from "./files.js";
import {
  createReconnectManager,
  type AdapterAuth
} from "./reconnect.js";
import { z } from "zod";

export {
  authSupport,
  claudeCommand,
  createReconnectManager,
  parseClaudeAuthStatus,
  reconnectTimeoutMs,
  runLogin,
  type AdapterAction,
  type AdapterAuth,
  type AuthState,
  type AuthSupport,
  type LoginSpec,
  type ReconnectRun,
  type ReconnectState
} from "./reconnect.js";

export type AdapterId = "claude" | "codex" | "grok" | "antigravity";
export type AdapterCapability = {
  id: AdapterId;
  name: string;
  available: boolean;
  version: string | null;
  error: string | null;
  inputs: InputCapabilities;
  images: ImageCapabilities;
  models: Array<{
    id: string;
    name: string;
    reasoningEfforts: readonly string[];
    defaultReasoningEffort?: string;
  }>;
};
export type AgentBridgeAdapter = AdapterCapability &
  AdapterAuth & {
    capabilityToken: string;
  };

const imageCapabilitySchema = z.object({
  status: z.enum(["supported", "unsupported", "unknown"]),
  probe: z.string(),
  evidence: z.string(),
  supported_openai_params: z.array(z.string()).default([]),
  parameter_constraints: z.record(z.string(), z.unknown()).default({}),
  provider_capabilities: z.record(z.string(), z.unknown()).default({})
});
const inputCapabilitySchema = z.object({
  status: z.enum(["supported", "unsupported", "unknown"]),
  probe: z.string(),
  evidence: z.string(),
  supported_openai_content_parts: z.array(z.string()).default([]),
  parameter_constraints: z.record(z.string(), z.unknown()).default({}),
  provider_capabilities: z.record(z.string(), z.unknown()).default({})
});
const legacyUnknownInputs = () => {
  const unknown = {
    status: "unknown" as const,
    probe: "legacy-server",
    evidence: "Input capabilities were not reported by this Agent Bridge server",
    supported_openai_content_parts: [] as string[],
    parameter_constraints: {},
    provider_capabilities: {}
  };
  return {
    image: { ...unknown },
    audio: { ...unknown },
    pdf: { ...unknown }
  };
};
const legacyUnknownImages = () => {
  const unknown = {
    status: "unknown" as const,
    probe: "legacy-server",
    evidence: "Image capabilities were not reported by this Agent Bridge server",
    supported_openai_params: [] as string[],
    parameter_constraints: {},
    provider_capabilities: {}
  };
  return {
    generation: { ...unknown },
    edit: { ...unknown },
    responsesImageGeneration: { ...unknown },
    fingerprint: { executable: null, version: null }
  };
};

const capabilitiesResponseSchema = z.object({
  files: z.object({
    status: z.enum(["supported", "unsupported", "unknown"]),
    scope: z.string(),
    persistence: z.string(),
    max_file_bytes: z.number(),
    accepted_media_types: z.array(z.string()),
    resolves_file_id_for: z.array(z.string()).default([]),
    endpoints: z.array(z.string())
  }).default({
    status: "unknown",
    scope: "unknown",
    persistence: "File storage capability was not reported by this server",
    max_file_bytes: 0,
    accepted_media_types: [],
    resolves_file_id_for: [],
    endpoints: []
  }),
  adapters: z.array(z.object({
    id: z.enum(["claude", "codex", "grok", "antigravity"]),
    name: z.string(),
    available: z.boolean(),
    version: z.string().nullable(),
    error: z.string().nullable(),
    capabilityToken: z.string().min(1),
    // A server without the reconnect contract reports neither field. Treating
    // that as "signed in, nothing offered" keeps an older bridge usable and
    // keeps a host UI from rendering a button the server cannot serve.
    authState: z.enum(["ready", "auth_required", "reauth_pending"])
      .default("ready"),
    actions: z.array(z.enum(["reconnect"])).default([]),
    inputs: z.object({
      image: inputCapabilitySchema,
      audio: inputCapabilitySchema,
      pdf: inputCapabilitySchema
    }).default(legacyUnknownInputs),
    images: z.object({
      generation: imageCapabilitySchema,
      edit: imageCapabilitySchema,
      responsesImageGeneration: imageCapabilitySchema,
      fingerprint: z.object({
        executable: z.string().nullable(),
        version: z.string().nullable()
      })
    }).default(legacyUnknownImages),
    models: z.array(z.object({
      id: z.string(),
      name: z.string(),
      reasoningEfforts: z.array(z.string()),
      defaultReasoningEffort: z.string().optional()
    }))
  }))
});

const MAX_BODY = 30 * 1024 * 1024;

export function capabilityToken(controlToken: string, adapter: AdapterId) {
  return createHmac("sha256", controlToken)
    .update(adapter)
    .digest("base64url");
}

async function detectClaude(): Promise<AdapterCapability> {
  const unsupported = {
    status: "unsupported",
    probe: "bridge implementation",
    evidence: "Claude image generation is not implemented",
    supported_openai_params: [],
    parameter_constraints: {},
    provider_capabilities: {
      runtime: "Claude Agent SDK",
      image_generation: "not exposed to this bridge"
    }
  } as const;
  const inputs: InputCapabilities = {
    image: {
      status: "supported",
      probe: "Claude Agent SDK MessageParam schema",
      evidence: "ImageBlockParam accepts URL and base64 image sources",
      supported_openai_content_parts: ["image_url", "input_image"],
      parameter_constraints: {
        source: { enum: ["http", "https", "data"] },
        media_type: { enum: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
        detail: { enum: ["auto"] },
        max_decoded_bytes: MAX_INPUT_BYTES
      },
      provider_capabilities: {
        runtime: "Claude Agent SDK",
        content_block: "image"
      }
    },
    audio: {
      status: "unsupported",
      probe: "Claude Agent SDK MessageParam schema",
      evidence: "No audio input content block is exposed",
      supported_openai_content_parts: [],
      parameter_constraints: {},
      provider_capabilities: { runtime: "Claude Agent SDK" }
    },
    pdf: {
      status: "supported",
      probe: "Claude Agent SDK MessageParam schema",
      evidence: "DocumentBlockParam accepts URL and base64 PDF sources",
      supported_openai_content_parts: ["file", "input_file"],
      parameter_constraints: {
        media_type: { enum: ["application/pdf"] },
        source: { enum: ["http", "https", "data"] },
        file_id: false,
        max_decoded_bytes: MAX_INPUT_BYTES
      },
      provider_capabilities: {
        runtime: "Claude Agent SDK",
        content_block: "document",
        media_type: "application/pdf"
      }
    }
  };
  try {
    const models = await discoverClaudeModels();
    return {
      id: "claude",
      name: "Claude Code",
      available: models.length > 0,
      version: null,
      error: models.length ? null : "Claude Agent SDK returned no models.",
      inputs,
      images: {
        generation: { ...unsupported },
        edit: { ...unsupported },
        responsesImageGeneration: { ...unsupported },
        fingerprint: { executable: null, version: null }
      },
      // Unlike Codex, the SDK names no per-model default effort, so
      // `defaultReasoningEffort` stays unset rather than invented.
      models: models.map((model: AdapterCapability["models"][number]) => ({
        id: model.id,
        name: model.name,
        reasoningEfforts: model.reasoningEfforts ?? []
      }))
    };
  } catch (error) {
    return {
      id: "claude",
      name: "Claude Code",
      available: false,
      version: null,
      error:
        error instanceof Error
          ? error.message
          : "Claude Agent SDK unavailable.",
      models: [],
      inputs,
      images: {
        generation: { ...unsupported },
        edit: { ...unsupported },
        responsesImageGeneration: { ...unsupported },
        fingerprint: { executable: null, version: null }
      }
    };
  }
}

export function cachedCapabilities(
  load: () => Promise<AdapterCapability[]>
) {
  let current: Promise<AdapterCapability[]> | undefined;
  return (refresh = false) => {
    if (refresh) current = undefined;
    return current ??= load();
  };
}

export function allowsImageRunner(
  adapter: AdapterId,
  status: ImageCapabilityStatus
) {
  return status === "supported" || (adapter === "grok" && status === "unknown");
}

export function liteLLMModelInfo(adapter: AdapterCapability) {
  const supported = (status: "supported" | "unsupported" | "unknown") =>
    status === "supported" ? true : status === "unsupported" ? false : null;
  return adapter.models.map((model) => ({
    model_name: model.id,
    litellm_params: { model: model.id },
    model_info: {
      id: model.id,
      mode: "chat",
      supported_openai_params: [
        "stream",
        "tools",
        "tool_choice",
        ...(model.reasoningEfforts.length ? ["reasoning_effort"] : [])
      ],
      supports_vision: supported(adapter.inputs.image.status),
      supports_audio_input: supported(adapter.inputs.audio.status),
      supports_pdf_input: supported(adapter.inputs.pdf.status),
      agent_bridge: {
        adapter_id: adapter.id,
        files: fileStorageCapability,
        inputs: adapter.inputs,
        images: adapter.images
      }
    }
  }));
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > MAX_BODY) {
      throw Object.assign(new Error("Request exceeds 30 MiB"), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error("Request body must be valid JSON."), {
        status: 400
      });
    }
    throw error;
  }
}

async function pipe(source: Response, target: ServerResponse) {
  target.writeHead(source.status, Object.fromEntries(source.headers));
  if (!source.body) return target.end();
  const reader = source.body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    target.write(Buffer.from(chunk.value));
  }
  target.end();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function notFound() {
  return Object.assign(new Error("Not found"), {
    status: 404,
    category: "not_found"
  });
}

/**
 * The bridge's provider-neutral error classification, carried as
 * `error.category` on every control-plane and data-plane failure and on both
 * streaming lanes. Hosts switch on this instead of parsing a runtime's error
 * prose, which is the point of the reconnect contract: `auth_required` means
 * "this adapter's sign-in died, offer the reconnect action".
 *
 * The set is closed and consumed downstream — extend it deliberately.
 */
const CATEGORY_BY_STATUS: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  404: "not_found",
  409: "conflict",
  413: "invalid_request"
};

function errorCategory(error: unknown, status: number) {
  const explicit = record(error).category;
  return typeof explicit === "string"
    ? explicit
    : CATEGORY_BY_STATUS[status] ?? "server_error";
}

const runClaude = createClaudeRunner() as ChatRunner & { close(): void };

function validateInputs(input: z.infer<typeof chatRequestSchema>, capability: AdapterCapability) {
  const images = imageInputs(input);
  const audio = audioInputs(input);
  const files = fileInputs(input);
  for (const [kind, values] of [
    ["image", images],
    ["audio", audio],
    ["pdf", files]
  ] as const) {
    const cell = capability.inputs[kind];
    const liveProbe =
      cell.status === "unknown" &&
      cell.provider_capabilities.live_probe === true;
    if (values.length && cell.status !== "supported" && !liveProbe) {
      throw Object.assign(
        new Error(`${capability.id} does not support ${kind} input through this bridge.`),
        { status: 400 }
      );
    }
  }
  const sources = record(capability.inputs.image.parameter_constraints.source).enum;
  const details = record(capability.inputs.image.parameter_constraints.detail).enum;
  for (const image of images) {
    const source = image.url.startsWith("data:") ? "data" : new URL(validateRemoteUrl(image.url, "image_url")).protocol.slice(0, -1);
    if (Array.isArray(sources) && !sources.includes(source)) {
      throw Object.assign(new Error(`${capability.id} does not support ${source} image input.`), { status: 400 });
    }
    if (source === "data") decodeImageDataUrl(image.url);
    if (image.detail && Array.isArray(details) && !details.includes(image.detail)) {
      throw Object.assign(new Error(`${capability.id} does not support image detail=${image.detail}.`), { status: 400 });
    }
  }
  for (const item of audio) {
    decodeAudioInput(item);
  }
  for (const file of files) pdfSource(file);
}

import {
  createLogger,
  type BridgeLogger,
  type LoggerOptions,
  type LogLevel,
  type LogRecord,
  type ScopedLogger
} from "./logger.js";

export {
  createLogger,
  type BridgeLogger,
  type LoggerOptions,
  type LogLevel,
  type LogRecord,
  type ScopedLogger
};

export type AgentBridgeOptions = {
  controlToken?: string;
  preloadModels?: boolean;
  logger?: BridgeLogger | LoggerOptions;
  /** Overrides the per-adapter login support map. Tests inject fakes here. */
  reconnect?: Parameters<typeof createReconnectManager>[0];
};

const reconnectRequestSchema = z.object({
  adapter: z.enum(["claude", "codex", "grok", "antigravity"])
});

const reconnectRunSchema = z.object({
  reconnectId: z.string().min(1),
  adapter: z.enum(["claude", "codex", "grok", "antigravity"]),
  state: z.enum(["pending", "succeeded", "failed"]),
  detail: z.string().optional()
});

export function createAgentBridge(options: AgentBridgeOptions = {}) {
  const logger: BridgeLogger =
    options.logger && "debug" in options.logger
      ? options.logger
      : createLogger(options.logger);

  const controlToken =
    options.controlToken ??
    process.env.AGENT_BRIDGE_CONTROL_TOKEN ??
    randomBytes(32).toString("base64url");
  const fileStore = createFileStore();
  const tokens = {
    claude: capabilityToken(controlToken, "claude"),
    codex: capabilityToken(controlToken, "codex"),
    grok: capabilityToken(controlToken, "grok"),
    antigravity: capabilityToken(controlToken, "antigravity")
  };
  const capabilities = cachedCapabilities(() =>
    Promise.all([
      detectClaude(),
      detectCodex(),
      detectGrok(),
      detectAntigravity()
    ])
  );
  // Sign-in state is not cached with discovery: it changes under the bridge
  // whenever a token expires or a reconnect finishes, while the model catalog
  // does not. The manager owns its own short cache and invalidates it there.
  const reconnect = createReconnectManager({
    ...options.reconnect,
    onEvent: (event) => {
      logger.info(
        "reconnect",
        `${event.adapter} reconnect ${event.state}`,
        { adapter: event.adapter, reconnectId: event.reconnectId }
      );
      options.reconnect?.onEvent?.(event);
    }
  });
  /**
   * Turns a failed adapter turn into a classified error.
   *
   * Expiry is only ever observed as a turn that failed, so this is where the
   * cached sign-in reading has to be discarded. When the re-probe confirms the
   * runtime is signed out, the failure is reported as `401` with category
   * `auth_required`, which is the same standard field the control plane uses —
   * a host reads one field instead of pattern-matching a runtime's error prose.
   */
  const classifyTurnFailure = async (adapterId: AdapterId, error: unknown) => {
    const failure = error instanceof Error ? error : new Error("Bridge failed");
    // Already classified (both the streaming wrapper and the request catch run
    // this), or rejected by the bridge before the runtime ever saw it — a
    // malformed body is not evidence about credentials and must not spawn a CLI.
    const status = Number(record(error).status ?? 0);
    if (record(error).category || (status >= 400 && status < 500)) return failure;
    const { authState } = await reconnect.recheck(adapterId);
    if (authState !== "auth_required") return failure;
    return Object.assign(failure, { status: 401, category: "auth_required" });
  };
  const guardedRunner = (adapterId: AdapterId, run: ChatRunner): ChatRunner =>
    async (input, runOptions) => {
      try {
        return await run(input, runOptions);
      } catch (error) {
        // Streaming lanes settle their own errors inside the SSE body and
        // never reach the request catch, so classification happens here too.
        throw await classifyTurnFailure(adapterId, error);
      }
    };
  const markImageSupported = (
    capability: AdapterCapability | undefined,
    operation: "generation" | "edit" | "responsesImageGeneration"
  ) => {
    const cell = capability?.images[operation];
    if (!cell || cell.status !== "unknown") return;
    cell.status = "supported";
    cell.probe = "live-request";
    cell.evidence = `${operation} completed successfully on this host`;
  };
  const markInputSupported = (
    capability: AdapterCapability,
    input: z.infer<typeof chatRequestSchema>
  ) => {
    for (const [kind, count] of [
      ["image", imageInputs(input).length],
      ["audio", audioInputs(input).length],
      ["pdf", fileInputs(input).length]
    ] as const) {
      const cell = capability.inputs[kind];
      if (!count || cell.status !== "unknown") continue;
      cell.status = "supported";
      cell.probe = "live-request";
      cell.evidence = `${kind} input completed successfully on this host`;
    }
  };
  if (options.preloadModels) void capabilities();
  const server = createServer(async (request, response) => {
    const startTime = Date.now();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const path = url.pathname;
    const logInfo: Record<string, unknown> = { method, path };
    response.once("finish", () => {
      const status = response.statusCode || 200;
      const durationMs = Date.now() - startTime;
      const meta = {
        method,
        path,
        status,
        durationMs,
        ...logInfo
      };
      if (status >= 500) {
        logger.error("http", `${method} ${path} ${status}`, meta);
      } else if (status >= 400) {
        logger.warn("http", `${method} ${path} ${status}`, meta);
      } else {
        logger.info("http", `${method} ${path} ${status}`, meta);
      }
    });

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/capabilities") {
      logInfo.adapter = "control";
      if (request.headers.authorization !== `Bearer ${controlToken}`) {
        return json(response, 401, {
          error: { message: "Invalid control token", category: "unauthorized" }
        });
      }
      const refresh = url.searchParams.get("refresh") === "1";
      if (refresh) reconnect.refresh();
      const discovered = await capabilities(refresh);
      return json(response, 200, {
        files: fileStore.capability,
        adapters: await Promise.all(
          discovered.map(async (adapter) => ({
            ...adapter,
            ...(await reconnect.authState(adapter.id)),
            capabilityToken: tokens[adapter.id]
          }))
        )
      });
    }

    if (url.pathname === "/reconnect" || url.pathname.startsWith("/reconnect/")) {
      const reconnectPath =
        url.pathname.match(/^\/reconnect(?:\/([^/]+?)(\/cancel)?)?$/) ?? [];
      logInfo.adapter = "control";
      if (request.headers.authorization !== `Bearer ${controlToken}`) {
        return json(response, 401, {
          error: { message: "Invalid control token", category: "unauthorized" }
        });
      }
      try {
        const id = reconnectPath[1];
        if (!id && request.method === "POST") {
          const parsed = reconnectRequestSchema.safeParse(await body(request));
          if (!parsed.success) {
            throw Object.assign(new Error(z.prettifyError(parsed.error)), {
              status: 400,
              category: "invalid_request"
            });
          }
          const run = reconnect.start(parsed.data.adapter);
          logInfo.reconnectAdapter = run.adapter;
          return json(response, 202, run);
        }
        if (id && !reconnectPath[2] && request.method === "GET") {
          const run = reconnect.status(decodeURIComponent(id));
          if (!run) throw notFound();
          return json(response, 200, run);
        }
        if (id && reconnectPath[2] && request.method === "POST") {
          const run = await reconnect.cancel(decodeURIComponent(id));
          if (!run) throw notFound();
          return json(response, 200, run);
        }
        throw notFound();
      } catch (error) {
        logInfo.error = error instanceof Error ? error.message : String(error);
        const status = Number(record(error).status ?? 500);
        return json(response, status, {
          error: {
            message:
              error instanceof Error ? error.message : "Reconnect failed",
            category: errorCategory(error, status)
          }
        });
      }
    }

    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const adapter = (Object.entries(tokens) as Array<[AdapterId, string]>).find(
      ([, value]) => value === bearer
    )?.[0];
    if (!adapter) {
      return json(response, 401, {
        error: { message: "Invalid API key", category: "unauthorized" }
      });
    }
    logInfo.adapter = adapter;
    const filePath = url.pathname.match(/^\/v1\/files\/([^/]+?)(\/content)?$/);
    if (url.pathname === "/v1/files" || filePath) {
      try {
        if (!filePath && request.method === "POST") {
          return json(response, 200, await fileStore.upload(request, adapter));
        }
        if (!filePath && request.method === "GET") {
          return json(response, 200, {
            object: "list",
            data: fileStore.list(adapter),
            has_more: false
          });
        }
        if (filePath) {
          const id = decodeURIComponent(filePath[1]!);
          if (request.method === "GET" && filePath[2]) {
            const file = await fileStore.read(adapter, id);
            response.writeHead(200, {
              "content-type": file.mediaType,
              "content-length": file.data.length
            });
            return response.end(file.data);
          }
          if (request.method === "GET") {
            return json(response, 200, fileStore.get(adapter, id));
          }
          if (request.method === "DELETE" && !filePath[2]) {
            return json(response, 200, await fileStore.delete(adapter, id));
          }
        }
        return json(response, 404, { error: { message: "Not found" } });
      } catch (error) {
        logInfo.error = error instanceof Error ? error.message : String(error);
        const status = Number(record(error).status ?? 500);
        return json(response, status, {
          error: {
            message: error instanceof Error ? error.message : "Bridge failed",
            category: errorCategory(error, status)
          }
        });
      }
    }
    const isResponses =
      request.method === "POST" && url.pathname === "/v1/responses";
    const isImageGeneration =
      request.method === "POST" && url.pathname === "/v1/images/generations";
    const isImageEdit =
      request.method === "POST" && url.pathname === "/v1/images/edits";
    const isImages = isImageGeneration || isImageEdit;
    const runtime =
      adapter === "claude"
        ? { run: runClaude, ownedBy: "claude-code", imageCandidate: undefined }
        : adapter === "grok"
          ? { run: runGrok, ownedBy: "grok", imageCandidate: runGrokImage }
          : adapter === "antigravity"
            ? { run: runAntigravity, ownedBy: "google", imageCandidate: undefined }
            : { run: runCodex, ownedBy: "codex", imageCandidate: runCodexImage };
    const runTurn = guardedRunner(adapter, runtime.run);

    if (request.method === "GET" && url.pathname === "/v1/models") {
      const status = (await capabilities()).find((item) => item.id === adapter);
      return json(response, status?.available ? 200 : 503, {
        object: "list",
        data: (status?.models ?? []).map((model) => ({
          ...model,
          object: "model",
          created: 0,
          owned_by: runtime.ownedBy
        }))
      });
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/v1/model/info" || url.pathname === "/model/info")
    ) {
      const status = (await capabilities()).find((item) => item.id === adapter);
      return json(response, status?.available ? 200 : 503, {
        data: status ? liteLLMModelInfo(status) : []
      });
    }
    if (
      !isResponses &&
      !isImages &&
      (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
    ) {
      return json(response, 404, { error: { message: "Not found" } });
    }
    const mediaType = request.headers["content-type"]?.split(";", 1)[0];
    if (
      (!isImageEdit && mediaType !== "application/json") ||
      (isImageEdit && mediaType !== "multipart/form-data" && mediaType !== "application/json")
    ) {
      return json(response, 400, {
        error: {
          message: isImageEdit
            ? "Content-Type must be application/json or multipart/form-data"
            : "Content-Type must be application/json"
        }
      });
    }
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      if (isImages) {
        const capability = (await capabilities()).find((item) => item.id === adapter);
        const operation = isImageEdit ? "edit" : "generation";
        const image =
          runtime.imageCandidate &&
          capability &&
          capability.images.fingerprint.executable &&
          allowsImageRunner(adapter, capability.images[operation].status)
            ? runtime.imageCandidate
            : undefined;
        if (!image) {
          throw Object.assign(
            new Error(`${adapter} does not support this image operation.`),
            { status: 400 }
          );
        }
        const parsed = isImageEdit
          ? await parseEditRequest(request, fileStore, adapter)
          : await parseGenerationRequest(request);
        try {
          if (
            parsed.input.size &&
            !capability!.images[operation].supported_openai_params.includes("size")
          ) {
            throw Object.assign(
              new Error(`${adapter} does not support size for image ${operation}.`),
              { status: 400 }
            );
          }
          const maxImages = Number(record(
            capability!.images[operation].parameter_constraints.images
          ).max_items);
          if (
            parsed.input.imagePaths &&
            Number.isFinite(maxImages) &&
            parsed.input.imagePaths.length > maxImages
          ) {
            throw Object.assign(
              new Error(`${adapter} supports at most ${maxImages} edit image${maxImages === 1 ? "" : "s"}.`),
              { status: 400 }
            );
          }
          logInfo.model = parsed.input.model;
          logInfo.imageOperation = isImageEdit ? "edit" : "generation";
          await pipe(
            imageResponse(await image(parsed.input, { signal: controller.signal })),
            response
          );
          markImageSupported(capability, operation);
        } finally {
          await parsed.cleanup();
        }
        return;
      }
      if (isResponses) {
        const parsed = responsesRequestSchema.safeParse(await body(request));
        if (!parsed.success) {
          throw Object.assign(new Error(z.prettifyError(parsed.error)), {
            status: 400
          });
        }
        logInfo.model = parsed.data.model;
        logInfo.stream = Boolean(parsed.data.stream);
        const adapterCapability = (await capabilities()).find(
          (item) => item.id === adapter
        );
        if (!adapterCapability) throw new Error(`${adapter} capability unavailable.`);
        await materializeResponseFileIds(parsed.data, fileStore, adapter);
        const usesImage = parsed.data.tools?.some(
          (tool) => tool.type === "image_generation"
        ) ?? false;
        const chatInput = usesImage ? undefined : toChatRequest(parsed.data);
        if (chatInput) validateInputs(chatInput, adapterCapability);
        const capability = usesImage ? adapterCapability : undefined;
        const image =
          usesImage &&
          runtime.imageCandidate &&
          capability &&
          capability.images.fingerprint.executable &&
          allowsImageRunner(
            adapter,
            capability.images.responsesImageGeneration.status
          )
            ? runtime.imageCandidate
            : undefined;
        const imageTool = parsed.data.tools?.find(
          (tool) => tool.type === "image_generation"
        );
        if (
          imageTool?.size != null &&
          !capability?.images.responsesImageGeneration.supported_openai_params.includes("size")
        ) {
          throw Object.assign(
            new Error(`${adapter} does not support size for Responses image_generation.`),
            { status: 400 }
          );
        }
        await pipe(
          await respondResponses(
            parsed.data,
            runTurn,
            controller.signal,
            image
          ),
          response
        );
        if (!parsed.data.stream && chatInput) {
          markInputSupported(adapterCapability, chatInput);
        }
        if (usesImage) {
          markImageSupported(capability, "responsesImageGeneration");
        }
        return;
      }
      const parsed = chatRequestSchema.safeParse(await body(request));
      if (!parsed.success) {
        throw Object.assign(new Error(z.prettifyError(parsed.error)), {
          status: 400
        });
      }
      logInfo.model = parsed.data.model;
      logInfo.stream = Boolean(parsed.data.stream);
      await materializeChatFileIds(parsed.data, fileStore, adapter);
      const adapterCapability = (await capabilities()).find(
        (item) => item.id === adapter
      );
      if (!adapterCapability) throw new Error(`${adapter} capability unavailable.`);
      validateInputs(parsed.data, adapterCapability);
      await pipe(
        await respond(parsed.data, runTurn, controller.signal),
        response
      );
      if (!parsed.data.stream) markInputSupported(adapterCapability, parsed.data);
    } catch (error) {
      const classified = await classifyTurnFailure(adapter, error);
      logInfo.error = classified.message;
      if (response.headersSent) return response.end();
      const status = Number(record(classified).status ?? 500);
      json(response, status, {
        error: {
          message: classified.message,
          category: errorCategory(classified, status)
        }
      });
    }
  });

  return {
    server,
    capabilities,
    logger,
    reconnectManager: reconnect,
    connection(adapter: AdapterId, baseUrl: string) {
      return {
        providerId: "local-agent-bridge",
        modelId: "",
        url: baseUrl.replace(/\/+$/, ""),
        apiKey: tokens[adapter]
      };
    },
    async close() {
      runClaude.close();
      await reconnect.close();
      await closeCodexSessions();
      await closeGrokSessions();
      await closeAntigravitySessions();
      await fileStore.close();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
      await logger.close();
    }
  };
}

export async function listen(
  bridge = createAgentBridge({ preloadModels: true }),
  port = Number(process.env.AGENT_BRIDGE_PORT ?? 3457)
) {
  await new Promise<void>((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(port, "127.0.0.1", resolve);
  });
  return bridge;
}

function loopbackBaseUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Agent Bridge URL must be a loopback HTTP URL.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function createAgentBridgeClient(clientOptions: {
  baseUrl: string;
  controlToken: string;
  fetch?: typeof fetch;
}) {
  const baseUrl = loopbackBaseUrl(clientOptions.baseUrl);
  const fetcher = clientOptions.fetch ?? globalThis.fetch;
  const discovery = async (options: { refresh?: boolean } = {}) => {
    const response = await fetcher(
      `${baseUrl}/capabilities${options.refresh ? "?refresh=1" : ""}`,
      {
        headers: {
          authorization: `Bearer ${clientOptions.controlToken}`
        },
        signal: AbortSignal.timeout(20_000)
      }
    );
    if (!response.ok) {
      throw new Error(`Agent Bridge returned ${response.status}`);
    }
    return capabilitiesResponseSchema.parse(await response.json());
  };
  const adapters = async (options: { refresh?: boolean } = {}) =>
    (await discovery(options)).adapters;
  const control = async (path: string, init: RequestInit = {}) => {
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${clientOptions.controlToken}`
      },
      signal: AbortSignal.timeout(20_000)
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = record(record(payload).error);
      throw Object.assign(
        new Error(
          typeof error.message === "string"
            ? error.message
            : `Agent Bridge returned ${response.status}`
        ),
        { status: response.status, category: error.category }
      );
    }
    return reconnectRunSchema.parse(payload);
  };
  return {
    discovery,
    adapters,
    /**
     * Starts the adapter's own CLI sign-in. Poll `reconnectStatus` until it
     * leaves `pending`; the adapter reports `reauth_pending` in `/capabilities`
     * meanwhile.
     */
    reconnect: (adapter: AdapterId) =>
      control("/reconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter })
      }),
    reconnectStatus: (reconnectId: string) =>
      control(`/reconnect/${encodeURIComponent(reconnectId)}`),
    cancelReconnect: (reconnectId: string) =>
      control(`/reconnect/${encodeURIComponent(reconnectId)}/cancel`, {
        method: "POST"
      }),
    async connection(id: AdapterId) {
      const adapter = (await adapters()).find((item) => item.id === id);
      if (!adapter?.available) throw new Error(`${id} is unavailable.`);
      return {
        adapter,
        baseUrl: `${baseUrl}/v1`,
        apiKey: adapter.capabilityToken
      };
    }
  };
}

export type AgentBridgeClient = ReturnType<typeof createAgentBridgeClient>;

export async function startAgentBridge(options: {
  port?: number;
  controlToken?: string;
  preloadModels?: boolean;
  logger?: BridgeLogger | LoggerOptions;
} = {}) {
  const controlToken =
    options.controlToken ?? randomBytes(32).toString("base64url");
  const bridge = await listen(
    createAgentBridge({
      controlToken,
      preloadModels: options.preloadModels ?? true,
      logger: options.logger
    }),
    options.port ?? 0
  );
  const address = bridge.server.address();
  if (!address || typeof address === "string") {
    await bridge.close();
    throw new Error("Agent Bridge returned no TCP address.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    ...bridge,
    baseUrl,
    ...createAgentBridgeClient({ baseUrl, controlToken })
  };
}
