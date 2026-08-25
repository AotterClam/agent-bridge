import { createHmac, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import {
  createClaudeHandler,
  discoverClaudeModels,
  runClaudeTurn,
  streamEventDelta
} from "./claude-bridge.mjs";
import { closeCodexSessions, detectCodex, runCodex } from "./codex.js";
import { closeGrokSessions, detectGrok, runGrok } from "./grok.js";
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
import { respondResponses, responsesRequestSchema } from "./responses.js";
import { z } from "zod";

export type AdapterId = "claude" | "codex" | "grok" | "antigravity";
export type AdapterCapability = {
  id: AdapterId;
  name: string;
  available: boolean;
  version: string | null;
  error: string | null;
  models: Array<{
    id: string;
    name: string;
    reasoningEfforts: readonly string[];
    defaultReasoningEffort?: string;
  }>;
};
export type AgentBridgeAdapter = AdapterCapability & {
  capabilityToken: string;
};

const capabilitiesResponseSchema = z.object({
  adapters: z.array(z.object({
    id: z.enum(["claude", "codex", "grok", "antigravity"]),
    name: z.string(),
    available: z.boolean(),
    version: z.string().nullable(),
    error: z.string().nullable(),
    capabilityToken: z.string().min(1),
    models: z.array(z.object({
      id: z.string(),
      name: z.string(),
      reasoningEfforts: z.array(z.string()),
      defaultReasoningEffort: z.string().optional()
    }))
  }))
});

const MAX_BODY = 2 * 1024 * 1024;

export function capabilityToken(controlToken: string, adapter: AdapterId) {
  return createHmac("sha256", controlToken)
    .update(adapter)
    .digest("base64url");
}

async function detectClaude(): Promise<AdapterCapability> {
  try {
    const models = await discoverClaudeModels();
    return {
      id: "claude",
      name: "Claude Code",
      available: models.length > 0,
      version: null,
      error: models.length ? null : "Claude Agent SDK returned no models.",
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
      models: []
    };
  }
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
      throw Object.assign(new Error("Request exceeds 2 MiB"), { status: 413 });
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

// The Claude lane keeps its own chat/completions handler; this adapts its
// single-turn runner to the shared ChatRunner contract for /v1/responses.
const runClaude: ChatRunner = async (input, options) => {
  const toolCallIndexes = new Map<number, number>();
  const turn = await runClaudeTurn(input, {
    signal: options?.signal,
    onEvent(event: unknown) {
      const delta = streamEventDelta(event, toolCallIndexes) as
        | ChatDelta
        | undefined;
      if (delta) options?.onDelta?.(delta);
    }
  });
  return {
    content: turn.content,
    toolCalls: turn.toolCalls.map(
      (call: {
        id: string;
        function: { name: string; arguments: string };
      }) => ({
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments || "{}") as Record<
          string,
          unknown
        >
      })
    ),
    finishReason: turn.finishReason as ChatTurn["finishReason"]
  };
};

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
};

export function createAgentBridge(options: AgentBridgeOptions = {}) {
  const logger: BridgeLogger =
    options.logger && "debug" in options.logger
      ? options.logger
      : createLogger(options.logger);

  const controlToken =
    options.controlToken ??
    process.env.AGENT_BRIDGE_CONTROL_TOKEN ??
    "local-development-only";
  const tokens = {
    claude: capabilityToken(controlToken, "claude"),
    codex: capabilityToken(controlToken, "codex"),
    grok: capabilityToken(controlToken, "grok"),
    antigravity: capabilityToken(controlToken, "antigravity")
  };
  let capabilitiesPromise: Promise<AdapterCapability[]> | undefined;
  const capabilities = (refresh = false) => {
    if (refresh) capabilitiesPromise = undefined;
    return capabilitiesPromise ??= Promise.all([
      detectClaude(),
      detectCodex(),
      detectGrok(),
      detectAntigravity()
    ]);
  };
  const claude = createClaudeHandler({
    token: tokens.claude,
    listModels: async () =>
      (await capabilities()).find((adapter) => adapter.id === "claude")?.models ?? []
  });
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
          error: { message: "Invalid control token" }
        });
      }
      return json(response, 200, {
        adapters: (await capabilities(
          url.searchParams.get("refresh") === "1"
        )).map((adapter) => ({
          ...adapter,
          capabilityToken: tokens[adapter.id]
        }))
      });
    }

    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const adapter = (Object.entries(tokens) as Array<[AdapterId, string]>).find(
      ([, value]) => value === bearer
    )?.[0];
    if (!adapter) {
      return json(response, 401, { error: { message: "Invalid API key" } });
    }
    logInfo.adapter = adapter;
    const isResponses =
      request.method === "POST" && url.pathname === "/v1/responses";
    if (adapter === "claude" && !isResponses) {
      return claude(request, response);
    }
    const runtime =
      adapter === "grok"
        ? { run: runGrok, ownedBy: "grok" }
        : adapter === "antigravity"
          ? { run: runAntigravity, ownedBy: "google" }
          : { run: runCodex, ownedBy: "codex" };

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
      !isResponses &&
      (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
    ) {
      return json(response, 404, { error: { message: "Not found" } });
    }
    if (
      request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
    ) {
      return json(response, 400, {
        error: { message: "Content-Type must be application/json" }
      });
    }
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      if (isResponses) {
        const parsed = responsesRequestSchema.safeParse(await body(request));
        if (!parsed.success) {
          throw Object.assign(new Error(z.prettifyError(parsed.error)), {
            status: 400
          });
        }
        logInfo.model = parsed.data.model;
        logInfo.stream = Boolean(parsed.data.stream);
        const runner = adapter === "claude" ? runClaude : runtime.run;
        await pipe(
          await respondResponses(parsed.data, runner, controller.signal),
          response
        );
        return;
      }
      const input = chatRequestSchema.parse(await body(request));
      logInfo.model = input.model;
      logInfo.stream = Boolean(input.stream);
      await pipe(await respond(input, runtime.run, controller.signal), response);
    } catch (error) {
      logInfo.error = error instanceof Error ? error.message : String(error);
      if (response.headersSent) return response.end();
      const status = Number(record(error).status ?? 500);
      json(response, status, {
        error: {
          message: error instanceof Error ? error.message : "Bridge failed"
        }
      });
    }
  });

  return {
    server,
    capabilities,
    logger,
    connection(adapter: AdapterId, baseUrl: string) {
      return {
        providerId: "local-agent-bridge",
        modelId: "",
        url: baseUrl.replace(/\/+$/, ""),
        apiKey: tokens[adapter]
      };
    },
    async close() {
      claude.close();
      await closeCodexSessions();
      await closeGrokSessions();
      await closeAntigravitySessions();
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
  const adapters = async (options: { refresh?: boolean } = {}) => {
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
    return capabilitiesResponseSchema.parse(await response.json()).adapters;
  };
  return {
    adapters,
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
