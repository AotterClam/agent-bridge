import { createHmac } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import {
  createClaudeHandler,
  discoverClaudeModels
} from "./claude-bridge.mjs";
import { closeCodexSessions, detectCodex, runCodex } from "./codex.js";
import { chatRequestSchema, respond } from "./protocol.js";

export type AdapterId = "claude" | "codex";
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

const MAX_BODY = 2 * 1024 * 1024;

function capabilityToken(controlToken: string, adapter: AdapterId) {
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

export function createAgentBridge(
  options: { controlToken?: string; preloadModels?: boolean } = {}
) {
  const controlToken =
    options.controlToken ??
    process.env.AGENT_BRIDGE_CONTROL_TOKEN ??
    "local-development-only";
  const tokens = {
    claude: capabilityToken(controlToken, "claude"),
    codex: capabilityToken(controlToken, "codex")
  };
  const claude = createClaudeHandler({
    token: tokens.claude,
    preloadModels: options.preloadModels
  });
  const capabilities = () =>
    Promise.all([detectClaude(), detectCodex()]) as Promise<
      AdapterCapability[]
    >;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/capabilities") {
      if (request.headers.authorization !== `Bearer ${controlToken}`) {
        return json(response, 401, {
          error: { message: "Invalid control token" }
        });
      }
      return json(response, 200, {
        adapters: (await capabilities()).map((adapter) => ({
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
    if (adapter === "claude") return claude(request, response);

    if (request.method === "GET" && url.pathname === "/v1/models") {
      const status = await detectCodex();
      return json(response, status.available ? 200 : 503, {
        object: "list",
        data: status.models.map((model) => ({
          ...model,
          object: "model",
          created: 0,
          owned_by: "codex"
        }))
      });
    }
    if (
      request.method !== "POST" ||
      url.pathname !== "/v1/chat/completions"
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
      const input = chatRequestSchema.parse(await body(request));
      await pipe(await respond(input, runCodex, controller.signal), response);
    } catch (error) {
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
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
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
